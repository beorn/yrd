# The store — a core seam, not a layer

PRs live in exactly one store. Every layer's records live in it, so it can't be middleware among the layers — it's the constructor seam: `createGitbay({ store })`. Switching stores is one config line; there is no mirroring or projection between stores, by design (two representations with neither authoritative is the worst outcome).

```yaml
store: sqlite   # default — records in .git/bay/bay.db, zero dependencies
```

```yaml
store: km       # PRs are nodes in a km vault: queue order = tree order, issues linked by name
```

## What a store owns

The store is the **authority for records and their order**: `prs.get/put/list(inQueueOrder)`, `worktrees.get/put/list`. Each kind answers "what's the queue order" its own way — sqlite by an index column, a tree-shaped store by node position, which makes "move this PR up the queue" an ordinary edit in that system. The append-only **journal stays gitbay's flight recorder** in every store (jsonl, cheap appends on the hot path): it's history and audit, not authority.

Note this is the interesting half of "are PRs what we queue?" — yes: there is no separate queue entity. The queue is the PRs currently in state `queued`, in order. A pluggable queue store is a pluggable PR store.

## The one-page rule

gitbay defines the store interface (~6 methods) and ships sqlite as the battery-included default. Other adapters live with *their* system (the km adapter ships on the km side, implementing gitbay's interface — dependencies point toward gitbay, never from it), and `store: <name>` resolves them. An adapter is about a page of code; if a third store (postgres, a team server) takes more than a page, the interface has failed and gets shrunk.

## Everything above the seam is store-blind

`ls`, `stats`, the RPC surface, auto-close observers — all read through the interface and can't tell the difference. With a km-backed store the issue linkage gets shorter (a PR node links its issue; closing-with-evidence is writing to a sibling node), but nothing in gitbay knows or cares.
