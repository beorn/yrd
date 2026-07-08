# withReviewGate — optional layer (planned, v0.5)

gitbay tracks review *state*, never review *content*. No comments, no threads, no diff UI — that's your review tool's job. What gitbay owns: the fact that a PR needs approval, has it or doesn't, and what happens next. Off by default; a local tool's default posture is velocity.

## How it works

When enabled (`review: required`, optionally with path filters), a PR that passes checks enters the `reviewing` state and waits out of the queue's way. Checks run first so reviewers never spend attention on a red PR.

Two verbs are the entire inbound surface for any review tool:

- `git bay approve <PR>` / `git bay reject <PR> "reason"` — called by whoever reviewed: a human in an editor, an agent, a webhook bridge. Everything is local and single-trust-domain, so there's no auth ceremony; the journal records who and why.

One outbound hook: a configured command runs when a PR enters review — post the diff to your tool, message a reviewer, open a draft PR on a remote for human eyes.

```yaml
review:
  required: true
  on-reviewing: my-notify-command {pr}
```

## Sync reviews don't need this

A machine review that returns in minutes (an AI reviewer, lint-with-judgment) is just a *check with opinions* — run it as an `integrate` check and its exit code is the verdict. The review gate exists for the async case: reviews that take hours, where a blocking check is the wrong shape.
