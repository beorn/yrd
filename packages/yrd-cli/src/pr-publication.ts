import { mkdtemp } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { JobResult } from "@yrd/job"
import type { PrPublicationInput, PrPublicationOutput, PrPublicationService } from "@yrd/bay"
import type { Process, ProcessResult } from "@yrd/process"
import { cleanGitEnvironment } from "./git-environment.ts"
import { changedSubmodulePins } from "./pr-submodule-publication.ts"
import { safeRemove } from "removely"

const GIT_TIMEOUT_MS = 30_000
const TEST_ROOT = realpathSync(tmpdir())

function gitFailure(result: ProcessResult): string {
  if (result.timedOut) return `timed out after ${GIT_TIMEOUT_MS}ms`
  return result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
}

async function runGit(process: Pick<Process, "run">, cwd: string, args: readonly string[]): Promise<string> {
  const result = await process.run({
    argv: ["git", "-C", cwd, ...args],
    cwd,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in '${cwd}': ${gitFailure(result)}`)
  }
  return result.stdout.trim()
}

function componentRepository(root: string, path: string): string {
  const repository = resolve(root, path)
  const fromRoot = relative(root, repository)
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`changed submodule path escapes the publication repository: ${path}`)
  }
  return repository
}

async function publishRef(
  process: Pick<Process, "run">,
  source: string,
  destinationRepository: string,
  sha: string,
  branch: string,
): Promise<void> {
  const destination = await runGit(process, destinationRepository, ["remote", "get-url", "--push", "origin"])
  const staging = await mkdtemp(join(tmpdir(), "yrd-publication-"))
  try {
    await runGit(process, staging, ["init", "--bare", "--quiet"])
    await runGit(process, staging, ["fetch", "--quiet", "--no-tags", source, sha])
    await runGit(process, staging, ["push", "--porcelain", destination, `FETCH_HEAD:refs/heads/${branch}`])
  } finally {
    await safeRemove(staging, { within: TEST_ROOT, allowMissing: true })
  }
}

function publicationFailure(cause: unknown): JobResult<PrPublicationOutput> {
  return {
    status: "completed",
    conclusion: "failure",
    error: {
      code: "publication-failed",
      message: cause instanceof Error ? cause.message : String(cause),
    },
  }
}

export function createPrPublicationService(options: {
  repo: string
  process: Pick<Process, "run">
}): PrPublicationService {
  const repo = resolve(options.repo)
  return Object.freeze({
    revision: "pr-publication-v1",
    async publish(input: PrPublicationInput): Promise<JobResult<PrPublicationOutput>> {
      try {
        const sourceRoot = resolve(input.sourceRoot)
        const actual = await changedSubmodulePins({
          process: options.process,
          repo: sourceRoot,
          baseSha: input.baseSha,
          headSha: input.headSha,
        })
        const expectedPins = input.components.map(({ path, pin }) => `${path}\0${pin}`).toSorted()
        const actualPins = actual.map(({ path, pin }) => `${path}\0${pin}`).toSorted()
        if (JSON.stringify(actualPins) !== JSON.stringify(expectedPins)) {
          throw new Error(
            `publication request for PR '${input.pr}' does not match revision ${input.revision} ` +
              `gitlinks at '${input.headSha}'`,
          )
        }

        const refs: Array<{ path: string; sha: string; ref: string }> = []
        for (const component of input.components) {
          await publishRef(
            options.process,
            componentRepository(sourceRoot, component.path),
            componentRepository(repo, component.path),
            component.pin,
            input.branch,
          )
          refs.push({ path: component.path, sha: component.pin, ref: `refs/heads/${input.branch}` })
        }
        await publishRef(options.process, sourceRoot, repo, input.headSha, input.branch)
        refs.push({ path: ".", sha: input.headSha, ref: `refs/heads/${input.branch}` })
        return {
          status: "completed",
          conclusion: "success",
          output: { pr: input.pr, revision: input.revision, refs },
        }
      } catch (cause) {
        return publicationFailure(cause)
      }
    },
  })
}
