# withIssueTracking — optional layer

Connects PRs to your issue tracker in both directions. Integration is git's own pattern — run a command; exit codes are verdicts, no SDK. A tracker hookup written in bash is first-class.

## Inbound: validate the name (shipped today)

Every bay is opened for a named piece of work. When a validate command is configured, `open` checks the name against your tracker and refuses unknown names with a teaching message. Today this is `git config bay.tracker '<command with {name}>'`; it becomes the `issues.validate` key when configuration unifies (see roadmap).

## Outbound: react to PR lifecycle (planned)

The layer observes `pr/changed` and runs your command when a PR reaches a state you care about — with substitutions for `{name}`, `{pr}`, `{sha}`, `{code}`, `{detail}`:

```yaml
issues:
  validate:     gh issue view {name}
  on-merged:    gh issue close {name} --comment "merged as {sha} ({pr})"
  on-rejected:  gh issue comment {name} --body "PR {pr} rejected: {code} — {detail}"
  on-closed:    gh issue comment {name} --body "PR {pr} withdrawn"
```

**Auto-close works structurally, not by parsing prose.** GitHub must scan descriptions for "fixes #123"; gitbay already knows the issue — the PR carries the validated name from `open`. Command outcomes are journaled, so a failed close shows up in `stats` instead of vanishing.

Policy stays in your commands, deliberately:

- Merged closes the issue; closed-by-withdrawal only comments (withdrawn work is still open work).
- "Merged" fires after the verified local merge. If your merge command also publishes, merged ≈ shipped and closing on it is sound; if you publish later, make `on-merged` verify (`git merge-base --is-ancestor {sha} origin/main`) and comment until then.
- Teams that gate closes on a human can make `on-merged` file a close *request* with the SHA as evidence.

Later, additively: commit-trailer scanning ("fixes X" across a PR's commits) for the many-issues-per-PR case.
