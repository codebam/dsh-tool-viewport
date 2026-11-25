/**
 * The cross-process input lease: one advisory lock per control socket.
 *
 * The seat's FIFO serializes the calls of one dsh process, and its ledger
 * knows the presses of one dsh process. Neither reaches a second process
 * driving the same compositor: without something shared, one process can put
 * a click's press and release either side of another process's typing, and a
 * process that dies with a key down leaves nobody able to notice. This module
 * is that something shared — a lease attached to the socket both processes
 * talk to, taken for the duration of one run and given back when the run
 * settles.
 *
 * The lease is a file published with an atomic hard link where the filesystem
 * supports one, so a reader sees nothing or a complete record; elsewhere an
 * exclusive create is used and the writer verifies afterwards that the path
 * still names the inode it wrote. It carries the owner's pid *and its process
 * start time* (`/proc/<pid>/stat` field 22), because Linux reuses pids: a pid
 * on its own cannot tell a live holder from a later process that inherited
 * the number. It also carries the boot id and PID namespace, because a pid
 * means something else outside them. A lock is reclaimed only when the
 * identity it records is provably gone — the pid is gone, the pid now belongs
 * to a process with a different start time, or the recorded process is a
 * zombie and will never release it — and never when the record came from
 * another boot, namespace or plugin version whose owner may still be alive.
 * Garbled files are reclaimed after a short grace; a writer that lost such a
 * race detects it after writing and does not believe it holds the lease.
 *
 * Reclamation is serialized by a guard file and re-checks the record's token
 * immediately before removing it, so two processes that both decide a holder
 * is dead do not both become the holder. Every wait is bounded and interruptible
 * by the call's abort signal: a lease that cannot be taken produces a clear
 * error rather than a deadlock, and the next call tries again.
 *
 * Nothing here adds a runtime dependency. It is Linux-shaped (procfs) but
 * degrades safely elsewhere: when a process identity cannot be read, the
 * holder is treated as alive and the caller waits out its bound instead of
 * stealing the lease.
 *
 * @module @codebam/dsh-tool-viewport/lease
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readFile, readlink, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** How long an input call waits for another process's lease by default. */
export const DEFAULT_LEASE_WAIT_MS = 30_000

/** The record format this module writes and understands. */
const LEASE_VERSION = 1

/** How long a garbled lease file is left alone before it may be reclaimed. */
const GARBLED_GRACE_MS = 1000

/** Reclamation polling starts here and backs off to `POLL_MAX_MS`. */
const POLL_MIN_MS = 5
const POLL_MAX_MS = 40

/** An input-lease failure worth showing the model as it is. */
export class LeaseError extends Error {
  /**
   * @param {string} message - the sentence the model reads.
   * @param {object} [details] - machine-readable context.
   * @param {string} [details.leasePath] - the lock file involved.
   * @param {{ pid: number, start: number | null } | undefined} [details.holder] - the recorded owner, when it could be parsed.
   * @param {number} [details.waitedMs] - how long the call waited.
   */
  constructor(message, { leasePath, holder, waitedMs } = {}) {
    super(message)
    this.name = 'LeaseError'
    this.code = 'VIEWPORT_LEASE_BUSY'
    if (leasePath !== undefined) this.leasePath = leasePath
    if (holder !== undefined) this.holder = holder
    if (waitedMs !== undefined) this.waitedMs = waitedMs
  }
}

/** The shape of the abort every wait reports; the seat maps it to its own `abortError()`. */
function abortedError() {
  const error = new Error('tool call aborted while waiting for the input lease')
  error.name = 'AbortError'
  return error
}

/** A non-empty string or undefined. */
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The user id this process runs as, for a per-user private lease directory. */
function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

