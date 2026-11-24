import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTIONS, mountViewportTool, validateViewportArgs, viewportDescription } from '../src/tool.mjs'
import { releaseSummary } from '../src/render.mjs'

const SIGNAL = new AbortController().signal
const EXEC = { callId: 'call-1', signal: SIGNAL }

/** A mock Cordis context with the two seams the tool touches. */
function createCtx() {
  const state = { tool: undefined }
  const ctx = {
    get: () => undefined,
    tools: {
      register(tool) {
        state.tool = tool
      },
    },
  }
  return { ctx, state }
}

/** Mount the tool against a seat stub that records the release call. */
function mount(result) {
  const calls = []
  const seat = {
    async run() {
      throw new Error('release must not run a message list through run()')
    },
    async releaseAll(signal) {
      calls.push({ signal })
      return result
    },
  }
  const { ctx } = createCtx()
  const tool = mountViewportTool(ctx, {
    seat,
    capture: async () => {
      throw new Error('release must not capture')
    },
  })
  return { tool, calls }
}

/** A release report with nothing known to be held. */
const EMPTY_REPORT = {
  known: [],
  released: [
    { kind: 'key', id: 0xffe3 },
    { kind: 'key', id: 0xffe9 },
    { kind: 'key', id: 0xffe1 },
    { kind: 'key', id: 0xffeb },
    { kind: 'button', id: 272 },
    { kind: 'button', id: 273 },
    { kind: 'button', id: 274 },
  ],
  failed: [],
}

test('release is an action in the schema, the description and the validation', () => {
  assert.ok(ACTIONS.includes('release'))
  assert.match(viewportDescription(), /`release` lets go of every key and button/)
  const { tool } = mount(EMPTY_REPORT)
  assert.ok(tool.parameters.properties.action.enum.includes('release'))
  assert.doesNotThrow(() => validateViewportArgs({ action: 'release' }))
  // It takes no fields; a model that sends coordinates anyway is not punished,
  // they simply mean nothing.
  assert.doesNotThrow(() => validateViewportArgs({ action: 'release', x: 1, y: 2, button: 'left' }))
})

test('release calls the seat once, with the call signal, and summarizes the sweep', async () => {
  const { tool, calls } = mount(EMPTY_REPORT)
  const value = await tool.execute({ action: 'release' }, EXEC)
  assert.equal(value.action, 'release')
  assert.equal(
    value.summary,
    'Nothing was known to be held; released every key and button the plugin can leave held (ctrl, alt, shift, super, left button, right button and middle button) as a safety net.',
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal, SIGNAL)
  assert.deepEqual(tool.output.render({ action: 'release' }, value), [{ type: 'text', text: value.summary }])
})

test('release names what the ledger knew and says what is left held', () => {
  const summary = releaseSummary({
    known: [{ kind: 'key', id: 0xffe3 }, { kind: 'key', id: 0xffe1 }],
    released: [{ kind: 'key', id: 0xffe3 }, { kind: 'key', id: 0xffe1 }],
    failed: [],
  })
  assert.equal(summary, 'Released ctrl and shift (and swept the standard modifier and button set); nothing is left held.')
})

test('a failed release is reported rather than thrown, and the input is named', () => {
  const partial = releaseSummary({
    known: [{ kind: 'key', id: 0xffe3 }],
    released: [{ kind: 'button', id: 274 }],
    failed: [{ input: { kind: 'key', id: 0xffe3 }, reason: 'the socket is gone' }],
  })
  assert.equal(
    partial,
    'Released middle button; could not release ctrl (the socket is gone); it may still be held.',
  )
  const none = releaseSummary({
    known: [{ kind: 'button', id: 272 }],
    released: [],
    failed: [{ input: { kind: 'button', id: 272 }, reason: 'no answer within 2000ms' }],
  })
  assert.equal(none, 'Could not release left button (no answer within 2000ms); it may still be held.')
})

test('an aborted call never reaches the release sweep', async () => {
  const { tool, calls } = mount(EMPTY_REPORT)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ action: 'release' }, { ...EXEC, signal: controller.signal }), (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
  assert.equal(calls.length, 0)
})

test('presentCall titles the release plainly', () => {
  const { tool } = mount(EMPTY_REPORT)
  assert.deepEqual(tool.presentCall({ action: 'release' }), {
    card: 'generic',
    title: 'Release every held key and button',
    kind: 'execute',
  })
})
