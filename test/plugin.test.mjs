import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, computeRateLimitDelay, retryPolicyKey } from '../index.js'

const policy = Object.freeze({
  mode: 'normal',
  maxRetries: 10,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.25,
})

function failure(overrides = {}) {
  return { message: 'rate limited', code: 'RATE_LIMIT', ...overrides }
}

function harness({ state = {}, policy: activePolicy = policy, config = { floorMs: 1, maxDelayMs: 10 } } = {}) {
  const listeners = []
  const appended = []
  const cleanups = []
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
    effect: (factory) => {
      cleanups.push(factory())
    },
  }
  apply(ctx, config, {})
  return { listeners, appended, cleanups, agent, policy: activePolicy }
}

async function invoke(harness, overrides = {}) {
  let downstream = 0
  const result = await harness.listeners[0]({
    agent: harness.agent,
    turn: 1,
    step: 1,
    provider: 'glm-openai',
    failure: failure(),
    retryPolicy: harness.policy,
    signal: new AbortController().signal,
    ...overrides,
  }, async () => {
    downstream += 1
    return { kind: 'stop' }
  })
  return { result, downstream }
}

test('computeRateLimitDelay enforces the 30 second floor', () => {
  assert.equal(computeRateLimitDelay({}), 30_000)
  assert.equal(computeRateLimitDelay({ providerRetryAfterMs: 1_000 }), 30_000)
})

test('computeRateLimitDelay honors a larger Retry-After', () => {
  assert.equal(computeRateLimitDelay({ providerRetryAfterMs: 45_000 }), 45_000)
})

test('computeRateLimitDelay gives up above the five minute ceiling', () => {
  assert.equal(computeRateLimitDelay({ providerRetryAfterMs: 300_001 }), undefined)
})

test('first rate-limit failure schedules one durable retry', async () => {
  const h = harness()
  const { result, downstream } = await invoke(h)
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(downstream, 0)
  assert.equal(h.appended.length, 2)
  assert.equal(h.appended[0].type, 'llm/retry')
  assert.equal(h.appended[0].data.retry, 1)
  assert.equal(h.appended[0].data.delayMs, 1)
  assert.equal(h.appended[0].data.policyKey, retryPolicyKey(policy))
  assert.equal(h.appended[1].type, 'llm/retry-started')
})

test('exhausted budget delegates downstream', async () => {
  const h = harness({
    state: { [JSON.stringify(['glm-openai', retryPolicyKey(policy)])]: { retry: 10, retryId: 'r' } },
  })
  const { result, downstream } = await invoke(h)
  assert.deepEqual(result, { kind: 'stop' })
  assert.equal(downstream, 1)
  assert.equal(h.appended.length, 0)
})

test('non-rate-limit failures stay with the built-in executor', async () => {
  const h = harness()
  const { result, downstream } = await invoke(h, { failure: failure({ code: 'SERVER' }) })
  assert.deepEqual(result, { kind: 'stop' })
  assert.equal(downstream, 1)
})

test('a policy that still covers RATE_LIMIT is still handled by the prepended listener', async () => {
  const h = harness({ policy: { ...policy, retryableCodes: [...policy.retryableCodes, 'RATE_LIMIT'] } })
  const { result, downstream } = await invoke(h)
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(downstream, 0)
})

test('always-mode policies are left to the built-in executor', async () => {
  const h = harness({ policy: { mode: 'always', initialDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.25 } })
  const { downstream } = await invoke(h)
  assert.equal(downstream, 1)
})

test('a provider Retry-After above the ceiling delegates downstream', async () => {
  const h = harness({ config: { floorMs: 1, maxDelayMs: 300_000 } })
  const { result, downstream } = await invoke(h, { failure: failure({ providerRetryAfterMs: 600_000 }) })
  assert.deepEqual(result, { kind: 'stop' })
  assert.equal(downstream, 1)
  assert.equal(h.appended.length, 0)
})

test('the plugin budget is independent of a lower provider maxRetries', async () => {
  const lower = { ...policy, maxRetries: 5 }
  const key = JSON.stringify(['glm-openai', retryPolicyKey(lower)])
  const h = harness({
    policy: lower,
    state: { [key]: { retry: 5, retryId: 'r' } },
  })
  const { result, downstream } = await invoke(h)
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(downstream, 0)
  assert.equal(h.appended[0].data.retry, 6)
  assert.equal(h.appended[0].data.maxRetries, 10)
})

test('maxRetries: 0 disables the rate-limit listener', async () => {
  const h = harness({ config: { floorMs: 1, maxDelayMs: 10, maxRetries: 0 } })
  const { result, downstream } = await invoke(h)
  assert.deepEqual(result, { kind: 'stop' })
  assert.equal(downstream, 1)
})

test('rejects a malformed maxRetries', () => {
  assert.throws(() => harness({ config: { maxRetries: -1 } }), /maxRetries/)
})
