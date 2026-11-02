/**
 * Retry policy for Anthropic/Bedrock thinking-block binding rejections.
 *
 * Replayed `thinking` blocks carry a signature bound to the conversation they
 * were minted in — the system prompt, the tool list, and the messages before
 * the block. When a proxy or gateway routes a request to a different upstream
 * channel, or the provider rotates the conversation identity, the request is
 * rejected with a 400 such as:
 *
 *     messages.1.content.0: Invalid `signature` in `thinking` block.
 *     The block is bound to a different conversation. Remove the block, or set
 *     `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".
 *
 * That failure is not a property of the request body: replaying the very same
 * history usually succeeds moments later, because the next attempt lands on a
 * channel that accepts the signature. DSH classifies it as `INVALID_REQUEST`
 * and never retries it, so the whole turn ends. This policy retries it a small,
 * bounded number of times with a short exponential backoff.
 */

import type { LlmRequestFailure } from './types.js'

/** The signature rejection itself, including the offending block position. */
const THINKING_BLOCK_SIGNATURE_RE = /Invalid `signature` in `thinking` block/i

/** The binding explanation that follows the rejection. */
const THINKING_BLOCK_BINDING_RE = /bound to a different conversation/i

/** Retry budget for one failed step before the failure becomes terminal. */
export const DEFAULT_THINKING_BLOCK_MAX_RETRIES = 5

/** First wait; a transient upstream routing decision usually settles sooner. */
export const DEFAULT_THINKING_BLOCK_INITIAL_DELAY_MS = 500

/**
 * Backoff ceiling. Matches the provider policy's own local backoff shape
 * (500 ms doubling to 8 s), so a binding retry is as persistent as an
 * ordinary transient retry before the turn gives up.
 */
export const DEFAULT_THINKING_BLOCK_MAX_DELAY_MS = 8_000

/** Fractional jitter applied to each wait, mirroring the built-in executor. */
export const DEFAULT_THINKING_BLOCK_JITTER_RATIO = 0.25

/** Raw `thinkingBlock` plugin configuration. */
export interface ThinkingBlockRetryConfig {
  /** Attempts after the first failure. `0` disables this policy. */
  readonly maxRetries?: number
  /** Wait before the first retry, in milliseconds. */
  readonly initialDelayMs?: number
  /** Upper bound for any single wait, in milliseconds. */
  readonly maxDelayMs?: number
  /** Fractional jitter in `[0, 1]` applied to each wait. */
  readonly jitterRatio?: number
}

/** Fully resolved thinking-block retry tuning. */
export interface ResolvedThinkingBlockRetryPolicy {
  readonly maxRetries: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** Defaults applied when the profile leaves the row unconfigured. */
export const DEFAULT_THINKING_BLOCK_RETRY: ResolvedThinkingBlockRetryPolicy =
  Object.freeze({
    maxRetries: DEFAULT_THINKING_BLOCK_MAX_RETRIES,
    initialDelayMs: DEFAULT_THINKING_BLOCK_INITIAL_DELAY_MS,
    maxDelayMs: DEFAULT_THINKING_BLOCK_MAX_DELAY_MS,
    jitterRatio: DEFAULT_THINKING_BLOCK_JITTER_RATIO,
  })

/**
 * Whether a failure is a thinking-block binding rejection rather than an
 * ordinary invalid request. Matches the provider text only: the two phrases
 * above are specific to this validation and survive code remapping by proxies.
 */
export function isThinkingBlockBindingFailure(
  failure: LlmRequestFailure,
): boolean {
  const message = failure.message
  if (typeof message !== 'string' || message.length === 0) return false
  return (
    THINKING_BLOCK_SIGNATURE_RE.test(message) ||
    THINKING_BLOCK_BINDING_RE.test(message)
  )
}

/**
 * Validate and fill the thinking-block retry configuration.
 *
 * @throws when a value is not a usable number, so a typo fails at load time
 *   instead of surfacing as silently disabled retries.
 */
export function resolveThinkingBlockRetry(
  config: ThinkingBlockRetryConfig = {},
): ResolvedThinkingBlockRetryPolicy {
  const maxRetries = config.maxRetries ?? DEFAULT_THINKING_BLOCK_MAX_RETRIES
  const initialDelayMs =
    config.initialDelayMs ?? DEFAULT_THINKING_BLOCK_INITIAL_DELAY_MS
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_THINKING_BLOCK_MAX_DELAY_MS
  const jitterRatio = config.jitterRatio ?? DEFAULT_THINKING_BLOCK_JITTER_RATIO

  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error(
      'omp-rate-limit-retry: thinkingBlock.maxRetries must be a non-negative safe integer',
    )
  }
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new Error(
      'omp-rate-limit-retry: thinkingBlock.initialDelayMs must be a non-negative safe integer',
    )
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new Error(
      'omp-rate-limit-retry: thinkingBlock.maxDelayMs must be a safe integer no smaller than initialDelayMs',
    )
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(
      'omp-rate-limit-retry: thinkingBlock.jitterRatio must be a number in [0, 1]',
    )
  }

  return { maxRetries, initialDelayMs, maxDelayMs, jitterRatio }
}

/**
 * Durable key for this policy's retry budget. A dedicated namespace keeps the
 * count independent from the provider's `retryPolicy` budget and from the
 * rate-limit budget `dsh-llm-retry` tracks.
 */
export function thinkingBlockPolicyKey(
  policy: ResolvedThinkingBlockRetryPolicy,
): string {
  return JSON.stringify([
    'thinking-block-binding',
    policy.maxRetries,
    policy.initialDelayMs,
    policy.maxDelayMs,
    policy.jitterRatio,
  ])
}

/**
 * Wait before one retry: bounded exponential backoff with fractional jitter,
 * the same shape the built-in executor uses for local backoff.
 */
export function computeThinkingBlockDelay(
  policy: ResolvedThinkingBlockRetryPolicy,
  retry: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(retry - 1, 0), 32)
  const exponential = Math.min(
    policy.initialDelayMs * 2 ** exponent,
    policy.maxDelayMs,
  )
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}
