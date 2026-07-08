# Architecture

gitbay is an event-sourced core with `with*()` layers over two injected seams. The core is almost nothing on its own: a journal, a state fold, and a dispatch loop. Everything else is a layer that adds verbs, events, a state slice, and effect handlers, composed with `pipe()`. Two things the core depends on but does not implement are injected at construction — the **store** (where PR and queue records live) and the **SCM** (where code lives).

```ts
const gitbay = pipe(
  createGitbay({ store, scm }),   // the two seams, injected
  withWorktrees({ pool }),
  withQueue(), withReceive(), withIntegrate(),
  withSubmodules(),               // auto-armed when the SCM reports sub-components
  withIssueTracking(config.issues),
  withChecks(config.checks),
  withReviewGate(config.review),
  withStats(),
)
```

## Two orthogonal seams

The store and the SCM are independent axes. The store answers "where do PR records and queue order live"; the SCM answers "where do the commits live." You can mix them: `store: km + scm: git`, or `store: github + scm: git`. They are not the same question — a GitHub store keeps the PR *record*; the *code* is still in git.

### The store seam

Detailed in [store.md](store.md). PRs live in exactly one store; there is no mirroring between stores. Interface is small (~6 methods: get/put/list PRs and worktrees, in queue order; journal append/replay). Adapters are about a page: `sqlite` (default, zero deps), `km` (PRs as nodes, queue order = tree order), `github` (PRs *are* GitHub PRs). The store owns record authority; the JSONL journal is history and audit in every store.

### The SCM seam

Every layer's effects ultimately touch the repository, so the SCM cannot be a layer among the others — it is injected underneath them. Layers call `scm.<verb>` instead of shelling a VCS directly. The seam is drawn at the level of **intent, not commands**, which is what lets more than one VCS implement it:

- `openWorkspace(name)` — a directory where work happens (git worktree, jj workspace)
- `receiveSubmission()` — take a bundle of work with an identity; the git adapter realizes this with a bay-owned bare repo + pre-receive hook, but that mechanism is an adapter detail, not part of the interface
- `changedPaths(submission, base)` — for path-filtered checks and the pin guard
- `integrate(submission, mainline) → { clean | conflicted, resultId }` — conflict is a **result, not an exit code**
- `isLanded(revision, mainline)` — proves a landing (kills the lying-merge class)
- `refresh(workspace, mainline)` — rebase/rebuild a workspace onto current mainline
- optional `authoringGuard` — a client-side pre-commit check; optional because the receiver is the correctness floor (a VCS with no commit step, like jj, simply omits it)
- optional `components` — sub-repository / submodule handling (see below)

Three design rules keep the seam VCS-neutral, and each is better design even if git is the only backend forever:

1. **Conflict is a first-class result.** git merges fail with an exit code; jj merges succeed and record the conflict. An interface that returns `{ clean | conflicted }` fits both; one that returns pass/fail bakes in git.
2. **Revision handles are opaque.** A PR keeps gitbay's own sequential number (PR7), mapped to whatever the backend calls a revision — a git branch+SHA, a jj change-id. The domain layer never sees a SHA.
3. **Authoring guards are optional; the receiver refuses last.** Client-side commit hooks teach early but correctness never depends on them, so a backend without a commit step loses nothing essential.

**This is a thick seam, not a thin one.** Unlike the store's one-page adapters, a real SCM adapter is substantial — the git adapter carries receive-pack wiring, hooks, and submodule recursion, and it sits on the hot path. The payoff beyond a second backend is testing: with the SCM behind an interface, the queue, checks, and review logic can run against an in-memory fake instead of real repository fixtures.

**Status: git is the only implemented backend.** The seam is designed-for, not multi-backend-built. A jj adapter is possible by construction (jj is closer to gitbay's model than git — stable change-ids are revisions, its operation log rhymes with the journal, conflict-tolerant rebase makes `refresh` never block), but ships only when jj is a real consumer with an answer for sub-components.

## Sub-components (super-repos)

`withSubmodules` is a core layer, auto-armed when the SCM reports that the repository has sub-components. For git that means submodules: a parent commit and its submodule commits land together or not at all, a pointer that would move backwards is refused, and `audit` finds stale pins. This is the leakiest part of the SCM seam — sub-component support is a per-backend capability, and a backend that lacks it (single-repo git, or jj today) simply reports none and the layer stays dormant. See [layers/submodules.md](layers/submodules.md).

## The command tree

Verbs are defined once as a command tree; the CLI, a JSON-RPC surface, and the programmatic API are projections of it. Layers contribute commands; a command's `run` builds a request and dispatches it into the same core. Adapters own only presentation — the CLI keeps prefix resolution, hidden aliases, and help formatting; the RPC surface keeps its handshake and stream endpoint. The naming grammar is uniform: imperative is a request (`bay/open`), past tense is an event (`bay/opened`) — see [events.md](events.md).
