import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  computeThinkingBlockDelay,
  isThinkingBlockBindingFailure,
  resolveThinkingBlockRetry,
  retryPolicyKey,
  thinkingBlockPolicyKey,
} from '../dist/index.js'

/** The exact 400 Bedrock returns for a replayed stale thinking block. */
const BINDING_MESSAGE =
  '400 {"error":{"type":"<nil>","message":"InvokeModelWithResponseStream: operation error ' +
  'Bedrock Runtime: InvokeModelWithResponseStream, https response error StatusCode: 400, ' +
  'RequestID: 9500ab52-7f62-40cb-aa20-551d45040f8c, ValidationException: messages.1.content.0: ' +
  'Invalid `signature` in `thinking` block. The block is bound to a different conversation. ' +
  'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \\"drop_block\\". ' +
  'That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` ' +
  'header. (request id: 202611020213446663075648268d9d6NfJcWvbM)"},"type":"error"}'

function bindingFailure(overrides = {}) {
  return { code: 'INVALID_REQUEST', message: BINDING_MESSAGE, ...overrides }
}

function rateLimitFailure(overrides = {}) {
  return { code: 'RATE_LIMIT', message: 'rate limited', ...overrides }
}

const providerPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 10,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.25,
})

const fastConfig = Object.freeze({
  floorMs: 1,
  maxDelayMs: 10,
  thinkingBlock: Object.freeze({ initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
})

function harness({ state = {}, config = fastConfig, retryPolicy = providerPolicy } = {}) {
  const listeners = []
  const appended = []
  const agent = { session: { append: (type, data) => appended.push({ type, data }) } }
  const ctx = {
    sessionProjections: {
      stateOf: () => state,
    },
    on: (event, listener, prepend) => {
      assert.equal(event, 'agent/request-error')
      assert.equal(prepend, true)
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
    effect: () => {},
  }
  apply(ctx, config, {})
  return { listeners, appended, agent, retryPolicy }
}

async function invoke(h, overrides = {}) {
  let downstream = 0
  const result = await h.listeners[0]({
    agent: h.agent,
    turn: 1,
    step: 1,
    provider: 'glm-anthropic',
    failure: bindingFailure(),
    retryPolicy: h.retryPolicy,
    signal: new AbortController().signal,
    ...overrides,
  }, async () => {
    downstream += 1
    return { kind: 'stop' }
  })
  return { result, downstream }
}

function thinkingStateKey(provider = 'glm-anthropic', config = fastConfig) {
  return JSON.stringify([provider, thinkingBlockPolicyKey(resolveThinkingBlockRetry(config.thinkingBlock))])
}

test('recognizes the Bedrock binding rejection', () => {
  assert.equal(isThinkingBlockBindingFailure(bindingFailure()), true)
  assert.equal(
    isThinkingBlockBindingFailure({
      code: 'UNKNOWN',
      message: 'The block is bound to a different conversation',
    }),
    true,
  )
})

test('leaves other invalid-request failures alone', () => {
  assert.equal(isThinkingBlockBindingFailure({
    code: 'INVALID_REQUEST',
    message: 'prompt is too long: 200000 tokens > 128000',
  }), false)
  assert.equal(isThinkingBlockBindingFailure({ code: 'INVALID_REQUEST', message: '' }), false)
})

test('backoff grows exponentially and stays under the ceiling', () => {
  const policy = resolveThinkingBlockRetry({ maxRetries: 5, initialDelayMs: 500, maxDelayMs: 8_000 })
  const middle = () => 0.5
  assert.equal(computeThinkingBlockDelay(policy, 1, middle), 500)
  assert.equal(computeThinkingBlockDelay(policy, 2, middle), 1_000)
  assert.equal(computeThinkingBlockDelay(policy, 3, middle), 2_000)
  assert.equal(computeThinkingBlockDelay(policy, 9, middle), 8_000)
})

test('jitter stays inside its band', () => {
  const policy = resolveThinkingBlockRetry({ initialDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.25 })
  assert.equal(computeThinkingBlockDelay(policy, 1, () => 0), 750)
  assert.equal(computeThinkingBlockDelay(policy, 1, () => 1), 1_250)
})

test('first binding rejection schedules a retry under its own budget', async () => {
  const h = harness()
  const { result, downstream } = await invoke(h)
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(downstream, 0)
  assert.equal(h.appended.length, 2)
  const [retryEvent, startedEvent] = h.appended
  assert.equal(retryEvent.type, 'llm/retry')
  assert.equal(retryEvent.data.mode, 'normal')
  assert.equal(retryEvent.data.retry, 1)
  assert.equal(retryEvent.data.maxRetries, 5)
  assert.equal(retryEvent.data.delayMs, 1)
  assert.equal(retryEvent.data.provider, 'glm-anthropic')
  assert.equal(retryEvent.data.policyKey, thinkingBlockPolicyKey(resolveThinkingBlockRetry(fastConfig.thinkingBlock)))
  assert.equal(retryEvent.data.failure.code, 'INVALID_REQUEST')
  assert.equal(startedEvent.type, 'llm/retry-started')
})

test('a retry id is reused for the whole chain', async () => {
  const h = harness()
  await invoke(h)
  const retryId = h.appended[0].data.retryId
  const second = harness({
    state: { [thinkingStateKey()]: { retry: 1, retryId } },
  })
  await invoke(second)
  assert.equal(second.appended[0].data.retryId, retryId)
  assert.equal(second.appended[0].data.retry, 2)
})

test('the binding budget does not consume the rate-limit budget', async () => {
  const h = harness({
    state: {
      [JSON.stringify(['glm-anthropic', retryPolicyKey(providerPolicy)])]: { retry: 10, retryId: 'r' },
    },
  })
  const { result, downstream } = await invoke(h)
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(downstream, 0)
})

test('an exhausted binding budget delegates downstream', async () => {
  const h = harness({ state: { [thinkingStateKey()]: { retry: 5, retryId: 'r' } } })
  const { result, downstream } = await invoke(h)
  assert.deepEqual(result, { kind: 'stop' })
  assert.equal(downstream, 1)
  assert.equal(h.appended.length, 0)
})

test('thinkingBlock.maxRetries: 0 disables the binding policy', async () => {
  const h = harness({ config: { ...fastConfig, thinkingBlock: { ...fastConfig.thinkingBlock, maxRetries: 0 } } })
  const { result, downstream } = await invoke(h)
  assert.deepEqual(result, { kind: 'stop' })
  assert.equal(downstream, 1)
  assert.equal(h.appended.length, 0)
})

test('binding retries do not depend on a provider retry policy', async () => {
  const h = harness()
  const { result, downstream } = await invoke(h, { retryPolicy: undefined })
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(downstream, 0)
})

test('unrelated invalid requests stay with the built-in executor', async () => {
  const h = harness()
  const { result, downstream } = await invoke(h, {
    failure: { code: 'INVALID_REQUEST', message: 'messages: text content blocks must be non-empty' },
  })
  assert.deepEqual(result, { kind: 'stop' })
  assert.equal(downstream, 1)
  assert.equal(h.appended.length, 0)
})

test('rate-limit failures still take the OMP path', async () => {
  const h = harness()
  const { result, downstream } = await invoke(h, { failure: rateLimitFailure() })
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(downstream, 0)
  assert.equal(h.appended[0].data.policyKey, retryPolicyKey(providerPolicy))
})

test('rejects malformed thinkingBlock values', () => {
  assert.throws(() => resolveThinkingBlockRetry({ maxRetries: -1 }), /thinkingBlock\.maxRetries/)
  assert.throws(() => resolveThinkingBlockRetry({ initialDelayMs: 10, maxDelayMs: 5 }), /thinkingBlock\.maxDelayMs/)
  assert.throws(() => resolveThinkingBlockRetry({ jitterRatio: 2 }), /thinkingBlock\.jitterRatio/)
})
