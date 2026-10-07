#!/usr/bin/env node
/**
 * Link this repository's dev `node_modules/@deepseek-ai` to the installed dsh
 * closure's `@deepseek-ai` package set, so `node --test` resolves the exact
 * peers the running dsh resolves at plugin load. No network access required.
 *
 * Usage: `npm run peers` (or `npm run test:local`, which runs this first).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const linkPath = join(repoRoot, 'node_modules', '@deepseek-ai')

/** Resolve `dsh` on PATH without throwing when it is absent. */
function dshBin() {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(finder, ['dsh'], { encoding: 'utf8' }).trim().split('\n')[0]
  } catch {
    return undefined
  }
}

/** Candidate `@deepseek-ai` package directories for one dsh package root. */
function peerCandidates(root) {
  return [
    join(root, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
    dirname(root),
    join(root, 'node_modules/@deepseek-ai'),
    join(root, 'lib/node_modules/@deepseek-ai'),
  ]
}

/** True when a directory actually holds the peer set this plugin imports. */
function isPeerDir(candidate) {
  return existsSync(join(candidate, 'dsh-tools'))
    && existsSync(join(candidate, 'dsh-llm'))
    && existsSync(join(candidate, 'schemastery'))
}

/** The installed dsh package root, including symlink-join wrappers on Nix. */
function dshPackageRoot() {
  const bin = dshBin()
  if (bin === undefined) return undefined
  const real = realpathSync(bin)
  const roots = [dirname(dirname(real))]
  try {
    const wrapper = readFileSync(real, 'utf8')
    for (const match of wrapper.matchAll(/\/nix\/store\/[a-z0-9]+-dsh-[^/\s"']+/g)) {
      roots.unshift(match[0])
    }
  } catch {
    // Not a readable wrapper; the derived root above still covers npm layouts.
  }
  for (const root of roots) {
    for (const candidate of peerCandidates(root)) {
      if (isPeerDir(candidate)) return candidate
    }
  }
  return undefined
}

const peers = dshPackageRoot()
if (peers === undefined) {
  console.error('link-dsh-peers: could not locate an installed dsh peer set.')
  console.error('Install/enter dsh first, or create node_modules/@deepseek-ai by hand.')
  process.exit(1)
}

rmSync(linkPath, { recursive: true, force: true })
mkdirSync(dirname(linkPath), { recursive: true })
symlinkSync(peers, linkPath, 'dir')
console.log(`link-dsh-peers: ${linkPath} -> ${peers}`)
