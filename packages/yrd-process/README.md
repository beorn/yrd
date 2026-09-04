# `@yrd/process`

`@yrd/process` is Yrd's one subprocess boundary. It replaces package-specific
`Bun.spawn` wrappers with a plain `Process` object.

```ts
await using process = createProcess({ inject: { scope, log } })

const result = await process.run({
  argv: ["git", "status", "--porcelain"],
  cwd: repo,
  timeoutMs: 30_000,
  signal: job.signal,
})
```

`run()` always returns `exitCode`, `signal`, `stdout`, `stderr`, `durationMs`,
and `timedOut`. It executes argv directly without a shell.

Trusted configuration that intentionally needs shell syntax must opt in at the
call site:

```ts
await process.run({ argv: shellCommand("test -f dist/app.js && deploy dist") })
```

`shellCommand()` validates non-empty text and returns the explicit
`["sh", "-c", script]` argv. Process adapters and Git-facing code never build
shell strings from refs, branches, issue names, or other untrusted values.

The factory passes either its configured environment or the request's explicit
replacement environment. Domain adapters own policy such as stripping ambient
`GIT_*` and `YRD_*` variables. Every run gets a child Scope; parent disposal,
an explicit abort signal, and timeout all terminate the same child process.
Termination sends `SIGTERM`, then escalates to `SIGKILL` after a configurable
grace period (5 seconds by default). Timing and diagnostics use Loggily spans.

Hosts may set `maxOutputBytes` and `killGraceMs` when creating the Process.
Domain packages do not raise those limits locally or add a second process
wrapper.

## The output cap TRUNCATES; it never fails the run

Captured stdout and stderr each get an independent 16 MiB budget by default.
Running past it truncates the CAPTURE. It does not terminate the child, does not
throw, and does not change the exit status: a child's output VOLUME is not a
correctness signal, and killing the supervising process over it turns one
verbose test run into a fleet-wide outage. That is not hypothetical — while this
cap threw, a single chatty check restarted the habitant queue runner five times
in one day (257–261 on 2026-08-28, four of them `exit code 3`), losing whatever
check was in flight each time (`job-lost`) and destroying the very output that
would have explained it.

Truncation keeps a head and a tail — the head carries the setup and the first
failure, the tail carries the summary and the exit — and drops the middle. It is
never silent:

- The returned `stdout`/`stderr` carry a `[yrd: … truncated — N bytes dropped
  here. …]` notice, on its own lines, between the head and the tail. This is the
  copy a human reading a check verdict sees.
- `ProcessResult.outputTruncation` carries the same fact structurally, stdout
  before stderr, so machine consumers never match on the notice text.
- A `WARN` span entry names the argv and the byte counts.

Every byte still reaches `onOutput`, including the dropped ones, so a caller
that persists the live stream keeps the complete text — the queue's step
artifacts (`stdout.log`, `stderr.log`) are where the dropped middle can be read.
For the same reason the no-progress lease counts dropped bytes as progress: a
flooding child is the most active kind there is, and withholding its bytes would
have the stall detector kill exactly the process this truncation exists to let
finish.

Do not "fix" a truncated check by raising `maxOutputBytes`. That moves the cliff
rather than removing it, and the next flood finds it.

Tests and alternate hosts may inject `scope`, `log`, `now`, and `spawn`. Domain
packages receive a `Process`; they do not call `Bun.spawn` themselves.

## Retries and refusal latency

`git-super` retries a read-only Git call it detects as stalled. One queue run
makes roughly ninety sequential Git calls, and at a measured 20–40% per-call
stall rate against origin the chance that all ninety succeed is vanishing — that
compounding, rather than any queue defect, is why the queue could merge nothing
for hours (git-super `3652bfe`, 2026-08-21).

The cost is paid on genuine failures. A submodule that really is unreachable is
probed more than once before Yrd refuses, so refusal latency is a small multiple
of one probe's timeout. **If you are debugging a refusal that looks slow, that
multiple is expected and is not a hang.**

The retry count is git-super's policy, not Yrd's contract. Tests assert a
*bounded* number of probes rather than an exact one, so that this suite does not
carry a hand-synced copy of another package's constant.
