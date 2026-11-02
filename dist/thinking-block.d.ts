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
import type { LlmRequestFailure } from './types.js';
/** Retry budget for one failed step before the failure becomes terminal. */
export declare const DEFAULT_THINKING_BLOCK_MAX_RETRIES = 5;
/** First wait; a transient upstream routing decision usually settles sooner. */
export declare const DEFAULT_THINKING_BLOCK_INITIAL_DELAY_MS = 500;
/**
 * Backoff ceiling. Matches the provider policy's own local backoff shape
 * (500 ms doubling to 8 s), so a binding retry is as persistent as an
 * ordinary transient retry before the turn gives up.
 */
export declare const DEFAULT_THINKING_BLOCK_MAX_DELAY_MS = 8000;
/** Fractional jitter applied to each wait, mirroring the built-in executor. */
export declare const DEFAULT_THINKING_BLOCK_JITTER_RATIO = 0.25;
/** Raw `thinkingBlock` plugin configuration. */
export interface ThinkingBlockRetryConfig {
    /** Attempts after the first failure. `0` disables this policy. */
    readonly maxRetries?: number;
    /** Wait before the first retry, in milliseconds. */
    readonly initialDelayMs?: number;
    /** Upper bound for any single wait, in milliseconds. */
    readonly maxDelayMs?: number;
    /** Fractional jitter in `[0, 1]` applied to each wait. */
    readonly jitterRatio?: number;
}
/** Fully resolved thinking-block retry tuning. */
export interface ResolvedThinkingBlockRetryPolicy {
    readonly maxRetries: number;
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitterRatio: number;
}
/** Defaults applied when the profile leaves the row unconfigured. */
export declare const DEFAULT_THINKING_BLOCK_RETRY: ResolvedThinkingBlockRetryPolicy;
/**
 * Whether a failure is a thinking-block binding rejection rather than an
 * ordinary invalid request. Matches the provider text only: the two phrases
 * above are specific to this validation and survive code remapping by proxies.
 */
export declare function isThinkingBlockBindingFailure(failure: LlmRequestFailure): boolean;
/**
 * Validate and fill the thinking-block retry configuration.
 *
 * @throws when a value is not a usable number, so a typo fails at load time
 *   instead of surfacing as silently disabled retries.
 */
export declare function resolveThinkingBlockRetry(config?: ThinkingBlockRetryConfig): ResolvedThinkingBlockRetryPolicy;
/**
 * Durable key for this policy's retry budget. A dedicated namespace keeps the
 * count independent from the provider's `retryPolicy` budget and from the
 * rate-limit budget `dsh-llm-retry` tracks.
 */
export declare function thinkingBlockPolicyKey(policy: ResolvedThinkingBlockRetryPolicy): string;
/**
 * Wait before one retry: bounded exponential backoff with fractional jitter,
 * the same shape the built-in executor uses for local backoff.
 */
export declare function computeThinkingBlockDelay(policy: ResolvedThinkingBlockRetryPolicy, retry: number, random?: () => number): number;
//# sourceMappingURL=thinking-block.d.ts.map