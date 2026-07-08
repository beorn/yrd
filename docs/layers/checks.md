# withChecks — optional layer

Runs your configured commands at lifecycle points and journals each verdict. The mechanism is settled; the multi-step config file format is deliberately not (see the last section).

## Shipped today

Two git-config commands: `bay.check` (runs on the submitter's bay when a PR is queued for merge — whether by `git bay submit`, or a push fused with `-o submit`/`-o wait`/`bay.autoQueue`; exit 0 = pass) and `bay.mergeCommand` (repositories with their own merge process route the merge itself through a command; used by `integrate`). A merge command's exit code is never taken on faith — a PR only counts as merged when it is provably an ancestor of the refreshed main branch.

## Planned: checks on lifecycle events

One command (or later, steps) per hook point:

- `provision` — once per worktree build (dependency install, direnv) — this is what makes pooling fast to *re*-enter
- `open` — per loan, fast setup
- `push` — at the receive door, before the PR exists (cheapest refusals, taught at push time; runs whether or not the push queues)
- `queue` — speculative, on the submitter's bay, when a PR is asked to merge (today's `bay.check`)
- `integrate` — the gate before each merge
- `merged` — follow-ups after a verified landing

Each run journals `{step, exit, duration}` against the PR, so `stats` shows failures by step and spans show where integration time goes.

## The config format question (open)

Single commands per hook point ship first and may be enough. If multi-step config proves necessary, the candidate shape is a deliberately small GitHub-Actions-familiar subset — `name:` + `run:` steps only, `paths:` filters, and a teaching refusal for `uses:`/`matrix:` ("gitbay runs plain run: steps; uses: needs real GitHub Actions") — a clearly-small subset beats a 10%-compatible dialect. Not committed; watch the roadmap.
