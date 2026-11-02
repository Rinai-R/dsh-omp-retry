/**
 * Durable retry plumbing shared by every policy in this bundle.
 *
 * A scheduled retry is recorded before its cancellable wait, in the same event
 * shape `dsh-llm-retry` uses, so the normal retry UI and session history keep
 * working and the `llmRetry` projection counts the attempt.
 */
import type { LlmRequestFailure, RetryAgent, RetryDecision } from './types.js';
/** Durable event written before each scheduled retry. */
export declare const RETRY_EVENT = "llm/retry";
/** Durable event written once the wait elapses and the request is re-sent. */
export declare const RETRY_STARTED_EVENT = "llm/retry-started";
/**
 * Canonical `llmRetry` projection key for one provider and policy, matching
 * `dsh-llm-retry`'s own key layout.
 */
export declare function retryStateKey(provider: string, policyKey: string): string;
/** Mint a fresh retry-chain identity. */
export declare function newRetryId(): string;
/**
 * Wait for `delayMs`, resolving `false` when the signal aborts first.
 *
 * The timer is the only thing this bundle holds across a retry, so the wait
 * must be cancellable: disposal, turn end, and user cancellation all abort.
 */
export declare function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean>;
/** Everything one durable retry schedule needs. */
export interface RetrySchedule {
    readonly agent: RetryAgent;
    readonly turn: number;
    readonly step: number;
    readonly provider: string;
    readonly failure: LlmRequestFailure;
    readonly policyKey: string;
    readonly retry: number;
    readonly maxRetries: number;
    readonly delayMs: number;
    readonly retryId: string;
    /** The turn's abort signal. */
    readonly signal: AbortSignal;
    /** The plugin's lifetime signal, aborted on disposal. */
    readonly lifetime: AbortSignal;
}
/**
 * Record one retry durably, wait out its delay, then report the re-send.
 *
 * @returns `{ kind: 'retry' }` when the request should be re-sent, or
 *   `undefined` when cancellation interrupted the wait
 */
export declare function scheduleRetry(schedule: RetrySchedule): Promise<RetryDecision | undefined>;
//# sourceMappingURL=retry.d.ts.map