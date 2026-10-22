# dsh-omp-retry

An OMP-style retry policy for HTTP 429 responses in the DeepSeek Harness.

DSH's built-in `dsh-llm-retry` uses one bounded exponential policy for every
transient failure. With defaults that is five retries from 500 ms to 10 s, so a
TPM/RPM window can still be active when the budget is gone. OMP treats rate
limits differently: it keeps retrying for up to ten attempts, waits at least
30 seconds, and accepts a provider `Retry-After` up to five minutes.

This bundle adds that rate-limit behavior without forking DSH. It prepends one
`agent/request-error` listener ahead of `dsh-llm-retry` and owns only
`RATE_LIMIT`; every other failure code stays with the built-in executor.

## Behavior

- Up to **10** rate-limit retries per failed step (configurable).
- Delay is `max(30 s, provider Retry-After)`.
- A required wait above **5 minutes** ends the retry chain instead of sleeping.
- Each scheduled retry appends durable `llm/retry` / `llm/retry-started` events,
  so the normal retry UI and session history still work.
- Cancellation, turn end, and plugin disposal abort the active wait.
- `SERVER`, `TIMEOUT`, `TRANSPORT`, and `EMPTY_RESPONSE` are left to
  `dsh-llm-retry` with the provider's own policy.
- `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, `AUTH`, and `INVALID_REQUEST` are never
  retried by this plugin.

## Install

```sh
dsh plugin --profile desktop add github:Rinai-R/dsh-omp-retry
```

Use your profile name instead of `desktop` for a web or custom profile, then
restart DSH. The bundle inserts the `omp-rate-limit-retry` row itself.

## Configuration

The defaults are `maxRetries: 10`, `floorMs: 30000`, and `maxDelayMs: 300000`.
Override the row in the profile's `cordis.patch.yml`:

```yaml
- id: omp-rate-limit-retry
  config:
    maxRetries: 10
    floorMs: 30000
    maxDelayMs: 300000
```

`maxRetries: 0` disables the plugin. The plugin's budget is independent of the
provider's `retryPolicy.maxRetries`: a provider left at the default five still
gets ten rate-limit attempts.

For fast non-429 retries, keep the provider policy close to OMP's local
backoff:

```yaml
retryPolicy:
  mode: normal
  maxRetries: 10
  retryableCodes:
    - EMPTY_RESPONSE
    - RATE_LIMIT
    - SERVER
    - TIMEOUT
    - TRANSPORT
  backoff:
    initialDelayMs: 500
    maxDelayMs: 8000
    jitterRatio: 0.25
```

Keeping `RATE_LIMIT` in the list is a fallback for when this bundle is removed;
while the bundle is active it takes 429s first.

## Compatibility

Tested against DSH Desktop `0.2.1-rc.2`. The plugin relies on:

- the `agent/request-error` waterfall,
- the `llm-retry` session projection (`llmRetry`),
- the `llm/retry` event shape used by the built-in retry executor.

If a future DSH changes those contracts, the plugin may need an update; it fails
closed by delegating to the next listener.

## Development

No build step, no runtime dependencies:

```sh
npm test
```

## Limitations

- This is not Ghostty, and it is not a general retry framework: it only covers
  HTTP 429 rate limits.
- OMP's model/credential fallback chains are not implemented.
- A provider `Retry-After` above `maxDelayMs` is not waited out.

## License

MIT
