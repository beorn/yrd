import { resolveYrdContext, stableJson } from "../../src/invocation.ts"
import { createYrdLogger, observeYrdLifecycle, type YrdObservabilityFlags } from "../../src/observability.ts"

export type ObservableCliInput = Readonly<{
  globals: Readonly<{ repo?: string }> & YrdObservabilityFlags
  env: Readonly<Record<string, string | undefined>>
  ambientCwd: string
  stdout: (text: string) => unknown
  stderr: (text: string) => unknown
}>

/** Minimal consumer exemplar: resolve one global context, create one logger,
 * keep machine output on stdout, and route diagnostics to host-owned sinks. */
export async function runObservableCli(input: ObservableCliInput): Promise<number> {
  const context = resolveYrdContext(input.globals, input.env, input.ambientCwd)
  const log = createYrdLogger(context.observability, input.stderr)
  try {
    await observeYrdLifecycle(log, { lifecycle: "resolve", attributes: { repo: context.repo } }, () => context.repo)
    input.stdout(stableJson({ repo: context.repo }))
    return 0
  } finally {
    log.end()
  }
}
