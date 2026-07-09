import { Buffer } from "node:buffer"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createGitConfigSource, resolveOption } from "../config.ts"
import type { Cause, StepArtifact, StepCommandOutput, StepFinishMetadata, StepRunData } from "../types.ts"
import { defaultBayDir } from "./git.ts"

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
  const streams = [
    { name: "stdout" as const, text: params.output.stdout },
    { name: "stderr" as const, text: params.output.stderr },
  ].filter((stream): stream is { name: StepArtifact["name"]; text: string } => stream.text !== undefined && stream.text.length > 0)
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

export function stepMetadata(output: StepCommandOutput, artifacts: StepArtifact[]): StepFinishMetadata {
  return {
    ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
    ...(output.durationMs !== undefined ? { durationMs: output.durationMs } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  }
}
