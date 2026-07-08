# Events, requests, and telemetry

One naming grammar covers the journal, the future RPC surface, and telemetry: **imperative = request, past tense = event.** `bay/open` is the call; `bay/opened` is the fact. Slash namespacing throughout (the LSP/ACP/MCP convention family). Shipped in v0.3 — a pre-v0.3 journal (dotted names — `lease.opened`, `pr.state-changed`, …) needs the one-shot migration (`git bay migrate-journal`) before anything reads it; there is no dual-read shim.

## The event families

```
gitbay/…      the system        initialized · refused {code, detail} · audited {findings}
worktree/…    the directories   provisioned · deprovisioned {via}
bay/…         the loans         opened {worktree, recycled} · refreshed · closed {via}
pr/…          the work          opened {via, queued} · changed {from, to, revision?, code?, sha?} — sha rides merged transitions: the verified landed tip
queue/…       the order         reordered {order, detail?} — partial order; omitted PRs keep their relative place after the listed ids
line/step/…   the step runs     started · finished {ok, detail?} — one pair per check/merge run against a target tree (serial PR, batch candidate, bisect prefix with role "prefix", baseline with role "baseline"); `step` is a payload field so the union stays closed; `waiting` is reserved for async steps
line/batch/…  the candidates    started {target?, members, ejected, prefixes, skipped} · isolated {outcome: ejected|refused, reason, detail} · finished {members, landedSha?}
issues/…      the tracker       notified {name, on, command, code, detail?} — the configured bay.issues.on-<state> ran for a named PR; code is ITS exit (a failed notify journals too — it must not vanish)
```

An empty batch compose (no submitted PRs at all) is a non-event, exactly like the empty integrate run below — the CLI derives "nothing to batch" from the silent dispatch.

Batch member outcomes are journal truth, not fold inference: when a candidate lands, settle emits one `pr/changed {from: "checking", to: "merged", sha: <compose-time member tip>}` per member plus one `line/batch/finished` summary — replay consumers (stats) never have to infer member fates from the candidate's event. `line/batch/isolated {outcome: "refused"}` is the journaled verdict when red-batch recovery stops WITHOUT ejecting anyone: `baseline-red` (the gate fails on the untouched batch base — an environment/mainline fault; the walk never starts), `all-green` (the per-member gate contradicts the red batch gate), or `provision-failed` (a gate scratch could not be provisioned via `bay.provision`); `{outcome: "ejected"}` carries every real ejection (`build-conflict` at compose, `gate-red` at bisect). Refusals used to be throws that discarded the walk evidence; now the walk's `line/step` rows and the verdict survive in the journal. `line/step/started`/`finished` pairs are run-records for EVERY step run — serial and batch alike — so per-step runtime and failure rates fold straight out of the journal; nothing folds them into state.

A PR is born `pushed` (a push, or `git bay adopt <branch>`) and moves to `submitted` only when asked to merge — `git bay submit <PR>`, or a push fused with `bay.autoSubmit`, a forcing `-o submit`/`-o wait`, or legacy `bay.autoQueue`. `pr/opened`'s `queued` field (a literal boolean, its name predates the phase rename) says which: true for a fused creation (the fold plants it straight into `submitted`, no separate transition event); false for a bare creation, in which case a later `pr/changed {from: "pushed", to: "submitted"}` records the explicit ask. Whether a submitted PR then ALSO auto-integrates to `merged` is the separate `bay.autoMerge` decision (docs/model.md § The auto-flow) — not recorded on `queued`.

Non-events are deliberately not journaled: an empty integrate run, a prune that removed nothing, a repeat push to a still-`pushed` PR that isn't asking to submit. Every rejection carries a machine-readable kebab-case `code` from a closed union (`merge-conflict`, `lying-merge`, `pin-rewind`, `queue-full`, `poison-retry`, …); building a rejection without a code throws. Codes are for counting; `detail` stays for humans. Status (open/merged/closed) is never itself an event — it's derived from phase (docs/model.md § Status), so nothing journals a `pr/opened` or `pr/changed` for "became open."

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
| `pr/adopt {branch\|name}` | PR id, revision, phase: pushed | pin-rewind |
| `pr/submit {pr}` | PR id, phase: submitted, queue position | pr-not-pushed, queue-full |
| `pr/integrate {pr?}` | `merged {sha}` \| `rejected {code}` \| `empty` | mergecommand-unset |
| `pr/retry` / `pr/approve` / `pr/reject` | PR id, new state | poison-retry / not-in-review |
| `gitbay/ls` / `stats` / `audit` | tables / counts / findings (read-only) | — |
| `gitbay/stream {cursor?}` | journal records to a live boundary, then tail | — |

`pr/integrate` is the long-running call: the response is the final outcome; progress streams as `pr/changed` notifications correlated by cause id — that's a span: request in, events during, response closes it. Two conventions adopted from the surrounding ecosystem: the `hello` capabilities handshake, and cursored stream replay with an explicit live boundary (race-free subscribe).
