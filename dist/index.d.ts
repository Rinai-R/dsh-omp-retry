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
import type { ResolvedThinkingBlockRetryPolicy, ThinkingBlockRetryConfig } from './thinking-block.js';
import type { PluginContext, PluginInternals } from './types.js';
export { computeRateLimitDelay, retryPolicyKey } from './rate-limit.js';
export { computeThinkingBlockDelay, isThinkingBlockBindingFailure, resolveThinkingBlockRetry, thinkingBlockPolicyKey, } from './thinking-block.js';
export type { ResolvedThinkingBlockRetryPolicy, ThinkingBlockRetryConfig, } from './thinking-block.js';
/** The bundle's Cordis plugin name; also the row id in `cordis.patch.yml`. */
export declare const name = "omp-rate-limit-retry";
/** Services this bundle reads. */
export declare const inject: readonly ["agents", "sessionProjections"];
/** Raw plugin configuration, as written under the `cordis.patch.yml` row. */
export interface PluginConfig {
    /** Rate-limit attempts per failed step. `0` disables the rate-limit policy. */
    readonly maxRetries?: number;
    /** Rate-limit wait floor, in milliseconds. */
    readonly floorMs?: number;
    /** Rate-limit wait ceiling; a longer required wait ends the chain. */
    readonly maxDelayMs?: number;
    /** Thinking-block binding retry tuning. */
    readonly thinkingBlock?: ThinkingBlockRetryConfig;
}
/** Fully resolved plugin configuration. */
export interface ResolvedPluginConfig {
    readonly maxRetries: number;
    readonly floorMs: number;
    readonly maxDelayMs: number;
    readonly thinkingBlock: ResolvedThinkingBlockRetryPolicy;
}
/**
 * Validate and fill plugin configuration.
 *
 * @throws when a value is unusable, so a typo fails at load time instead of
 *   silently disabling retries
 */
export declare function resolveConfig(config?: PluginConfig): ResolvedPluginConfig;
/**
 * Install the retry listener.
 *
 * @param config profile-provided configuration
 * @param internals test-only seams; production callers pass nothing
 */
export declare function apply(ctx: PluginContext, config?: PluginConfig, internals?: PluginInternals): void;
//# sourceMappingURL=index.d.ts.map