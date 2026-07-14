# Observable CLI exemplar

This tiny consumer shows the Yrd CLI host pattern:

1. Parse repository and logging globals into one `YrdContext` with
   `resolveYrdContext`.
2. Create exactly one root logger with `createYrdLogger`.
3. Write command results to stdout and diagnostics to stderr or
   `LOGGILY_FILE`.
4. Reuse delivery identities when observing lifecycle work; never mint a
   parallel tracing identity or journal event.

The executable Yrd acceptance in `tests/observability.test.ts` proves that
`-vvv --json` keeps stdout parseable while stderr and the JSONL file retain
the structured lifecycle record.