/**
 * Parse the fields this module needs out of `/proc/<pid>/stat`.
 *
 * `comm` is parenthesised and may contain spaces and `)`, so the record is
 * split after its final `)` rather than treated as whitespace fields. From
 * there field 3 is `state`, so field 22 (`starttime`) is index 19.
 * @param {unknown} record - the file's text.
 * @returns {{ state: string, parent: number | undefined, start: number } | undefined} the fields, or undefined when unparseable.
 */
export function parseProcessStat(record) {
  if (typeof record !== 'string') return undefined
  const close = record.lastIndexOf(')')
  if (close === -1) return undefined
  const fields = record.slice(close + 1).trim().split(/\s+/)
  if (fields.length < 20) return undefined
  const start = Number(fields[19])
  if (!Number.isInteger(start) || start < 0) return undefined
  const parent = Number(fields[1])
  return {
    state: fields[0],
    parent: Number.isInteger(parent) ? parent : undefined,
    start,
  }
}

/** Whether procfs is usable here; only asked when a pid read says "gone". */
let procfs = undefined
function procfsAvailable() {
  procfs ??= readFile('/proc/self/stat', 'utf8').then(
    () => true,
    () => false,
  )
  return procfs
}

/**
 * What `/proc` says about one process.
 *
 * A missing pid is dead; a pid whose stat cannot be read (permissions,
 * hidepid) is *unknown*, never dead, because stealing a live holder's lease
 * is worse than waiting. The start time identifies the incarnation, so a
 * reused pid is reported as alive with a different start and the caller
 * treats the recorded holder as gone.
 * @param {number} pid - the process to look up.
 * @returns {Promise<{ status: 'alive', start: number, state: string } | { status: 'dead' } | { status: 'unknown', reason: string }>} the answer.
 */
export async function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: 'unknown', reason: 'the recorded pid is not a process id' }
  }
  let record
  try {
    record = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if ((error.code === 'ENOENT' || error.code === 'ESRCH') && (await procfsAvailable())) {
      return { status: 'dead' }
    }
    return { status: 'unknown', reason: error.code ?? error.message }
  }
  const parsed = parseProcessStat(record)
  if (parsed === undefined) return { status: 'unknown', reason: 'its procfs entry could not be parsed' }
  return { status: 'alive', start: parsed.start, state: parsed.state }
}

/**
 * Whether a parsed lease record's owner is still the process it names.
 * A zombie cannot release a lease, so it counts as gone even though its
 * procfs entry (and therefore its pid) still exists.
 * @param {{ pid: number, start: number | null }} record - the owner to check.
 * @returns {Promise<'dead' | 'alive' | 'unknown'>} the classification.
 */
export async function classifyHolder(record) {
  // A record from another boot or PID namespace names a pid that means
  // something else here. Its holder cannot be proven dead, so it is never
  // reclaimed by this process.
  const source = await currentIdentitySource()
  if (record.boot !== undefined && source?.boot !== undefined && record.boot !== source.boot) return 'unknown'
  if (
    record.pidNamespace !== undefined
    && source?.pidNamespace !== undefined
    && record.pidNamespace !== source.pidNamespace
  ) {
    return 'unknown'
  }
  const identity = await readProcessIdentity(record.pid)
  if (identity.status === 'dead') return 'dead'
  if (identity.status === 'unknown') return 'unknown'
  // With no recorded start time (a platform without procfs) the live pid is
  // the only evidence there is; refuse to call it dead.
  if (record.start === null || record.start === undefined) return 'alive'
  if (identity.start !== record.start) return 'dead'
  if (identity.state === 'Z' || identity.state === 'X' || identity.state === 'x') return 'dead'
  return 'alive'
}

/** The owner identity in a record, whoever wrote it: enough to ask procfs whether that incarnation is alive. */
function recordIdentity(value) {
  if (value === null || typeof value !== 'object') return undefined
  if (!Number.isInteger(value.pid) || value.pid <= 0) return undefined
  if (!(value.start === null || (Number.isInteger(value.start) && value.start >= 0))) return undefined
  const identity = { pid: value.pid, start: value.start }
  // Carried through so a foreign-version holder from another boot or PID
  // namespace is still recognisably not comparable.
  if (typeof value.boot === 'string' && value.boot.length > 0) identity.boot = value.boot
  if (typeof value.pidNamespace === 'string' && value.pidNamespace.length > 0) identity.pidNamespace = value.pidNamespace
  return identity
}

