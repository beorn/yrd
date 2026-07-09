# Yrd — the staged identity transition

**Yrd** is the software delivery yard this repo is becoming: tasks, bays, lines, and contest-mode agent evaluation. **Git Bay stays what it is** — the Git-native bay implementation and the `git bay` surface — but as the bay component of Yrd rather than the whole product identity.

## What is available today (slice 1)

- `yrd bay <verb>` — the yard entrypoint over the same git-bay CLI (`bin/yrd.ts`). Not a fork: it re-enters `bin/git-bay.ts` with identical parsing.
- `git yrd <verb>` — alias of `git bay <verb>` (`bin/git-yrd.ts` on PATH makes it a git subcommand).
- Every existing `git bay` verb, hook, and workflow keeps working unchanged.

## What changed in slice 2

- **Repo rename complete**: the GitHub repo is now `beorn/yrd`; old `beorn/gitbay` URLs redirect.
- **Package repository metadata updated**: `package.json` now points at `github:beorn/yrd`.
- **Compatibility commands remain installed**: `yrd` and `git-yrd` are the primary Yrd-facing bins; `git-bay` and `gitbay` stay as compatibility bins over the same implementation.

## What is staged, not done

- **Package rename (`git-bay` → yrd-scoped names)**: consumers depend on the package NAME, so the rename and every consumer update must move in one coordinated slice.
- **Consuming-repo moves** (re-homing this repo's checkout path, renaming planning documents): owned by each consuming repo on its own schedule; this repo only guarantees that old (`git bay`) and new (`yrd bay`) surfaces stay equivalent through the transition.
- **Projections `line`, `task`, `contest`**: arrive with the Yrd monorepo transition; `yrd` names them as staged so the CLI shape is stable from day one.

## Rule for future work

`yrd bay` and `git bay` must stay the SAME implementation. If they ever diverge, that is a bug in the transition, not a feature.
