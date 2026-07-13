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
grace period (5 seconds by default). Captured stdout and stderr are each bounded
to 16 MiB by default; exceeding either limit terminates the child and rejects
the run. Timing and diagnostics use Loggily spans.

Hosts may set `maxOutputBytes` and `killGraceMs` when creating the Process.
Domain packages do not raise those limits locally or add a second process
wrapper.

Tests and alternate hosts may inject `scope`, `log`, `now`, and `spawn`. Domain
packages receive a `Process`; they do not call `Bun.spawn` themselves.
