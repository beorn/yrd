import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { EffectOutcome } from "@yrd/core"
import type { BayWorkspaceAdapter } from "./plugin.ts"
import type {
  DeprovisionBayInput,
  DeprovisionedBay,
  ProvisionBayInput,
  ProvisionedBay,
  RefreshBayInput,
  RefreshedBay,
} from "./model.ts"

export type GitWorkspaceOptions = {
  repo: string
  baysRoot?: string
  intakeRemote?: string
}

type ProcessResult = {
  code: number
  stdout: string
  stderr: string
}

async function run(command: readonly string[], cwd: string): Promise<ProcessResult> {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

async function git(repo: string, args: readonly string[], allowFailure = false): Promise<ProcessResult> {
  const result = await run(["git", "-C", repo, ...args], repo)
  if (!allowFailure && result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} exited ${result.code}`)
  }
  return result
}

function failure(code: string, cause: unknown): EffectOutcome<never> {
  return { status: "failed", error: { code, message: cause instanceof Error ? cause.message : String(cause) } }
}

function safeBayPath(root: string, bay: string): string {
  const path = resolve(root, bay)
  const prefix = `${resolve(root)}/`
  if (!path.startsWith(prefix)) throw new Error(`bay id '${bay}' escapes the configured bays root`)
  return path
}

async function commit(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim()
}

async function configureIntake(path: string, remote: string): Promise<void> {
  const existing = await git(path, ["remote", "get-url", "bay"], true)
  await git(path, existing.code === 0 ? ["remote", "set-url", "bay", remote] : ["remote", "add", "bay", remote])
  await git(path, ["config", "--worktree", "remote.pushDefault", "bay"])
  await git(path, ["config", "--worktree", "push.default", "current"])
}

export function createGitWorkspace(options: GitWorkspaceOptions): BayWorkspaceAdapter {
  const repo = resolve(options.repo)
  const baysRoot = resolve(options.baysRoot ?? `${repo}/.bays`)
  return {
    async provision(input: ProvisionBayInput): Promise<EffectOutcome<ProvisionedBay>> {
      const path = safeBayPath(baysRoot, input.bay)
      try {
        await git(repo, ["rev-parse", "--show-toplevel"])
        const baseSha = await commit(repo, input.baseSha ?? input.base)
        if (existsSync(path))
          throw new Error(`workspace path '${path}' already exists; inspect or remove it explicitly`)
        if (input.from === undefined) {
          await git(repo, ["worktree", "add", "-b", input.branch, path, baseSha])
        } else {
          await commit(repo, input.from)
          await git(repo, ["worktree", "add", path, input.from])
        }
        const headSha = await commit(path, "HEAD")
        if (options.intakeRemote !== undefined) {
          await git(repo, ["config", "extensions.worktreeConfig", "true"])
          await configureIntake(path, options.intakeRemote)
        }
        return { status: "passed", output: { path, headSha, baseSha } }
      } catch (cause) {
        return failure("provision-failed", cause)
      }
    },
    async refresh(input: RefreshBayInput): Promise<EffectOutcome<RefreshedBay>> {
      if (input.path === undefined) return failure("refresh-failed", `bay '${input.bay}' has no workspace path`)
      try {
        const branch = (await git(input.path, ["branch", "--show-current"])).stdout.trim()
        if (branch !== input.branch) {
          throw new Error(`workspace '${input.path}' is on branch '${branch}', expected '${input.branch}'`)
        }
        const [headSha, baseSha, status] = await Promise.all([
          commit(input.path, "HEAD"),
          commit(repo, input.base),
          git(input.path, ["status", "--porcelain"]),
        ])
        return {
          status: "passed",
          output: { path: input.path, headSha, baseSha, dirty: status.stdout.trim() !== "" },
        }
      } catch (cause) {
        return failure("refresh-failed", cause)
      }
    },
    async deprovision(input: DeprovisionBayInput): Promise<EffectOutcome<DeprovisionedBay>> {
      if (input.path === undefined) return { status: "passed", output: {} }
      try {
        const status = await git(input.path, ["status", "--porcelain"])
        if (status.stdout.trim() !== "") {
          return {
            status: "failed",
            error: {
              code: "dirty-worktree",
              message: `workspace '${input.path}' has uncommitted work:\n${status.stdout.trim()}`,
            },
          }
        }
        const headSha = await commit(input.path, "HEAD")
        const preservedRef = `refs/yrd/closed/${input.bay}`
        await git(repo, ["update-ref", preservedRef, headSha])
        await git(repo, ["worktree", "remove", input.path])
        return { status: "passed", output: { preservedRef } }
      } catch (cause) {
        return failure("deprovision-failed", cause)
      }
    },
  }
}
