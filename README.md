# dsh-omp-retry

OMP-style retry policies for two DeepSeek Harness failures that the built-in
executor leaves terminal:

- **HTTP 429 rate limits.** OMP keeps retrying for up to ten attempts, waits at
  least 30 seconds, and accepts a provider `Retry-After` up to five minutes.
  DSH's default policy is five retries from 500 ms to 10 s, so a TPM/RPM window
  can still be active when the budget is gone.
- **Thinking-block binding rejections.** A replayed `thinking` block carries a
  signature bound to the conversation it was minted in. Proxies and gateways
  that fan out to several upstream channels (or rotate conversation identity)
  reject it with `400 ... Invalid `signature` in `thinking` block. The block is
  bound to a different conversation`; re-sending the same history usually
  succeeds because the next attempt lands on an upstream that accepts it. DSH
  classifies the 400 as `INVALID_REQUEST` and never retries it, so the whole
  turn ends.

This bundle adds both policies without forking DSH. It prepends one
`agent/request-error` listener ahead of `dsh-llm-retry` and owns only those two
failures; every other code stays with the built-in executor, whose own policy
remains the fallback when this bundle is absent.

## Behavior

Rate limits:

- Up to **10** rate-limit retries per failed step (configurable).
- Delay is `max(30 s, provider Retry-After)`.
- A required wait above **5 minutes** ends the retry chain instead of sleeping.
- The budget is shared with `dsh-llm-retry`: one durable policy key per resolved
  provider `retryPolicy`.

Thinking-block binding rejections:

- Up to **5** retries per failed step (configurable), with exponential backoff
  from **500 ms** to **8 s** and 25% jitter — the same shape as the provider
  retry policy's local backoff, so a binding rejection is retried as
  persistently as an ordinary transient failure.
- The budget is **independent** of the provider `retryPolicy` budget, so a
  provider left at its default still gets the binding retries.
- Matching is on the provider text (`Invalid `signature` in `thinking` block` or
  `bound to a different conversation`), not on the failure code, so the policy
  survives code remapping by a gateway.

Both:

- Each scheduled retry appends durable `llm/retry` / `llm/retry-started` events,
  so the normal retry UI and session history still work.
- Cancellation, turn end, and plugin disposal abort the active wait.
- `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, `CONTEXT_WINDOW_EXCEEDED`,
  `QUOTA`, and `AUTH` are never retried by this plugin.

## Install

```sh
dsh plugin --profile desktop add github:Rinai-R/dsh-omp-retry
```

Use your profile name instead of `desktop` for a web or custom profile, then
restart DSH. The bundle inserts the `omp-rate-limit-retry` row itself.

## Configuration

The defaults are `maxRetries: 10`, `floorMs: 30000`, and `maxDelayMs: 300000`
for rate limits and `maxRetries: 5`, `initialDelayMs: 500`, `maxDelayMs: 8000`,
`jitterRatio: 0.25` for binding rejections. Override the row in the profile's
`cordis.patch.yml`:

```yaml
- id: omp-rate-limit-retry
  config:
    maxRetries: 10
    floorMs: 30000
    maxDelayMs: 300000
    thinkingBlock:
      maxRetries: 5
      initialDelayMs: 500
      maxDelayMs: 8000
      jitterRatio: 0.25
```

`maxRetries: 0` disables the corresponding policy. Malformed values fail the
plugin load with a message naming the offending key instead of silently
disabling retries.

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

Verified against DSH Desktop `0.2.1-rc.5`. The plugin relies on:

- the `agent/request-error` waterfall,
- the `llm-retry` session projection (`llmRetry`),
- the `llm/retry` event shape used by the built-in retry executor.

If a future DSH changes those contracts, the plugin may need an update; it fails
closed by delegating to the next listener.

## Development

The plugin is written in TypeScript under `src/`; `dist/` is the build output
and is committed so `github:` installs load without a build step.

```sh
npm install
npm run build
npm test
```

`npm test` builds first, then runs the `node:test` suite against `dist/`. After
changing `src/`, rebuild and commit `dist/` — CI fails when the two drift.

## Limitations

- This is not Ghostty, and it is not a general retry framework: it covers HTTP
  429 rate limits and thinking-block binding rejections only.
- Retrying does not rewrite history. When the rejection keeps coming back, the
  conversation identity really did change — for example a mid-session model or
  tool-schema switch — and the turn still ends once the budget is exhausted.
  The durable fix lives upstream: send
  `anthropic-beta: thinking-binding-controls-2026-08-01` with
  `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, or drop the
  stale block before the request leaves the client.
- OMP's model/credential fallback chains are not implemented.
- A provider `Retry-After` above `maxDelayMs` is not waited out.

## License

MIT
