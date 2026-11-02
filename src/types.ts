/**
 * The slice of the DeepSeek Harness plugin surface this bundle depends on.
 *
 * The harness ships JSDoc-typed JavaScript rather than declaration files, so
 * these interfaces restate the contracts documented by `@deepseek-ai/dsh-agent`
 * (the `agent/request-error` waterfall) and `@deepseek-ai/dsh-llm-retry`
 * (`llm/retry` events and the `llmRetry` session projection).
 */

/** Failure payload carried by the `agent/request-error` waterfall. */
export interface LlmRequestFailure {
  /** Failure classification assigned by the provider adapter. */
  readonly code: string
  /** Provider message, preserved verbatim so policies can match on it. */
  readonly message: string
  /** Wait the provider asked for, when it sent one (HTTP `Retry-After`). */
  readonly providerRetryAfterMs?: number
}

/** A resolved provider `retryPolicy` in `mode: normal`. */
export interface NormalRetryPolicy {
  readonly mode: 'normal'
  readonly maxRetries: number
  readonly retryableCodes: readonly string[]
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** A resolved provider `retryPolicy` in `mode: always`. */
export interface AlwaysRetryPolicy {
  readonly mode: 'always'
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** A resolved provider retry policy. */
export type ProviderRetryPolicy = NormalRetryPolicy | AlwaysRetryPolicy

/** Session handle through which a plugin appends durable events. */
export interface RetrySession {
  append(type: string, data: Record<string, unknown>): unknown
}

/** Agent handle carried by the request-error payload. */
export interface RetryAgent {
  readonly session: RetrySession
}

/** Payload of the `agent/request-error` waterfall. */
export interface RequestErrorPayload {
  readonly agent: RetryAgent
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly failure: LlmRequestFailure
  readonly retryPolicy?: ProviderRetryPolicy
  readonly signal: AbortSignal
}

/** What a handling listener returns to keep the failed request alive. */
export interface RetryDecision {
  readonly kind: 'retry'
}

/** Continuation that runs the rest of the waterfall, including the built-in executor. */
export type RequestErrorNext = () => Promise<RetryDecision | undefined>

/** One `llmRetry` projection entry: the last retry count for a provider policy. */
export interface LlmRetryStateEntry {
  readonly retry: number
  readonly retryId: string
}

/** The `llmRetry` session projection, keyed by `retryStateKey`. */
export type LlmRetryState = Readonly<Record<string, LlmRetryStateEntry>>

/** The `sessionProjections` service surface this bundle reads. */
export interface SessionProjections {
  stateOf(session: unknown, key: 'llmRetry'): LlmRetryState
}

/** A Cordis lifecycle effect registrar. */
export type EffectRegistrar = (
  factory: () => (() => Promise<void>) | void,
  label?: string,
) => void

/** Prepend-capable registration for the request-error waterfall. */
export type RequestErrorRegistrar = (
  event: 'agent/request-error',
  listener: (
    payload: RequestErrorPayload,
    next: RequestErrorNext,
  ) => Promise<RetryDecision | undefined>,
  prepend?: boolean,
) => () => void

/**
 * The plugin context this bundle uses. Only the members touched here are
 * typed, so a future harness may add services without breaking this build.
 */
export interface PluginContext {
  readonly sessionProjections: SessionProjections
  readonly on: RequestErrorRegistrar
  readonly effect: EffectRegistrar
}

/** Test-only seams, mirroring the built-in executor's `internals` argument. */
export interface PluginInternals {
  /** Injectable randomness for deterministic backoff assertions. */
  readonly random?: () => number
}