/** A record this module wrote: complete enough to reason about, or a released tombstone. */
function isRecord(value) {
  return value !== null
    && typeof value === 'object'
    && value.version === LEASE_VERSION
    && typeof value.token === 'string'
    && value.token.length > 0
    && Number.isInteger(value.pid)
    && value.pid > 0
    && (value.start === null || (Number.isInteger(value.start) && value.start >= 0))
}

/**
 * The boot and PID namespace this process's `/proc` numbers belong to. A pid
 * and start time are only comparable inside one namespace and one boot, so
 * the record carries both and a holder from elsewhere is never called dead.
 */
let identitySource
async function currentIdentitySource() {
  identitySource ??= (async () => {
    const source = {}
    try {
      source.boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    } catch {
      // No procfs boot id: identity comparisons fall back to pid and start.
    }
    try {
      source.pidNamespace = await readlink('/proc/self/ns/pid')
    } catch {
      // Same for a kernel without namespace links.
    }
    return Object.keys(source).length === 0 ? undefined : source
  })()
  return identitySource
}

/** The identity of this process, as the record describes it. */
async function selfIdentity() {
  const identity = await readProcessIdentity(process.pid)
  const source = await currentIdentitySource()
  return {
    pid: process.pid,
    start: identity.status === 'alive' ? identity.start : null,
    ...source,
  }
}

/** Canonical spelling of a target path, so two spellings of one socket share a lease. */
async function canonicalPath(path) {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch {
    return absolute
  }
}

/**
 * Whether a path is the kind of socket the client will actually pick from
 * `$XDG_RUNTIME_DIR/viewport-<display>.sock`: a socket, owned by this user,
 * closed to everyone else. A symlink is refused, exactly as the client
 * refuses it.
 */
async function isPrivateSocket(path) {
  try {
    const meta = await lstat(path)
    return meta.isSocket() && meta.uid === currentUid() && (meta.mode & 0o777) === 0o600
  } catch {
    return false
  }
}

/**
 * Create (or verify) the directory the lease files live in.
 *
 * The default is a per-user directory under the system temp dir rather than
 * the session's runtime dir or the socket's own directory. Two reasons: the
 * runtime dir belongs to the live session (and to a human's session at that),
 * and a socket directory is not guaranteed writable. The file *name* still
 * comes from the canonical target, so the lease stays per-socket; the
 * directory only has to be one every dsh process for this user agrees on,
 * which `leaseDir` pins when `TMPDIR` differs between them.
 * @param {string | undefined} explicit - a configured directory, used as given.
 * @returns {Promise<string>} the directory.
 */
async function leaseDirectory(explicit) {
  const uid = currentUid()
  const directory = explicit === undefined
    ? join(tmpdir(), `dsh-tool-viewport-leases-${uid ?? 'user'}`)
    : resolve(explicit)
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new LeaseError(
      `cannot use the input lease directory ${directory} (${error.code ?? error.message}); every dsh process driving this session needs a writable, private directory — set the plugin's \`leaseDir\``,
      { leasePath: directory },
    )
  }
  let meta
  try {
    meta = await lstat(directory)
  } catch (error) {
    throw new LeaseError(`cannot inspect the input lease directory ${directory} (${error.code ?? error.message})`, { leasePath: directory })
  }
  if (!meta.isDirectory()) {
    throw new LeaseError(`the input lease path ${directory} is not a directory; set the plugin's \`leaseDir\``, { leasePath: directory })
  }
  if (uid !== undefined && meta.uid !== uid) {
    throw new LeaseError(
      `the input lease directory ${directory} belongs to uid ${meta.uid}, not ${uid}; set the plugin's \`leaseDir\` to a directory of your own`,
      { leasePath: directory },
    )
  }
  if ((meta.mode & 0o777) !== 0o700) {
    try {
      // Also repairs a directory created under an unusual umask.
      await chmod(directory, 0o700)
    } catch {
      // A group- or world-writable directory lets another user replace the
      // lease files, which would break exclusion; refuse it. A merely
      // readable one leaks pid numbers, not input.
      if ((meta.mode & 0o022) !== 0) {
        throw new LeaseError(
          `the input lease directory ${directory} is writable by other users (mode ${(meta.mode & 0o777).toString(8)}); set the plugin's \`leaseDir\` to a private directory`,
          { leasePath: directory },
        )
      }
    }
  }
  return directory
}

