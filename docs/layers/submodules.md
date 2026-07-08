# withSubmodules — core layer, auto-armed

Super-repo safety. Armed automatically when `.gitmodules` exists; repositories without submodules never pay for it.

## What it guards (shipped today, currently inside the receive/hook layers)

- **Pin-rewind refusal at the push door**: a submodule pointer (gitlink) that would move backwards — orphaning commits that already landed — is refused with a teaching message before the PR exists. This is the lost-work class that motivated the tool.
- **Commit-time guard**: the bay worktree's hooks refuse a stale submodule pointer at `git commit`, before a push is even attempted. Client hooks teach early; the receive door is the correctness floor (it cannot be bypassed by client config).
- **Atomic landings**: a parent-repo commit and its submodule commits travel as one PR and land together or not at all; the merge command pushes superproject and touched submodules as one unit.
- **`audit`**: finds unreachable pins and stray submodule commits.

## Planned

Split into an explicit `withSubmodules()` layer (a door policy + audit contributions), so the pin logic is visibly one unit and single-repo compositions can verifiably exclude it. Behavior unchanged; this is a factoring move.

## Events

Refusals journal as `gitbay/refused {code: pin-rewind}` — countable in `stats` like every other door.
