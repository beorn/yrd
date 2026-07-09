import { repoScopedCleanEnv } from "./env.ts"

const RETIRED_PLACEHOLDERS = {
  "{name}": "$YRD_TASK",
  "{pr}": "$YRD_PR",
  "{changeset}": "$YRD_PR",
  "{sha}": "$YRD_SHA",
  "{code}": "$YRD_CODE",
  "{detail}": "$YRD_DETAIL",
  "{target}": "$YRD_TARGET",
  "{base}": "$YRD_BASE",
  "{batch}": "$YRD_BATCH",
  "{member}": "$YRD_MEMBER",
} as const

export type YrdCommandVariable =
  | "YRD_BASE"
  | "YRD_BASE_SHA"
  | "YRD_BATCH"
  | "YRD_CODE"
  | "YRD_CONTEST_ATTEMPT"
  | "YRD_DETAIL"
  | "YRD_AGENT"
  | "YRD_BAY"
  | "YRD_MEMBER"
  | "YRD_MEMBER_TARGET"
  | "YRD_PR"
  | "YRD_PROMPT"
  | "YRD_SCRATCH_PATH"
  | "YRD_SCRATCH_REF"
  | "YRD_SHA"
  | "YRD_TARGET"
  | "YRD_TARGET_REF"
  | "YRD_TASK"

export type ConfiguredCommandResult = {
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
}

export type ConfiguredCommandOptions = {
  command: string
  cwd: string
  purpose: string
  variables?: Partial<Record<YrdCommandVariable, string | undefined>>
}

/**
 * Run user-authored shell source without ever rendering runtime data into it.
 * The command is configuration; task, ref, verdict, and artifact values are
 * data and cross the process boundary only through explicit YRD_* variables.
 */
export async function runConfiguredCommand(options: ConfiguredCommandOptions): Promise<ConfiguredCommandResult> {
  for (const [placeholder, replacement] of Object.entries(RETIRED_PLACEHOLDERS)) {
    if (options.command.includes(placeholder)) {
      throw new Error(`yrd: ${options.purpose} command placeholder ${placeholder} is retired; use ${replacement}`)
    }
  }

  const env = repoScopedCleanEnv()
  for (const key of Object.keys(env)) {
    if (key.startsWith("YRD_")) delete env[key]
  }
  for (const [key, value] of Object.entries(options.variables ?? {})) {
    if (value !== undefined) env[key] = value
  }

  const startedAt = Date.now()
  const proc = Bun.spawn(["sh", "-c", options.command], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, durationMs: Date.now() - startedAt, stdout, stderr }
}
