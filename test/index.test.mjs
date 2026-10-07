import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, Config, inject, name } from '../index.mjs'

/** A mock Cordis context with just the seams `apply` touches at load. */
function createCtx() {
  const state = { tools: [], sections: [] }
  const ctx = {
    get: () => undefined,
    tools: {
      register(tool) {
        state.tools.push(tool)
      },
    },
    systemPrompt: {
      section(section) {
        state.sections.push(section)
      },
      getSectionOrder: () => 1000,
    },
  }
  return { ctx, state }
}

test('the plugin mounts the tool and one prompt section', () => {
  const { ctx, state } = createCtx()
  apply(ctx, {})
  assert.equal(name, 'tool-viewport')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  assert.equal(state.tools.length, 1)
  assert.equal(state.tools[0].name, 'viewport')
  assert.match(state.tools[0].description, /^See and drive the Viewport desktop/)
  assert.equal(state.sections.length, 1)
  assert.equal(state.sections[0].name, 'tool:viewport')
  assert.match(state.sections[0].text, /viewport/)
})

test('the config schema defaults everything but the overrides', () => {
  const resolved = Config({})
  assert.equal(resolved.executable, 'viewport')
  assert.equal(resolved.grim, 'grim')
  assert.equal(resolved.timeoutMs, 10000)
  assert.equal(resolved.socket, undefined)
  assert.equal(resolved.runtimeDir, undefined)
  assert.equal(resolved.waylandDisplay, undefined)
  assert.equal(resolved.screenshotDir, undefined)
})

test('a broken configuration is refused at load', () => {
  assert.throws(() => apply(createCtx().ctx, { executable: ' ' }), /executable must be a non-empty string/)
  assert.throws(() => apply(createCtx().ctx, { grim: '' }), /grim must be a non-empty string/)
  assert.throws(() => apply(createCtx().ctx, { timeoutMs: 0 }), /timeoutMs must be a positive number/)
})
