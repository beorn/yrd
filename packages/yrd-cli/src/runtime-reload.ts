import { createFailure } from "@yrd/core"

type YrdProcessExecve = (execPath: string, argv: readonly string[], env: NodeJS.ProcessEnv) => never

/** Close every process-owned resource before replacing the resident image.
 * Successful execve never returns and preserves the OS pid. */
export async function execYrdProcessInPlace(
  input: Readonly<{
    closeRuntime(): Promise<void>
    removeShutdownSignals(): void
    closeLog(): void
    execPath: string
    argv: readonly string[]
    env: NodeJS.ProcessEnv
    execve: YrdProcessExecve
  }>,
): Promise<never> {
  await input.closeRuntime()
  input.removeShutdownSignals()
  input.closeLog()
  try {
    return input.execve(input.execPath, input.argv, input.env)
  } catch (error) {
    throw createFailure(
      {
        kind: "infrastructure",
        code: "runtime-reload-exec-failed",
        message: `yrd: resident runtime reload failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      error,
    )
  }
}
