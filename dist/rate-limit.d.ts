/**
 * OMP-compatible handling of HTTP 429 rate limits.
 *
 * OMP waits at least 30 seconds (or the provider's `Retry-After` when longer),
 * allows ten retries, and gives up when the requested wait exceeds five
 * minutes. DSH's provider `retryPolicy` cannot express a per-code delay floor,
 * so this policy is applied by a listener that runs ahead of `dsh-llm-retry`.
 */
import type { NormalRetryPolicy } from './types.js';
/** Failure code the provider adapters assign to HTTP 429. */
export declare const RATE_LIMIT_CODE = "RATE_LIMIT";
/** OMP's minimum wait between rate-limit attempts. */
export declare const DEFAULT_FLOOR_MS = 30000;
/** OMP's ceiling: a longer required wait ends the chain instead of sleeping. */
export declare const DEFAULT_MAX_DELAY_MS = 300000;
/** OMP's retry budget for one failed step. */
export declare const DEFAULT_MAX_RETRIES = 10;
/** Resolved rate-limit tuning. */
export interface RateLimitOptions {
    readonly floorMs?: number;
    readonly maxDelayMs?: number;
}
/**
 * Canonical key for one resolved provider policy. It matches the key
 * `dsh-llm-retry` writes, so rate-limit attempts and ordinary transient
 * attempts share one durable retry budget.
 */
export declare function retryPolicyKey(policy: NormalRetryPolicy): string;
/**
 * OMP's wait for one 429: `max(floor, Retry-After)`, rejected when it exceeds
 * the ceiling so the chain ends instead of sleeping.
 *
 * @returns delay in milliseconds, or `undefined` to stop retrying
 */
export declare function computeRateLimitDelay(failure: {
    readonly providerRetryAfterMs?: number;
}, options?: RateLimitOptions): number | undefined;
//# sourceMappingURL=rate-limit.d.ts.map