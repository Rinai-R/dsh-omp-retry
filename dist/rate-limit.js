/**
 * OMP-compatible handling of HTTP 429 rate limits.
 *
 * OMP waits at least 30 seconds (or the provider's `Retry-After` when longer),
 * allows ten retries, and gives up when the requested wait exceeds five
 * minutes. DSH's provider `retryPolicy` cannot express a per-code delay floor,
 * so this policy is applied by a listener that runs ahead of `dsh-llm-retry`.
 */
/** Failure code the provider adapters assign to HTTP 429. */
export const RATE_LIMIT_CODE = 'RATE_LIMIT';
/** OMP's minimum wait between rate-limit attempts. */
export const DEFAULT_FLOOR_MS = 30_000;
/** OMP's ceiling: a longer required wait ends the chain instead of sleeping. */
export const DEFAULT_MAX_DELAY_MS = 300_000;
/** OMP's retry budget for one failed step. */
export const DEFAULT_MAX_RETRIES = 10;
/**
 * Canonical key for one resolved provider policy. It matches the key
 * `dsh-llm-retry` writes, so rate-limit attempts and ordinary transient
 * attempts share one durable retry budget.
 */
export function retryPolicyKey(policy) {
    return JSON.stringify([
        policy.mode,
        policy.maxRetries,
        [...policy.retryableCodes].sort(),
        policy.initialDelayMs,
        policy.maxDelayMs,
        policy.jitterRatio,
    ]);
}
/**
 * OMP's wait for one 429: `max(floor, Retry-After)`, rejected when it exceeds
 * the ceiling so the chain ends instead of sleeping.
 *
 * @returns delay in milliseconds, or `undefined` to stop retrying
 */
export function computeRateLimitDelay(failure, options = {}) {
    const floorMs = options.floorMs ?? DEFAULT_FLOOR_MS;
    const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const retryAfter = failure.providerRetryAfterMs;
    const delayMs = retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.max(floorMs, retryAfter)
        : floorMs;
    return delayMs > maxDelayMs ? undefined : delayMs;
}
//# sourceMappingURL=rate-limit.js.map