/**
 * Resolve the lease for one seat's target.
 *
 * The scope key is the canonical control socket when the seat (or its
 * environment) names one. Otherwise the client will discover the session
 * itself, so the key is the session's runtime dir — deliberately broader, so
 * that two unpinned seats in one session still serialize even though they
 * cannot say which socket the client will choose. A seat that pins a socket
 * and a seat that does not cannot share a key; that is stated in
 * `docs/input-safety.md`, and pinning `socket` (or exporting
 * `VIEWPORT_SOCKET`) is the way to join the same lease from both.
 * @param {object} [options] - the seat's target.
 * @param {string} [options.socket] - explicit control socket.
 * @param {string} [options.runtimeDir] - runtime dir override.
 * @param {string} [options.waylandDisplay] - Wayland display override.
 * @param {string} [options.leaseDir] - lease directory override.
 * @param {NodeJS.ProcessEnv} [options.env] - environment the client will see.
 * @returns {Promise<{ key: string, hash: string, label: string, directory: string, path: string }>} where the lease lives and what it names.
 */
export async function resolveLeaseTarget({ socket, runtimeDir, waylandDisplay, leaseDir, env = process.env } = {}) {
  const explicitSocket = text(socket) ?? text(env.VIEWPORT_SOCKET)
  const runtime = text(runtimeDir) ?? text(env.XDG_RUNTIME_DIR)
  const display = text(waylandDisplay) ?? text(env.WAYLAND_DISPLAY)
  let key
  let label
  if (explicitSocket !== undefined) {
    const path = await canonicalPath(explicitSocket)
    key = `socket:${path}`
    label = `the control socket ${path}`
  } else if (runtime !== undefined) {
    const canonRuntime = await canonicalPath(runtime)
    const named = display === undefined ? undefined : join(canonRuntime, `viewport-${display}.sock`)
    if (named !== undefined && (await isPrivateSocket(named))) {
      key = `socket:${named}`
      label = `the control socket ${named}`
    } else {
      key = `session:${canonRuntime}`
      label = `the Viewport session in ${canonRuntime} (the client picks the socket itself)`
    }
  } else {
    key = 'session:undiscoverable'
    label = 'the session the client would discover'
  }
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32)
  const directory = await leaseDirectory(text(leaseDir))
  return { key, hash, label, directory, path: join(directory, `lease-${hash}.lock`) }
}

/**
 * Publish `record` at `path` atomically without ever exposing a partial file.
 * The record is written to a unique temporary file in the same directory and
 * hard-linked into place: `link` fails with `EEXIST` when the lease is held,
 * and a reader sees either nothing or a complete record. A filesystem without
 * hard links falls back to an exclusive create.
 * @param {string} path - the lock file.
 * @param {string} record - the complete record text.
 * @returns {Promise<boolean>} true when this process published it, false when it was held.
 */
