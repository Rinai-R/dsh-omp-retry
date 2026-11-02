/**
 * OMP-compatible retry policies for the DeepSeek Harness.
 *
 * DSH's built-in `dsh-llm-retry` applies one bounded exponential policy to a
 * fixed set of transient codes. Two cases it deliberately leaves alone matter
 * in practice, and this bundle handles each with its own budget:
 *
 * - HTTP 429 rate limits. OMP keeps retrying for up to ten attempts, waits at
 *   least 30 seconds, and accepts a provider `Retry-After` up to five minutes.
 * - Thinking-block binding rejections (`Invalid `signature` in `thinking`
 *   block`). These are 400s raised when a proxy or gateway routes a replayed
 *   block to an upstream that did not mint it; replaying the same history
 *   usually succeeds, but DSH treats `INVALID_REQUEST` as terminal and ends the
 *   turn. A short bounded retry recovers it.
 *
 * The listener is prepended ahead of `dsh-llm-retry` and owns only those two
 * failures; every other code stays with the built-in executor, whose own
 * policy remains a fallback when this bundle is absent.
 *
 * @module dsh-omp-retry
 */

import {
  computeRateLimitDelay,
  DEFAULT_FLOOR_MS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  RATE_LIMIT_CODE,
  retryPolicyKey,
} from './rate-limit.js'
import { newRetryId, retryStateKey, scheduleRetry } from './retry.js'
import {
  computeThinkingBlockDelay,
  isThinkingBlockBindingFailure,
  resolveThinkingBlockRetry,
  thinkingBlockPolicyKey,
} from './thinking-block.js'
import type {
  ResolvedThinkingBlockRetryPolicy,
  ThinkingBlockRetryConfig,
} from './thinking-block.js'
import type {
  LlmRequestFailure,
  NormalRetryPolicy,
  PluginContext,
  PluginInternals,
  RequestErrorNext,
  RequestErrorPayload,
  RetryAgent,
  RetryDecision,
} from './types.js'

export { computeRateLimitDelay, retryPolicyKey } from './rate-limit.js'
export {
  computeThinkingBlockDelay,
  isThinkingBlockBindingFailure,
  resolveThinkingBlockRetry,
  thinkingBlockPolicyKey,
} from './thinking-block.js'
export type {
  ResolvedThinkingBlockRetryPolicy,
  ThinkingBlockRetryConfig,
} from './thinking-block.js'

/** The bundle's Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'omp-rate-limit-retry'

/** Services this bundle reads. */
export const inject = ['agents', 'sessionProjections'] as const

/** Raw plugin configuration, as written under the `cordis.patch.yml` row. */
export interface PluginConfig {
  /** Rate-limit attempts per failed step. `0` disables the rate-limit policy. */
  readonly maxRetries?: number
  /** Rate-limit wait floor, in milliseconds. */
  readonly floorMs?: number
  /** Rate-limit wait ceiling; a longer required wait ends the chain. */
  readonly maxDelayMs?: number
  /** Thinking-block binding retry tuning. */
  readonly thinkingBlock?: ThinkingBlockRetryConfig
}

/** Fully resolved plugin configuration. */
export interface ResolvedPluginConfig {
  readonly maxRetries: number
  readonly floorMs: number
  readonly maxDelayMs: number
  readonly thinkingBlock: ResolvedThinkingBlockRetryPolicy
}

/** What one policy decided about a failure. */
type Recovery =
  | { readonly kind: 'retry' }
  | { readonly kind: 'delegate' }
  | { readonly kind: 'abort' }

/**
 * Validate and fill plugin configuration.
 *
 * @throws when a value is unusable, so a typo fails at load time instead of
 *   silently disabling retries
 */
export function resolveConfig(config: PluginConfig = {}): ResolvedPluginConfig {
  const floorMs = config.floorMs ?? DEFAULT_FLOOR_MS
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES

  if (!Number.isSafeInteger(floorMs) || floorMs < 0) {
    throw new Error(
      'omp-rate-limit-retry: floorMs must be a non-negative safe integer',
    )
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < floorMs) {
    throw new Error(
      'omp-rate-limit-retry: maxDelayMs must be a safe integer no smaller than floorMs',
    )
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error(
      'omp-rate-limit-retry: maxRetries must be a non-negative safe integer',
    )
  }

  return {
    maxRetries,
    floorMs,
    maxDelayMs,
    thinkingBlock: resolveThinkingBlockRetry(config.thinkingBlock),
  }
}

