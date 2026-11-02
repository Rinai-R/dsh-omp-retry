/**
 * Durable retry plumbing shared by every policy in this bundle.
 *
 * A scheduled retry is recorded before its cancellable wait, in the same event
 * shape `dsh-llm-retry` uses, so the normal retry UI and session history keep
 * working and the `llmRetry` projection counts the attempt.
 */

import { randomUUID } from 'node:crypto'

import type {
  LlmRequestFailure,
  RetryAgent,
  RetryDecision,
} from './types.js'

/** Durable event written before each scheduled retry. */
export const RETRY_EVENT = 'llm/retry'

/** Durable event written once the wait elapses and the request is re-sent. */
export const RETRY_STARTED_EVENT = 'llm/retry-started'

/**
 * Canonical `llmRetry` projection key for one provider and policy, matching
 * `dsh-llm-retry`'s own key layout.
 */
export function retryStateKey(provider: string, policyKey: string): string {
  return JSON.stringify([provider, policyKey])
}

/** Mint a fresh retry-chain identity. */
export function newRetryId(): string {
  return randomUUID()
}

/**
 * Wait for `delayMs`, resolving `false` when the signal aborts first.
 *
 * The timer is the only thing this bundle holds across a retry, so the wait
 * must be cancellable: disposal, turn end, and user cancellation all abort.
 */
export function cancellableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Everything one durable retry schedule needs. */
export interface RetrySchedule {
  readonly agent: RetryAgent
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly failure: LlmRequestFailure
  readonly policyKey: string
  readonly retry: number
  readonly maxRetries: number
  readonly delayMs: number
  readonly retryId: string
  /** The turn's abort signal. */
  readonly signal: AbortSignal
  /** The plugin's lifetime signal, aborted on disposal. */
  readonly lifetime: AbortSignal
}

/**
 * Record one retry durably, wait out its delay, then report the re-send.
 *
 * @returns `{ kind: 'retry' }` when the request should be re-sent, or
 *   `undefined` when cancellation interrupted the wait
 */
export async function scheduleRetry(
  schedule: RetrySchedule,
): Promise<RetryDecision | undefined> {
  const fused = AbortSignal.any([schedule.signal, schedule.lifetime])
  if (fused.aborted) return undefined

  schedule.agent.session.append(RETRY_EVENT, {
    retryId: schedule.retryId,
    turn: schedule.turn,
    step: schedule.step,
    provider: schedule.provider,
    mode: 'normal',
    policyKey: schedule.policyKey,
    retry: schedule.retry,
    maxRetries: schedule.maxRetries,
    delayMs: schedule.delayMs,
    failure: schedule.failure,
  })

  if (!(await cancellableDelay(schedule.delayMs, fused))) return undefined

  schedule.agent.session.append(RETRY_STARTED_EVENT, {
    retryId: schedule.retryId,
    turn: schedule.turn,
    step: schedule.step,
    retry: schedule.retry,
  })

  return { kind: 'retry' }
}