async function publishExclusive(path, record) {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, record, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    throw new LeaseError(`cannot write in the input lease directory ${directory} (${error.code ?? error.message})`, { leasePath: path })
  }
  try {
    await link(temporary, path)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    if (error.code === 'EPERM' || error.code === 'ENOTSUP' || error.code === 'EOPNOTSUPP' || error.code === 'ENOSYS' || error.code === 'EMLINK') {
      return publishDirect(path, record)
    }
    throw new LeaseError(`cannot publish the input lease ${path} (${error.code ?? error.message})`, { leasePath: path })
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/**
 * Publish by exclusive create, for a filesystem that cannot hard-link.
 *
 * The create is atomic, but the content becomes visible before it is written,
 * so another process could see a garbled file and reclaim it after the grace.
 * This checks after writing that the path still names the inode the handle
 * wrote; if it does not, the lease was reclaimed under this writer, and the
 * caller loses the race rather than believing it holds the lease.
 * @param {string} path - the lock file.
 * @param {string} record - the complete record text.
 * @returns {Promise<boolean>} true when the path still names this writer's file.
 */
async function publishDirect(path, record) {
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw new LeaseError(`cannot publish the input lease ${path} (${error.code ?? error.message})`, { leasePath: path })
  }
  let written
  try {
    written = await handle.stat()
    await handle.writeFile(record)
    // A reclaimer can remove the empty-to-be file after the grace. Comparing
    // the content (which carries this writer's random token) is stronger than
    // comparing inodes, which a filesystem may reuse for a new holder.
    let current
    try {
      current = await readFile(path, 'utf8')
    } catch {
      return false
    }
    return current === record
  } catch (error) {
    if (written !== undefined) {
      // Do not leave a zero-length lock behind for a failed write.
      try {
        const current = await stat(path)
        if (current.dev === written.dev && current.ino === written.ino) await unlink(path)
      } catch {
        // Already gone or replaced.
      }
    }
    throw new LeaseError(`cannot write the input lease ${path} (${error.code ?? error.message})`, { leasePath: path })
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Read one lock file into a shape the acquisition loop can reason about.
 * @param {string} path - the lock file.
 * @returns {Promise<object>} `missing`, `garbled`, `unreadable` or `record`.
 */
async function readSnapshot(path) {
  let meta
  try {
    meta = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing', path }
    return { kind: 'unreadable', path, text: undefined, reason: error.code ?? error.message }
  }
  // A planted FIFO or another special file would make `readFile` block, and
  // no legitimate writer creates one; treat it as a garbled file.
  if (!meta.isFile()) return { kind: 'garbled', path, text: '', mtimeMs: meta.mtimeMs }
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing', path }
    return { kind: 'unreadable', path, text: undefined, reason: error.code ?? error.message }
  }
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    parsed = undefined
  }
  if (isRecord(parsed)) return { kind: 'record', path, text: content, record: parsed }
  const identity = recordIdentity(parsed)
  if (identity !== undefined) {
    // A record from a future (or older) version of this plugin. Its owner is
    // still classified by identity, so a live holder is never stolen just
    // because this version does not understand the rest of the record.
    return {
      kind: 'foreign',
      path,
      text: content,
      record: { ...identity, released: parsed.released === true },
    }
  }
  return { kind: 'garbled', path, text: content, mtimeMs: meta.mtimeMs }
}

/** Whether a snapshot may be removed without ever having been a live holder. */
async function reclaimable(snapshot) {
  if (snapshot.kind === 'record' || snapshot.kind === 'foreign') {
    if (snapshot.record.released === true) return true
    return (await classifyHolder(snapshot.record)) === 'dead'
  }
  if (snapshot.kind === 'garbled') return Date.now() - snapshot.mtimeMs >= GARBLED_GRACE_MS
  return false
}

