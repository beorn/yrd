import { Buffer } from "node:buffer"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createGitConfigSource, resolveOption } from "../config.ts"
import type { Cause, StepArtifact, StepCommandOutput, StepError, StepErrorCode, StepFinishMetadata, StepRunData } from "../types.ts"
import { defaultBayDir, git, resolveBaseRef } from "./git.ts"

function sanitizePart(raw: string | number | undefined): string {
  const value = String(raw ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return value === "" ? "run" : value.slice(0, 80)
}

function stepDirName(run: StepRunData): string {
  return [
    run.step,
    run.pr ?? run.batch ?? "no-pr",
    run.role,
    run.index,
    run.target === "" ? undefined : run.target,
  ]
    .map(sanitizePart)
    .filter((part) => part !== "run")
    .join("-")
}

async function resolveBayDir(mainRepo: string): Promise<string> {
  const fallback = await defaultBayDir(mainRepo)
  return (await resolveOption(undefined, "dir", createGitConfigSource(mainRepo), fallback.dir))!
}

export async function writeStepArtifacts(params: {
  mainRepo?: string
  bayDir?: string
  cause: Cause
  run: StepRunData
  output: StepCommandOutput
}): Promise<StepArtifact[]> {
  type CapturedStream = { name: "stdout" | "stderr"; text: string }
  const streams = [
    { name: "stdout" as const, text: params.output.stdout },
    { name: "stderr" as const, text: params.output.stderr },
  ].filter((stream): stream is CapturedStream => typeof stream.text === "string" && stream.text.length > 0)
  if (streams.length === 0) return []
  const bayDir = params.bayDir ?? (params.mainRepo === undefined ? undefined : await resolveBayDir(params.mainRepo))
  if (bayDir === undefined) return []

  const dir = join(bayDir, "artifacts", sanitizePart(params.cause.commandId), stepDirName(params.run))
  await mkdir(dir, { recursive: true })
  const artifacts: StepArtifact[] = []
  for (const stream of streams) {
    const path = join(dir, `${stream.name}.log`)
    await writeFile(path, stream.text, "utf8")
    artifacts.push({ name: stream.name, path, bytes: Buffer.byteLength(stream.text, "utf8") })
  }
  return artifacts
}

export function parseStepArtifactRef(raw: string): StepArtifact {
  const eq = raw.indexOf("=")
  if (eq <= 0 || eq === raw.length - 1) {
    throw new Error(`artifact '${raw}' must be name=path-or-url`)
  }
  const name = raw.slice(0, eq).trim()
  const ref = raw.slice(eq + 1).trim()
  if (name === "" || ref === "") throw new Error(`artifact '${raw}' must be name=path-or-url`)
  if (/^https?:\/\//i.test(ref)) return { name, url: ref }
  return { name, path: ref }
}

function artifactFromObject(raw: Record<string, unknown>): StepArtifact | undefined {
  const name = raw.name
  const path = raw.path
  const url = raw.url
  const bytes = raw.bytes
  if (typeof name !== "string" || name.trim() === "") return undefined
  if (typeof url === "string" && url.trim() !== "") {
    return { name: name.trim(), url: url.trim(), ...(typeof bytes === "number" && Number.isFinite(bytes) ? { bytes } : {}) }
  }
  if (typeof path === "string" && path.trim() !== "") {
    return { name: name.trim(), path: path.trim(), ...(typeof bytes === "number" && Number.isFinite(bytes) ? { bytes } : {}) }
  }
  return undefined
}

export function parseStepArtifactRefs(raw: unknown): StepArtifact[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(parseStepArtifactRef)
  }
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => parseStepArtifactRefs(item))
  }
  if (typeof raw === "object") {
    const artifact = artifactFromObject(raw as Record<string, unknown>)
    if (artifact !== undefined) return [artifact]
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string" && value.trim() !== "")
      .map(([name, value]) => (/^https?:\/\//i.test(value as string) ? { name, url: (value as string).trim() } : { name, path: (value as string).trim() }))
  }
  return []
}

export function stepError(code: StepErrorCode, message: string, output: StepCommandOutput = {}): StepError {
  return {
    code,
    message,
    ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
  }
}

export function stepMetadata(
  output: StepCommandOutput,
  artifacts: StepArtifact[],
  error?: StepError,
  extra: Pick<StepFinishMetadata, "configHash" | "skipped"> = {},
): StepFinishMetadata {
  return {
    ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
    ...(output.durationMs !== undefined ? { durationMs: output.durationMs } : {}),
    ...(extra.configHash !== undefined ? { configHash: extra.configHash } : {}),
    ...(extra.skipped !== undefined ? { skipped: extra.skipped } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(output.baseSha !== undefined ? { baseSha: output.baseSha } : {}),
    ...(output.headSha !== undefined ? { headSha: output.headSha } : {}),
  }
}

export async function collectStepRefs(mainRepo: string, target: string, output: StepCommandOutput = {}): Promise<StepCommandOutput> {
  const refs: StepCommandOutput = { ...output }
  if (refs.baseSha === undefined) {
    const baseRef = await resolveBaseRef(mainRepo)
    const base = await git(["-C", mainRepo, "rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], mainRepo)
    if (base.code === 0) refs.baseSha = base.stdout.trim()
  }
  if (refs.headSha === undefined) {
    const head = await git(["-C", mainRepo, "rev-parse", "--verify", "--quiet", `${target}^{commit}`], mainRepo)
    if (head.code === 0) refs.headSha = head.stdout.trim()
  }
  return refs
}
