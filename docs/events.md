# Events, requests, and telemetry

One naming grammar covers the journal, the future RPC surface, and telemetry: **imperative = request, past tense = event.** `bay/open` is the call; `bay/opened` is the fact. Slash namespacing throughout (the LSP/ACP/MCP convention family). Shipped in v0.3 — a pre-v0.3 journal (dotted names — `lease.opened`, `pr.state-changed`, …) needs the one-shot migration (`git bay migrate-journal`) before anything reads it; there is no dual-read shim.

## The event families

```
gitbay/…      the system        initialized · refused {code, detail} · audited {findings}
worktree/…    the directories   provisioned · deprovisioned {via}
bay/…         the loans         opened {worktree, recycled} · refreshed · closed {via}
pr/…          the work          opened {via} · changed {from, to, revision?, code?}
```

Non-events are deliberately not journaled: an empty integrate run, a prune that removed nothing. Every rejection carries a machine-readable kebab-case `code` from a closed union (`merge-conflict`, `lying-merge`, `pin-rewind`, `queue-full`, `poison-retry`, …); building a rejection without a code throws. Codes are for counting; `detail` stays for humans.

## The data model has three layers

1. **The typed event union** — each name has an exact, closed payload; a TypeScript discriminated union on `name`, so folds switch exhaustively and illegal payloads can't be constructed. This is the real model.
2. **The envelope** — `{ id, name, ts, cause, data }`, generic on purpose: the part the journal file, transports, and exporters handle without domain knowledge. It coincides with CloudEvents, which buys interop for free.
3. **The state** — what events fold into; the store is its authority (see [store.md](store.md)).

## Cause and spans

Every command gets an id at the door (CLI and RPC alike); every event it produces carries `cause: {commandId, traceId?, spanId?}`. Mapping to OpenTelemetry: a command is a span (refusal = error status with the code as attribute); journal events are span events; check steps are child spans with durations — the "why was integration slow" waterfall. PRs and bays ride as span attributes, not traces. Propagation: `TRACEPARENT` env for the CLI, `meta.traceparent` for RPC. The core never depends on an OTel SDK — emitting OTLP is a fold over the journal, exactly like `stats`.

## RPC (planned, ships when a real subscriber exists)

The core is commands-in, events-out; the CLI is one thin adapter and a JSON-RPC server is a second. A response is the immediate fact the caller needs; a notification is durable history for everyone; responses are not journaled, events are. Errors carry the teaching message in `error.message` and the code in `error.data.code`.

| Request | Result | Refusals |
| --- | --- | --- |
| `gitbay/hello` | version, capabilities, event names | — |
| `bay/open {name}` | bay, worktree, path, recycled | tracker-unknown, pool-exhausted |
| `bay/refresh` / `bay/close {ref}` | the bay record / snapshot + worktree pooled | unknown-bay / bay-dirty, pr-still-queued |
| `pr/submit {branch\|name}` | PR id, revision, queue position | pin-rewind, queue-full |
| `pr/integrate {pr?}` | `merged {sha}` \| `rejected {code}` \| `empty` | mergecommand-unset |
| `pr/retry` / `pr/approve` / `pr/reject` | PR id, new state | poison-retry / not-in-review |
| `gitbay/ls` / `stats` / `audit` | tables / counts / findings (read-only) | — |
| `gitbay/stream {cursor?}` | journal records to a live boundary, then tail | — |

`pr/integrate` is the long-running call: the response is the final outcome; progress streams as `pr/changed` notifications correlated by cause id — that's a span: request in, events during, response closes it. Two conventions adopted from the surrounding ecosystem: the `hello` capabilities handshake, and cursored stream replay with an explicit live boundary (race-free subscribe).