/** Remove a file only while its content is still exactly what was inspected. */
async function removeIfUnchanged(path, expected) {
  // A non-regular file (a planted FIFO, say) has no content to compare and
  // must not be read; it is never a lock this module published, so removing
  // it is safe.
  let meta
  try {
    meta = await lstat(path)
  } catch (error) {
    return error.code === 'ENOENT'
  }
  if (!meta.isFile()) {
    try {
      await unlink(path)
      return true
    } catch (error) {
      return error.code === 'ENOENT'
    }
  }
  let current
  try {
    current = await readFile(path, 'utf8')
  } catch (error) {
    return error.code === 'ENOENT'
  }
  if (current !== expected) return false
  try {
    await unlink(path)
    return true
  } catch (error) {
    return error.code === 'ENOENT'
  }
}

/** Remove a guard file whose recorded owner is gone; a live guard is left alone. */
async function clearStaleGuard(path) {
  const snapshot = await readSnapshot(path)
  if (snapshot.kind === 'missing') return
  if (await reclaimable(snapshot)) await removeIfUnchanged(path, snapshot.text)
}

/**
 * Remove one reclaimable lock, serialized by a guard file and verified by the
 * record's exact content right before the unlink. The content check is what
 * keeps this safe even if two reclaimers slip past the guard: a fresh holder
 * always has a different token, so its file is never the text that was
 * inspected as dead.
 * @param {{ path: string }} target - the lease target.
 * @param {object} snapshot - the inspected lock.
 * @returns {Promise<boolean>} true when the lock is gone and may be republished.
 */
async function reclaim(target, snapshot) {
  if (snapshot.text === undefined) return false
  if (!(await reclaimable(snapshot))) return false
  const guard = `${target.path}.reclaim`
  const token = randomBytes(8).toString('hex')
  const self = await selfIdentity()
  const published = await publishExclusive(guard, `${JSON.stringify({ version: LEASE_VERSION, ...self, token })}\n`)
  if (!published) {
    await clearStaleGuard(guard)
    return false
  }
  try {
    const current = await readSnapshot(target.path)
    if (current.text !== snapshot.text || !(await reclaimable(current))) return false
    return await removeIfUnchanged(target.path, snapshot.text)
  } finally {
    await clearGuard(guard, token)
  }
}

