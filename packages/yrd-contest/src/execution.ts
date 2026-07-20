import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { JsonValue } from "@yrd/core"
import type { JobResult } from "@yrd/job"
import type { Process, ProcessRequest, ProcessResult } from "@yrd/process"
import type { ContestArtifact } from "./types.ts"

export type Failure = Readonly<{ code: string; message: string }>
export type Checked<Value> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: Failure }>
export type ArtifactFile = Readonly<{ kind: string; file: string; content: string; mediaType: string }>

export const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function failed<Output extends JsonValue>(code: string, cause: unknown): JobResult<Output> {
  return { status: "completed", conclusion: "failure", error: { code, message: errorMessage(cause) } }
}

export const accepted = <Value>(value: Value): Checked<Value> => ({ ok: true, value })
export const rejected = (code: string, message: string): Checked<never> => ({ ok: false, error: { code, message } })

export async function attempt<Value>(code: string, operation: () => Value | Promise<Value>): Promise<Checked<Value>> {
  try {
    return accepted(await operation())
  } catch (error) {
    return rejected(code, errorMessage(error))
  }
}

export function runProcess(
  process: Pick<Process, "run">,
  request: ProcessRequest,
  code: string,
): Promise<Checked<ProcessResult>> {
  return attempt(code, () => process.run(request))
}

export function createGit(process: Pick<Process, "run">, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const run = (cwd: string, args: readonly string[]) =>
    runProcess(process, { argv: ["git", ...args], cwd, env, signal }, "git-spawn-failed")
  const output = (result: ProcessResult) =>
    result.stderr.trim() || result.stdout.trim() || `Process exited ${result.exitCode}`
  const failure = (result: Checked<ProcessResult>, code: string, action: string): Failure | undefined => {
    if (!result.ok) return { code, message: `${action}: ${result.error.message}` }
    return result.value.exitCode === 0 ? undefined : { code, message: `${action}: ${output(result.value)}` }
  }
  const text = async (cwd: string, args: readonly string[], code: string, action: string): Promise<Checked<string>> => {
    const result = await run(cwd, args)
    const error = failure(result, code, action)
    return error === undefined ? accepted(result.ok ? result.value.stdout.trim() : "") : { ok: false, error }
  }
  const branch = (cwd: string, code: string, action: string) =>
    text(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], code, action)
  const commit = async (
    cwd: string,
    revision: string,
    code: string,
    action: string,
    endOfOptions = false,
  ): Promise<Checked<string>> => {
    const result = await text(
      cwd,
      ["rev-parse", "--verify", ...(endOfOptions ? ["--end-of-options"] : []), `${revision}^{commit}`],
      code,
      action,
    )
    if (!result.ok) return result
    const value = result.value.toLowerCase()
    return FULL_SHA.test(value) ? accepted(value) : rejected(code, `Git returned invalid commit '${value}'`)
  }
  const clean = async (cwd: string, code: string, action: string): Promise<Checked<boolean>> => {
    const result = await text(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], code, action)
    return result.ok ? accepted(result.value === "") : result
  }
  const commonDir = async (cwd: string, action: string): Promise<Checked<string>> => {
    const result = await text(
      cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      "git-common-dir-invalid",
      action,
    )
    if (!result.ok) return result
    return result.value === ""
      ? rejected("git-common-dir-invalid", "Git returned an empty common directory")
      : accepted(resolve(cwd, result.value))
  }
  return Object.freeze({ run, output, failure, text, branch, commit, clean, commonDir })
}

export type Git = ReturnType<typeof createGit>

export function executionEnvironment(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
  owned: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...base, ...extra }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key.startsWith("YRD_")) delete env[key]
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", ...owned }
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export function jsonArtifact(kind: string, file: string, value: unknown): ArtifactFile {
  return { kind, file, content: `${JSON.stringify(value, null, 2)}\n`, mediaType: "application/json" }
}

async function writeArtifact(dir: string, file: ArtifactFile): Promise<ContestArtifact> {
  const path = join(dir, file.file)
  await writeFile(path, file.content, { flag: "wx" })
  return {
    kind: file.kind,
    uri: pathToFileURL(path).href,
    digest: `sha256:${sha256(file.content)}`,
    mediaType: file.mediaType,
  }
}

export async function captureArtifacts(
  dir: string,
  files: readonly ArtifactFile[],
): Promise<Checked<readonly ContestArtifact[]>> {
  try {
    await mkdir(dir, { recursive: true })
    return accepted(await Promise.all(files.map(async (file) => writeArtifact(dir, file))))
  } catch (error) {
    return rejected("artifact-write-failed", errorMessage(error))
  }
}