/**
 * Install the retry listener.
 *
 * @param config profile-provided configuration
 * @param internals test-only seams; production callers pass nothing
 */
export function apply(
  ctx: PluginContext,
  config: PluginConfig = {},
  internals: PluginInternals = {},
): void {
  const resolved = resolveConfig(config)
  const random = internals.random ?? Math.random
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()

  function track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  /** One 429: OMP's floor/ceiling delay, sharing `dsh-llm-retry`'s budget. */
  async function rateLimitRecovery(
    agent: RetryAgent,
    turn: number,
    step: number,
    provider: string,
    failure: LlmRequestFailure,
    policy: NormalRetryPolicy,
    signal: AbortSignal,
  ): Promise<Recovery> {
    const policyKey = retryPolicyKey(policy)
    const state = ctx.sessionProjections.stateOf(agent.session, 'llmRetry')
    const previous = state[retryStateKey(provider, policyKey)]
    const previousRetry = previous?.retry ?? 0
    if (previousRetry >= resolved.maxRetries) return { kind: 'delegate' }

    const delayMs = computeRateLimitDelay(failure, resolved)
    if (delayMs === undefined) return { kind: 'delegate' }

    const retry = previousRetry + 1
    const decision = await scheduleRetry({
      agent,
      turn,
      step,
      provider,
      failure,
      policyKey,
      retry,
      maxRetries: resolved.maxRetries,
      delayMs,
      retryId: previous?.retryId ?? newRetryId(),
      signal,
      lifetime: lifetime.signal,
    })
    return decision === undefined ? { kind: 'abort' } : decision
  }

  /** One binding rejection: a short bounded backoff under its own budget. */
  async function thinkingBlockRecovery(
    agent: RetryAgent,
    turn: number,
    step: number,
    provider: string,
    failure: LlmRequestFailure,
    signal: AbortSignal,
  ): Promise<Recovery> {
    const policy = resolved.thinkingBlock
    if (policy.maxRetries === 0) return { kind: 'delegate' }

    const policyKey = thinkingBlockPolicyKey(policy)
    const state = ctx.sessionProjections.stateOf(agent.session, 'llmRetry')
    const previous = state[retryStateKey(provider, policyKey)]
    const previousRetry = previous?.retry ?? 0
    if (previousRetry >= policy.maxRetries) return { kind: 'delegate' }

    const retry = previousRetry + 1
    const decision = await scheduleRetry({
      agent,
      turn,
      step,
      provider,
      failure,
      policyKey,
      retry,
      maxRetries: policy.maxRetries,
      delayMs: computeThinkingBlockDelay(policy, retry, random),
      retryId: previous?.retryId ?? newRetryId(),
      signal,
      lifetime: lifetime.signal,
    })
    return decision === undefined ? { kind: 'abort' } : decision
  }

  async function recover(
    payload: RequestErrorPayload,
    next: RequestErrorNext,
  ): Promise<RetryDecision | undefined> {
    if (lifetime.signal.aborted) return undefined
    const { agent, turn, step, provider, failure, retryPolicy: policy, signal } =
      payload

    let outcome: Recovery | undefined
    if (
      policy !== undefined &&
      policy.mode === 'normal' &&
      failure.code === RATE_LIMIT_CODE
    ) {
      outcome = await rateLimitRecovery(
        agent,
        turn,
        step,
        provider,
        failure,
        policy,
        signal,
      )
    } else if (isThinkingBlockBindingFailure(failure)) {
      outcome = await thinkingBlockRecovery(
        agent,
        turn,
        step,
        provider,
        failure,
        signal,
      )
    }

    switch (outcome?.kind) {
      case 'retry':
        return { kind: 'retry' }
      case 'abort':
        return undefined
      default:
        return next()
    }
  }

  // Prepend so this listener owns these failures even though the bundle loads
  // after the built-in llm-retry row. Unhandled failures delegate downstream.
  const disposeListener = ctx.on(
    'agent/request-error',
    (payload, next) => {
      if (lifetime.signal.aborted) return Promise.resolve(undefined)
      return track(recover(payload, next))
    },
    true,
  )

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('omp-rate-limit-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'omp-rate-limit-retry: abort and drain active recovery')
}
