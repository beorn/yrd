# The config, `.yrd.yml`, in detail

The config is a file on the queue branch. Each round captures one commit of the queue branch and uses it for both the config and the base, so a later change to the file takes effect on the next round. The config never comes from the change, so a branch cannot change the checks that judge it.

## Every key

```yml
setup: bun install --frozen-lockfile # runs once in every fresh checkout the queue makes, before any check
admission: # optional pre-submit command, run in a clean checkout of the queue branch
  run: bun tools/admission.ts
  timeoutMs: 15000 # required; covers the command itself, not preparing the checkout
checks:
  - typecheck: # each check is one mapping of its name to its settings
      run: bun "$YRD_PROGRAM_ROOT/tools/typecheck.ts"
      on: [submit, merge] # submit: the change alone; merge: its merge with the queue branch; default: merge
      timeoutMs: 1800000 # default: 30 minutes
      scripts: [tools/typecheck.ts] # must exist in the queue branch's copy; the change's copy is left alone
      environmentPassthrough: [GITHUB_TOKEN]
      programRoot: true # also give the check the queue branch's program at $YRD_PROGRAM_ROOT
notify: # the same shape as checks: a name, when it runs, what runs
  - submitter:
      on: [merged, failed, cancelled] # default: merged, failed, stuck, merged-direct, cancelled
      run: bun tools/notify.ts # gets the record as one JSON object on stdin
  - supervisor:
      on: [stuck, merged-direct]
      run: bun tools/notify.ts --to ops
  - admission-supervisor:
      on: admission-warning
      run: bun tools/notify.ts --to ops
issuesProvider:
  update: [issues, catchup, --json] # optional command run after each merge
health:
  stallAfter: 45m # waiting changes with none judged for this long is a stalled line; at least 10m
```

Rules about the file itself:

- Running the queue refuses a top-level key it does not read. Read-only tools (addressing, history) can opt into a `newerKeys` callback that reports unknown top-level keys and skips them. Retired keys and unknown nested fields still refuse.
- `target:` and `remote:` are refused: the queue is the branch that carries the file, chosen with `--queue`.
- The machine's storage path is Git configuration (`yrd.workdir`), not part of this file. See [operations.md](operations.md#where-things-are).
- The retired `issuesProvider.read` key is ignored with a message naming its replacement, `issues.yml`.

## The check environment

A check's environment is built, not inherited. It gets:

- `YRD_CANDIDATE_SHA`: the exact commit being judged. That is the change's head on submit, the prospective merge commit on merge, or the queue branch for a check of the queue branch itself.
- `YRD_BASE_SHA`: that commit's merge base with the queue branch.
- `YRD_REPO`: the path of the fresh checkout.
- `PATH`, `HOME`, `SHELL`, `LANG`, `USER`, `LOGNAME`, `LC_*`, and a `TMPDIR` under the queue's work directory.
- The variables named in `environmentPassthrough`.

`programRoot: true` gives a check the queue branch's own program as well as the fresh checkout. The check names `$YRD_PROGRAM_ROOT` in its command, and the queue sets it last, so no passed-through value can replace it. Without `programRoot`, a check gets no `YRD_PROGRAM_ROOT`; the name is reserved either way. This limits what the queue supplies, not what an arbitrary shell command can read.

## Admission

`admission` runs at submit time, before anything is pushed, in a clean checkout of the queue branch. It runs the queue branch's copy even if the submitted branch edits the script, and it runs without `setup:`.

- It receives `YRD_ADMISSION_ISSUE`, `YRD_ADMISSION_BRANCH` and `YRD_ADMISSION_HEAD`.
- Exit 0 admits. Exit 1 refuses, and its stdout is shown as the cure. Exit 3 warns with its stdout and still admits.
- Any other exit, a signal, a timeout or a failure to run is "cannot judge". The submit goes ahead and records an `admission-warning` event, once per change and reason. A new warning runs the `notify` entry for `admission-warning` once; a missing entry or failed delivery is reported on stderr.
- `--dry-run` runs admission and reports its verdict without publishing.
- Stdout is read as text: whitespace and line breaks are kept, invalid UTF-8 becomes replacement characters, and empty output gets an explicit message.
- If the queue branch moves between reading `.yrd.yml` and running admission, submit refuses and asks for a retry, so a newer policy never runs with an older config.
- Changes with no issue skip admission and say so.

## After a merge: `issuesProvider.update`

After a merge round releases its lock, Yrd runs `update` with exactly the configured arguments, then runs its normal branch cleanup even if the command failed.

- It passes nothing about the merge: no range, no merge arguments, no stdin, no environment facts. The command finds its own position.
- It has a 120-second limit, separate from the 10-second issue display reads. A stuck command does not hold up later rounds.
- The service runs one attempt at a time and coalesces the rest into one pending catch-up. Startup schedules one fresh catch-up.
- Each attempt writes `<workdir>/post-merge/*.json` with its stdout and stderr logs, command, times, exit and timeout. These are for inspection only; no later decision reads them.

## Notifications

Every ending runs the `notify` entries whose `on:` lists it. The command gets the record as one JSON object on stdin, and chooses its own recipients and text.

**The record.**

- `record` names the ending: `merged`, `failed`, `stuck`, `merged-direct` or `cancelled`.
- `endingId` identifies this ending: its event ID (or, in an older queue, the ID of its ending record).
- `endedAt` is that ending's ISO time with a zone. Records written before this field existed use their commit time.
- `change`, `submitter` and `issue` appear when known. A failed record adds `reason`, `log` and the branch's `failures` count; a merged record adds `merge`.

**Delivery.**

- Exit 0 means delivered.
- Exit 4 means the transport answered and refused, with the reason on the last line of stdout. The record says `Not-Told: <name> refused=<reason>`, and that name is never sent for this ending again.
- Any other exit, a timeout, or a command that could not run gets one more try on the next round. If that fails too, the record says `Not-Told: <name> undelivered=<why>`, and `yrd list` names the queue operator as the next step.
- Delivery is at least once. A crash can hide a result and cause a retry, so every `notify` command must accept a repeat for the same change and ending. A retry carries the same `endingId`.
- Removing an entry stops it; a newly added entry is still told. An ending with no matching entries records `none` once.

**Other records.**

- `cancelled` is sent when the queue itself cancels a change because its remote branch is gone. An explicit `yrd drop` or `yrd queue withdraw` sends nothing.
- `admission-warning`: see [Admission](#admission).
- `observed` (opt in with `on: [observed]`): a notice from the submodule tool about the child repositories, as `{ "record": "observed", "notice": { "id": "…", "text": "…" } }`. It can repeat on later rounds.
- `retired-root-written`: the service found a new file under an old, retired queue directory spelling (`<root>/<host>/<path>%23<queue>`). It carries `root`, `address`, `path`, `writtenAt`, `cutover` (when the old spelling was retired), `branches` and `active`; `active: false` clears it once the newest write is a day old. The service only reads that directory, never deletes it.
