# gitbay roadmap & target design

Status: settled 2026-07-07. Companion to [vision.md](vision.md). This records the target design in enough detail to implement from; each section names its version. Current shipped surface is documented in the README.

## v0.3 — vocabulary completion

v0.2 renamed the merge unit to PR and the queue verb to `integrate`. v0.3 finishes the sweep:

- **`open` / `close`** become the advertised workspace verbs (`new`/`co`/`checkout` stay as hidden aliases). Bays are places you do work that gets integrated; they open and close.
- **Worktrees vs bays split.** Worktrees are numbered and persistent (`wt1`, pooled, recycled); bays are named and ephemeral (the loan of a worktree to one piece of work). `ls` shows both: the bay's work name and which worktree it's on. `close`/`refresh` accept either.
- **`init` stays** (git's own word); `install`/`setup` as hidden aliases.
- **`close` on a bay with a queued PR refuses and teaches** (integrate it, retry it, or `close --withdraw` to pull it). Withdrawing moves the PR to `abandoned` — the state exists; the verb into it is new.
- The `reviewing` state stays, reserved for the v0.5 review gate.

## v0.3 — event schema v2

The journal speaks four families, slash-namespaced, in settled vocabulary. Renaming events is expensive, adding is free — so this rename happens now, while journals are young, and later growth is additive.

```
gitbay/…      the system        initialized · refused {code} · audited {findings}
worktree/…    the directories   provisioned · deprovisioned {via}
bay/…         the loans         opened {worktree, recycled} · refreshed · closed {via}
pr/…          the work          opened {via} · changed {from, to, revision?, code?}
```

Dropped as non-events: queue-empty rows (state answers "is it empty now"; history doesn't need idle polls), sweep-completed rows (`prune` emits one `worktree/deprovisioned` per directory instead).

**The typed union is the real data model.** Each event name has an exact, closed payload; together they form a TypeScript discriminated union on `name`, so folds switch exhaustively and illegal payloads can't be constructed. No `Record<string, unknown>` at the domain layer.

**The envelope is deliberately generic**: `{ id, name, ts, cause, data }` — the part the journal file, the RPC transport, and exporters handle without domain knowledge. It coincides with CloudEvents (`id, type, time, data` + traceparent extension), which buys interop for free.

**Every rejection and refusal carries a machine-readable `code`** (kebab-case, from a closed union: `check-failed`, `mainline-dirty`, `merge-conflict`, `target-unresolved`, `lying-merge`, `merge-command-failed`, `push-race`, `pin-rewind`, `queue-full`, `poison-retry`, `tracker-unknown`, …). Building a rejection without a code throws. Codes are for counting; `detail` stays for humans.

## v0.3 — cause and trace context

Every command gets an id at the door (CLI and RPC alike); every event it produces carries `cause: {traceId, spanId}`. Mapping to OpenTelemetry:

- A command is a span; its final caused event ends it. Refusals map to span status `error` with the code as attribute.
- Journal events are span events; check steps are child spans with their own durations (the "why was integration slow" waterfall).
- PRs and bays are span *attributes* (`pr=PR7`), not traces — a PR's life crosses independent actors; its timeline is a query, with span links for retry chains.
- Propagation: `meta.traceparent` param on RPC requests; `TRACEPARENT` env var for the CLI. An agent's task trace contains its integrations as subtrees.
- Core never depends on an OTel SDK. Emitting OTLP is a fold over the journal, exactly like `stats` — run it live or replay it later.

## v0.4 — checks on lifecycle events

A committed `.gitbay.yml` holds multi-step checks in a deliberately small GitHub-Actions-shaped subset — familiar keys, `run:` steps only:

```yaml
checks:
  on-provision:                # once per worktree build (expensive setup)
    - name: deps
      run: bun install
  on-open: []                  # per loan (fast)
  on-push: []                  # at the receive door, before the PR exists
  on-submit:                   # speculative, on the submitter's bay
    - name: lint
      run: bun fix
  on-integrate:                # the gate, before each merge
    - name: typecheck
      run: tsc --noEmit
    - name: tests
      run: vitest run --changed
  on-merged: []                # follow-ups after a verified landing
```

Writing `uses:`, `matrix:`, or any other GHA key refuses with a teaching message ("gitbay runs plain `run:` steps; `uses:` needs real GitHub Actions") — a clearly-small subset beats a 10%-compatible dialect. `paths:` filters are in scope (changed paths are already computed for the pin guard). Each step journals its outcome with the step name, so `stats` shows failures by step.

This is also the migration path for host-specific merge commands: gates that today live inside a wrapper command move into `on-integrate` steps, and `bay.mergeCommand` shrinks toward just the merge.

## v0.4 — pooling and WIP limits

- **Pooling is on by default** (reuse is what makes the system scale; provisioning a worktree with dependencies can take minutes). `pool: { prewarm: N }` provisions ahead of demand; `pool: off` for fresh-every-time. Pool directories are gitbay-owned: work is snapshotted at close, then the directory is reset hard between tenants.
- **WIP limit** (`queue: { limit: N }`, off by default): when N PRs are already waiting, `submit` refuses at the door — "integrate before you open more" — journaled as `gitbay/refused {code: queue-full}`. Kanban backpressure against work piling up on stale branches.

## v0.5 — review gate

gitbay tracks review *state*, never review *content*. Opt-in (`review: required`, optionally `unless: paths`). When on: after checks pass, a PR enters `reviewing` and waits out of the queue's way. Two verbs are the entire integration surface for external tools:

- `git bay approve <PR>` / `git bay reject <PR> "reason"` — called by whoever reviewed: a human in an editor, an agent, a webhook bridge. Local single-trust-domain; the journal records who and why.
- An `on-reviewing` hook fires when a PR enters review — post the diff to a tool, message a reviewer, open a draft PR on a remote for human eyes.

Machine reviews that return in minutes don't need any of this — a synchronous review is just a check with opinions.

## v0.5 — JSON-RPC adapter

The core is commands-in, events-out; the CLI is one thin adapter over it. The RPC server is a second thin adapter — same core, no new semantics. Grammar: **imperative = request, past tense = event** (`bay/open` is the call, `bay/opened` is the fact). Slash namespacing throughout, matching the LSP/ACP/MCP convention family.

| Request | Response (result) | Refusals |
| --- | --- | --- |
| `gitbay/hello {}` | version, capabilities, event names | — |
| `gitbay/init {}` | state dir, owned-repo path | already-initialized |
| `bay/open {name}` | bay, worktree, path, recycled | tracker-unknown, pool-exhausted |
| `bay/refresh {ref}` | refreshed bay record | unknown-bay |
| `bay/close {ref}` | snapshot ref, worktree pooled | bay-dirty, pr-still-queued |
| `pr/submit {branch\|name}` | PR id, revision, queue position | pin-rewind, queue-full |
| `pr/integrate {pr?}` | `merged {sha}` \| `rejected {code, detail}` \| `empty` | mergecommand-unset |
| `pr/retry {pr}` | PR id, new revision, queue position | poison-retry |
| `pr/approve {pr}` / `pr/reject {pr, reason}` | PR id, new state | not-in-review |
| `gitbay/ls` / `stats` / `audit` | tables / counts / findings (read-only) | — |
| `gitbay/prune {}` | worktrees deprovisioned | — |
| `gitbay/stream {cursor?}` | journal records to a live boundary, then tail | — |

Rules: a response is the immediate fact the caller needs; a notification is durable history for everyone; responses are not journaled, events are. Errors carry the teaching message in `error.message` and the code in `error.data.code`. `pr/integrate` is the long-running call — the response is the final outcome; progress streams as `pr/changed` notifications correlated by cause id. Two conventions adopted from the surrounding protocol ecosystem: a `hello` capabilities handshake, and cursored stream replay with an explicit live boundary (race-free subscribe).

## Architecture — layers as with*() plugins (already true)

The era2 core already implements the composition model: `createBay()` is almost nothing, and every capability is a `with*()` layer composed with `pipe()`:

```ts
const bay = pipe(
  createBay({ store }),
  withWorkspaces({ mainRepo, bayRemote }),
  withQueue(),
  withMergeWorker({ mainRepo }),
  withReceive({ mainRepo, bayDir }),
  withAdopt(),
)
```

A `Layer` contributes up to three facets: `apply` (fold events into a state slice), `reduce` (command middleware via `next()`), and `effects` (async executors keyed by effect type). Journal-first dispatch is in the core beneath every layer: events are durable before effects run.

The facets are the capability model — new capabilities are new layers, described by which facets they use:

- **Observers** use `apply` only: `withStats()`, `withOtlp()`, an event-stream projector. They see everything and can change nothing.
- **Policies** use `reduce`: they may refuse a command with a code and a teaching message, and nothing else — `withWipLimit()`, `withReviewGate()`, the poison-retry guard.
- **Providers** use `effects`: they supply implementations for declared effect types — the worktree pool, the tracker check, the checks runner.

One known seam limitation, acceptable for now: effect handler lookup is first-registered-wins, so overriding a provider means ordering it earlier in the `pipe()` — replace, not wrap. Revisit if a real wrap-a-provider need appears.

Two laws hold the composition together: observers are read-only (telemetry can never influence an outcome), and no layer writes an event directly — everything goes through reduce/effects into the same journal, so history stays single and replayable. A startup canary (dispatch a no-op command, assert its event surfaces through the outermost layer) turns a chain-breaking layer into a boot failure instead of silent telemetry loss.

## Sequencing

1. **v0.3 vocabulary + events** (one change: verbs, worktree/bay split, event schema v2, typed union, envelope with cause) — everything after builds on the settled words.
2. **Observability slice** (codes on every rejection, poison-retry guard, journaled refusals, `stats`) — rewritten against v0.3 names.
3. **v0.4 checks file + pooling + WIP limits.**
4. **v0.5 review gate + JSON-RPC adapter** — the adapter ships when a real subscriber exists, so it's built against a consumer instead of a guess.

Batching (composing multiple queued PRs into one landing to save on checks) remains on the horizon past these; it lands inside gitbay's checks pipeline rather than passing through host wrappers.
