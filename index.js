/**
 * OMP-compatible rate-limit retry policy for the DeepSeek Harness.
 *
 * The built-in `dsh-llm-retry` executor owns bounded retries for every
 * provider. OMP treats HTTP 429 rate limits separately: it waits at least
 * 30 seconds (or the provider's `Retry-After` when longer), allows ten
 * retries, and gives up when the requested wait exceeds five minutes.
 *
 * DSH's provider `retryPolicy` cannot express a per-code delay floor, so this
 * listener runs before `llm-retry` via Cordis listener prepending and handles
 * only `RATE_LIMIT` failures. Every other code stays with the built-in
 * executor, whose own policy remains a fallback when this bundle is absent.
 *
 * @module dsh-omp-retry
 */

import { randomUUID } from 'node:crypto'

export const name = 'omp-rate-limit-retry'
export const inject = ['agents', 'sessionProjections']

const RATE_LIMIT_CODE = 'RATE_LIMIT'
const DEFAULT_FLOOR_MS = 30_000
const DEFAULT_MAX_DELAY_MS = 300_000
const DEFAULT_MAX_RETRIES = 10

/**
 * Canonical key for one resolved provider policy. It matches the key
 * `dsh-llm-retry` writes, so rate-limit attempts and ordinary transient
 * attempts share one durable retry budget.
 * @param {object} policy resolved normal retry policy
 * @returns {string}
 */
export function retryPolicyKey(policy) {
  return JSON.stringify([
    policy.mode,
    policy.maxRetries,
    [...policy.retryableCodes].sort(),
    policy.initialDelayMs,
    policy.maxDelayMs,
    policy.jitterRatio,
  ])
}

/**
 * OMP's wait for one 429: `max(30s floor, Retry-After)`, rejected when it
 * exceeds the five-minute ceiling.
 * @param {{ providerRetryAfterMs?: number }} failure
 * @param {{ floorMs?: number, maxDelayMs?: number }} [options]
 * @returns {number | undefined} delay in milliseconds, or undefined to stop
 */
export function computeRateLimitDelay(failure, options = {}) {
  const floorMs = options.floorMs ?? DEFAULT_FLOOR_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const retryAfter = failure.providerRetryAfterMs
  const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.max(floorMs, retryAfter)
    : floorMs
  return delayMs > maxDelayMs ? undefined : delayMs
}

function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function resolveConfig(config) {
  const floorMs = config.floorMs ?? DEFAULT_FLOOR_MS
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isSafeInteger(floorMs) || floorMs < 0) {
    throw new Error('omp-rate-limit-retry: floorMs must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < floorMs) {
    throw new Error('omp-rate-limit-retry: maxDelayMs must be a safe integer no smaller than floorMs')
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('omp-rate-limit-retry: maxRetries must be a non-negative safe integer')
  }
  return { floorMs, maxDelayMs, maxRetries }
}

/**
 * Install the rate-limit listener.
 * @param {object} ctx plugin context
 * @param {{ floorMs?: number, maxDelayMs?: number, maxRetries?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const { floorMs, maxDelayMs, maxRetries } = resolveConfig(config)
  const lifetime = new AbortController()
  const active = new Set()

  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal) {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return
    agent.session.append('llm/retry', {
      retryId,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey,
      retry,
      maxRetries,
      delayMs,
      failure,
    })
    if (!await cancellableDelay(delayMs, fusedSignal)) return
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  async function recover({ agent, turn, step, provider, failure, retryPolicy: policy, signal }, next) {
    if (!policy || policy.mode !== 'normal') return next()
    if (failure.code !== RATE_LIMIT_CODE) return next()

    const policyKey = retryPolicyKey(policy)
    const state = ctx.sessionProjections.stateOf(agent.session, 'llmRetry')
    const previous = state[JSON.stringify([provider, policyKey])]
    const previousRetry = previous?.retry ?? 0
    if (previousRetry >= maxRetries) return next()

    const delayMs = computeRateLimitDelay(failure, { floorMs, maxDelayMs })
    if (delayMs === undefined) return next()

    const retry = previousRetry + 1
    const retryId = previous?.retryId ?? randomUUID()
    return backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal)
  }

  // Prepend so this listener owns 429s even though the bundle loads after
  // the built-in llm-retry row. Non-rate-limit failures delegate downstream.
  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    return track(recover(payload, next))
  }, true)

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('omp-rate-limit-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'omp-rate-limit-retry: abort and drain active recovery')
}
