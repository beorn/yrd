# withIssueTracking — optional layer

Connects PRs to your issue tracker in both directions. Integration is git's own pattern — run a command; exit codes are verdicts, no SDK. A tracker hookup written in bash is first-class.

## Inbound: validate the name (shipped)

Every PR is for a named piece of work. When a validate command is configured, both front doors check the name against your tracker and refuse unknown names with a teaching message: `open`/`co` (before a worktree is provisioned) and `adopt`/`enqueue` when `--workitem` names one (a nameless adopt stays the audit-warned reconciliation ramp). The key is `bay.issues.validate`; `bay.tracker` remains as the deprecated spelling (`bay.issues.validate` wins when both are set):

```console
$ git config bay.issues.validate 'gh issue view {name}'
```

## Outbound: react to PR lifecycle (shipped)

The CLI host watches every dispatch for terminal `pr/changed` events (merged / rejected / closed) on a named PR and runs your command for that state — with substitutions for `{name}`, `{pr}`, `{sha}`, `{code}`, `{detail}`:

```console
$ git config bay.issues.on-merged   'gh issue close {name} --comment "merged as {sha} ({pr})"'
$ git config bay.issues.on-rejected 'gh issue comment {name} --body "PR {pr} rejected: {code} — {detail}"'
$ git config bay.issues.on-closed   'gh issue comment {name} --body "PR {pr} withdrawn"'
```

`{sha}` on merged is machine-truth: the verified landed tip the lying-merge guard proved an ancestor of the mainline, carried structurally on the `pr/changed` event — never parsed out of detail prose. A template that references a substitution the event cannot supply (e.g. `{sha}` on rejected) is journaled as a failed notification naming the mismatch, not silently emptied.

A failed command NEVER fails the verb that triggered it — the merge already happened. It prints loud to stderr and lands in the journal as `issues/notified` with the command's exit code, so a failed close shows up in `stats` instead of vanishing. Notification is at-least-attempted, not guaranteed delivery: the journal is the authoritative record, so a tracker that was down can be reconciled from `pr/changed` events later.

**Auto-close works structurally, not by parsing prose.** GitHub must scan descriptions for "fixes #123"; gitbay already knows the issue — the PR carries the validated name from `open`. Command outcomes are journaled, so a failed close shows up in `stats` instead of vanishing.

Policy stays in your commands, deliberately:

- Merged closes the issue; closed-by-withdrawal only comments (withdrawn work is still open work).
- "Merged" fires after the verified local merge. If your merge command also publishes, merged ≈ shipped and closing on it is sound; if you publish later, make `on-merged` verify (`git merge-base --is-ancestor {sha} origin/main`) and comment until then.
- Teams that gate closes on a human can make `on-merged` file a close *request* with the SHA as evidence.

Later, additively: commit-trailer scanning ("fixes X" across a PR's commits) for the many-issues-per-PR case.
