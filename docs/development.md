# Developing Yrd

Yrd needs Bun and Git. The queue runs as one process on one machine, as the user who starts it, and a check is whatever command the config names, run as that user.

## Packages

| Package                   | What it is                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/yrd-queue-core` | the queue: submit, reading the queue, the round, checks, records                                |
| `packages/yrd-cli`        | the commands                                                                                    |
| `packages/yrd-process`    | running commands and Git: checkouts, time limits, and reading which processes still hold a path |
| `packages/yrd-bay`        | `yrd env`: a checkout of one branch for a person or an agent to work in                         |

`tests/boundary` tests the queue from the outside, the way a user sees it: real repositories, real pushes, real checks in their own checkouts.

## Commands

```console
$ bun install --frozen-lockfile
$ bun run typecheck
$ bun fix                                              # lint and format
$ bun run test packages/yrd-cli/tests/env-open.test.ts # one test file
$ bun run check                                        # typecheck and the default test suite
```

## Why the queue skips repository hooks

The queue's own Git operations (settling the base, moving gitlinks forward, the final merge) run with an empty `core.hooksPath`. This is a deliberate isolation boundary, not a shortcut.

- `--no-verify` is not a substitute: on Git 2.55 it does not stop `prepare-commit-msg` or `post-commit`, and it does not reach child Git processes.
- Starting `git super` with `git -c core.hooksPath=<empty-dir>` passes the setting to its child Git commands through `GIT_CONFIG_PARAMETERS`.
- Repository hooks check work a person authored. The queue's commits are derived, and checks on them belong in `.yrd.yml`.

Yrd is developed inside a larger superproject that runs Yrd on itself.
