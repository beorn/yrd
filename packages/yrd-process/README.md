# `@yrd/process`

`@yrd/process` is Yrd's one subprocess boundary. It replaces package-specific
`Bun.spawn` wrappers with a plain `Process` object.

```ts
await using process = createProcess({ inject: { scope, log } })

const result = await process.run({
  argv: ["git", "status", "--porcelain"],
  cwd: repo,
  timeoutMs: 30_000,
})
```

`run()` always returns `exitCode`, `signal`, `stdout`, `stderr`, `durationMs`,
and `timedOut`. It executes argv directly without a shell.

The factory removes inherited `GIT_*` and `YRD_*` variables, then applies the
request's explicit environment. Every run gets a child Scope; timeout,
cancellation, and process termination therefore share one lifecycle. Timing
and diagnostics use Loggily spans.

Tests and alternate hosts may inject `scope`, `log`, `now`, and `spawn`. Domain
packages receive a `Process`; they do not call `Bun.spawn` themselves.
