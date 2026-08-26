import type { Command as CliCommand } from "@silvery/commander"
import type { NormalizedYrdInvocation } from "../invocation.ts"
import type { RuntimeBootstrap } from "../run.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliServices } from "../types.ts"

/**
 * Everything a topic module needs to register its commands on the one program.
 *
 * `installed`/`installedServices`/`runtimeApp` are live accessors into
 * `buildProgram`'s runtime slots — the bootstrap preAction hook installs the
 * app after parsing, so registration-time captures must stay lazy.
 */
export type CommandRegistrationContext = Readonly<{
  program: CliCommand
  name: string
  io: YrdCliIO
  installed: () => YrdCliApp
  installedServices: () => YrdCliServices
  runtimeApp: () => YrdCliApp | undefined
  setExit: (code: YrdCliExitCode) => void
  invocation: NormalizedYrdInvocation
  bootstrap?: RuntimeBootstrap
}>