/** Read a lock-shaped file only when it is a regular file, so a planted FIFO cannot block. */
async function readRegular(path) {
  try {
    const meta = await lstat(path)
    if (!meta.isFile()) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Remove this process's guard, and only this process's. */
async function clearGuard(path, token) {
  try {
    const content = await readRegular(path)
    if (content === undefined) return
    const parsed = JSON.parse(content)
    if (parsed?.token === token) await unlink(path)
  } catch {
    // The guard is best-effort: a leftover one is reclaimed by the next waiter.
  }
}

/** A sleep that the call's abort signal can cut short. */
function sleep(ms, signal) {
  return new Promise((done, fail) => {
    if (signal?.aborted) {
      fail(abortedError())
      return
    }
    let timer
    const finish = (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) done()
      else fail(error)
    }
    const onAbort = () => finish(abortedError())
    timer = setTimeout(() => finish(undefined), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The error a call gets when a live or unreadable holder outlasts its bound. */
function busyError(target, snapshot, waitedMs) {
  const holder = (snapshot.kind === 'record' || snapshot.kind === 'foreign') && !snapshot.record.released
    ? { pid: snapshot.record.pid, start: snapshot.record.start }
    : undefined
  let owner
  if (snapshot.kind === 'record' || snapshot.kind === 'foreign') {
    const pid = snapshot.record.pid
    const described = snapshot.record.start === null
      ? `pid ${pid}`
      : `pid ${pid} (process start ${snapshot.record.start})`
    owner = snapshot.kind === 'foreign'
      ? `a lease written by another version of this plugin, ${described}`
      : described
  } else if (snapshot.kind === 'garbled') {
    owner = 'a lease file that is not a record this plugin wrote'
  } else if (snapshot.kind === 'unreadable') {
    owner = `a lease file that could not be read (${snapshot.reason})`
  } else {
    owner = 'a lease file that kept disappearing while it was inspected'
  }
  const advice = snapshot.kind === 'record' || snapshot.kind === 'foreign'
    ? 'If that process is gone its lease is reclaimed automatically; a live holder has to release it, so do not delete a live holder\'s lease.'
    : 'Check that no dsh process is using this session, then delete the lease file.'
  return new LeaseError(
    `input is serialized per viewport socket, and ${target.label} is already being driven by another dsh process (${owner}); waited ${waitedMs}ms for ${target.path}. ${advice}`,
    { leasePath: target.path, holder, waitedMs },
  )
}

/**
 * Take the lease for one run.
 *
 * Resolves with a handle when this process is the only dsh process driving
 * the target; `release()` gives it back. A live holder is waited for up to
 * `waitMs`, then the call fails with a `LeaseError` naming the holder and the
 * file. A provably dead holder is reclaimed immediately; a garbled file after
 * `GARBLED_GRACE_MS`. The abort signal cuts any wait short and no lease is
 * taken.
 * @param {{ path: string, label?: string }} target - the target from `resolveLeaseTarget`.
 * @param {object} [options] - the acquisition's shape.
 * @param {AbortSignal} [options.signal] - the tool call's cancellation.
 * @param {number} [options.waitMs] - the bounded wait, in milliseconds.
 * @returns {Promise<{ path: string, token: string, owner: { pid: number, start: number | null }, release: () => Promise<void> }>} the held lease.
 */
export async function acquireLease(target, { signal, waitMs = DEFAULT_LEASE_WAIT_MS } = {}) {
  if (signal?.aborted) throw abortedError()
  const bound = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : DEFAULT_LEASE_WAIT_MS
  const token = randomBytes(16).toString('hex')
  const identity = await selfIdentity()
  const record = {
    version: LEASE_VERSION,
    ...identity,
    token,
    scope: target.key,
  }
  const text_ = `${JSON.stringify(record)}\n`
  const startedAt = Date.now()
  const deadline = startedAt + bound
  const waited = () => Date.now() - startedAt
  let delay = POLL_MIN_MS
  for (;;) {
    if (signal?.aborted) throw abortedError()
    if (await publishExclusive(target.path, text_)) {
      return {
        path: target.path,
        token,
        owner: { pid: identity.pid, start: identity.start },
        release: () => releaseLease(target.path, token),
      }
    }
    const snapshot = await readSnapshot(target.path)
    if (snapshot.kind === 'missing') {
      // Someone released between our publish attempt and this read. Retry
      // after a short pause, so a pathological create/remove churn cannot
      // spin the CPU, and still honour the bound.
      if (Date.now() >= deadline) throw busyError(target, snapshot, waited())
      await sleep(Math.min(POLL_MIN_MS, Math.max(0, deadline - Date.now())), signal)
      continue
    }
    if (await reclaim(target, snapshot)) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw busyError(target, snapshot, waited())
    await sleep(Math.min(delay, remaining), signal)
    delay = Math.min(Math.round(delay * 1.6), POLL_MAX_MS)
  }
}

/**
 * Give one lease back. Best-effort by design: a run's error or result must
 * never be replaced by a failure to tidy the lock file. If the file was
 * already reclaimed by someone else, this process does not touch it.
 * @param {string} path - the lock file.
 * @param {string} token - this process's token.
 */
async function releaseLease(path, token) {
  try {
    const content = await readRegular(path)
    if (content === undefined) return
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
      return
    }
    if (parsed?.token !== token) return
    try {
      await unlink(path)
    } catch (error) {
      if (error.code === 'ENOENT') return
      // A release that cannot unlink is marked as released so a later acquire
      // does not wait out a holder that no longer exists.
      try {
        await writeFile(path, `${JSON.stringify({ ...parsed, released: true })}\n`)
      } catch {
        // Nothing further can be done; the bounded lease wait is the fallback.
      }
    }
  } catch {
    // Unreadable or already gone: leave it to the next acquire.
  }
}
