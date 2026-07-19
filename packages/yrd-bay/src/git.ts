import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { JobResult } from "@yrd/job"
import type { Process } from "@yrd/process"
import type { BayWorkspace } from "./plugin.ts"
import type {
  DeprovisionBayInput,
  DeprovisionedBay,
  ProvisionBayInput,
  ProvisionedBay,
  RefreshBayInput,
  RefreshedBay,
} from "./model.ts"
import { materializeSubmodules } from "./submodule-materialization.ts"

export type GitWorkspaceOptions = Readonly<{
  repo: string
  process: Pick<Process, "run">
  baysRoot?: string
  intakeRemote?: string
  env?: NodeJS.ProcessEnv
}>

type GitResult = Readonly<{ code: number; stdout: string; stderr: string }>
type Git = ReturnType<typeof createGit>

function createGit(process: Pick<Process, "run">, environment: NodeJS.ProcessEnv) {
  const env = cleanGitEnvironment(environment)
  const run = async (repo: string, args: readonly string[], allowFailure = false): Promise<GitResult> => {
    const result = await process.run({ argv: ["git", "-C", repo, ...args], cwd: repo, env })
    if (!allowFailure && result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} exited ${result.exitCode}`)
    }
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }

  const mutateConfig = async (repo: string, args: readonly string[]): Promise<GitResult> => {
    let result: GitResult | undefined
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      result = await run(repo, args, true)
      if (result.code === 0 || !result.stderr.includes("could not lock config file")) return result
      await Bun.sleep(attempt * 5)
    }
    if (result === undefined) throw new Error("yrd: Git config retry did not run")
    return result
  }

  const commit = async (repo: string, ref: string): Promise<string> =>
    (await run(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim()

  return Object.freeze({ run, mutateConfig, commit })
}

function failure(code: string, cause: unknown): JobResult<never> {
  return { status: "failed", error: { code, message: cause instanceof Error ? cause.message : String(cause) } }
}

function safeBayPath(root: string, bay: string): string {
  const path = resolve(root, bay)
  const prefix = `${resolve(root)}/`
  if (!path.startsWith(prefix)) throw new Error(`bay id '${bay}' escapes the configured bays root`)
  return path
}

async function configureIntake(git: Git, path: string, remote: string): Promise<void> {
  const existing = await git.run(path, ["remote", "get-url", "bay"], true)
  if (existing.code !== 0 || existing.stdout.trim() !== remote) {
    const configured = await git.mutateConfig(
      path,
      existing.code === 0 ? ["remote", "set-url", "bay", remote] : ["remote", "add", "bay", remote],
    )
    if (configured.code !== 0) {
      const raced = await git.run(path, ["remote", "get-url", "bay"], true)
      if (raced.code !== 0 || raced.stdout.trim() !== remote) {
        throw new Error(configured.stderr.trim() || configured.stdout.trim() || "could not configure bay remote")
      }
    }
  }
  await git.run(path, ["config", "--worktree", "remote.pushDefault", "bay"])
  await git.run(path, ["config", "--worktree", "push.default", "current"])
}

async function localConfig(git: Git, repo: string, key: string): Promise<string | undefined> {
  const configured = await git.run(repo, ["config", "--local", "--get", key], true)
  if (configured.code === 1) return undefined
  if (configured.code !== 0) {
    throw new Error(configured.stderr.trim() || `could not inspect shared ${key} config`)
  }
  return configured.stdout.trim()
}

async function localBool(git: Git, repo: string, key: string): Promise<boolean | undefined> {
  const configured = await git.run(repo, ["config", "--local", "--get", "--type=bool", key], true)
  if (configured.code === 1) return undefined
  if (configured.code !== 0) {
    throw new Error(configured.stderr.trim() || `could not inspect shared ${key} config`)
  }
  return configured.stdout.trim() === "true"
}

async function removeLegacySharedPushDefault(git: Git, repo: string): Promise<void> {
  const configured = await localConfig(git, repo, "remote.pushDefault")
  if (configured !== "bay") return
  const removed = await git.mutateConfig(repo, ["config", "--local", "--unset-all", "remote.pushDefault"])
  if (removed.code === 0) return
  const remaining = await localConfig(git, repo, "remote.pushDefault")
  if (remaining !== "bay") return
  throw new Error(
    removed.stderr.trim() ||
      "could not remove legacy shared remote.pushDefault=bay; run 'git config --local --unset-all remote.pushDefault'",
  )
}

async function relocateSharedWorktree(git: Git, repo: string, worktree: string): Promise<void> {
  if (worktree === "") throw new Error("Git core.worktree is empty")
  const moved = await git.mutateConfig(repo, ["config", "--worktree", "core.worktree", worktree])
  if (moved.code !== 0) throw new Error(moved.stderr || "could not set primary worktree config")
  const removed = await git.mutateConfig(repo, ["config", "--local", "--unset-all", "core.worktree"])
  if (removed.code === 0) return
  const remaining = await localConfig(git, repo, "core.worktree")
  if (remaining !== undefined) throw new Error(removed.stderr || "could not remove shared core.worktree config")
}

async function relocateSharedBare(git: Git, repo: string): Promise<void> {
  // A shared core.bare=false (or unset) is harmless: linked worktrees are non-bare regardless. Only a
  // shared core.bare=true is dangerous once extensions.worktreeConfig is enabled.
  if ((await localBool(git, repo, "core.bare")) !== true) return
  // git-worktree(1) CONFIGURATION FILE: with extensions.worktreeConfig enabled, a `core.bare=true` in the
  // SHARED config is inherited by every LINKED worktree, so `git rev-parse --is-bare-repository` reports
  // true there and the worktree becomes unusable (this is what took the whole worktree fleet down). A Bay
  // is only ever provisioned on a repository that already has a working tree, so the repository is
  // non-bare: record the corrected flag in the MAIN worktree's config.worktree, then drop the stray value
  // from the shared config so no linked worktree can inherit it.
  const scoped = await git.mutateConfig(repo, ["config", "--worktree", "core.bare", "false"])
  if (scoped.code !== 0) throw new Error(scoped.stderr || "could not scope core.bare to the main worktree")
  const removed = await git.mutateConfig(repo, ["config", "--local", "--unset-all", "core.bare"])
  if (removed.code === 0) return
  if ((await localBool(git, repo, "core.bare")) !== undefined) {
    throw new Error(removed.stderr || "could not remove shared core.bare config")
  }
}

async function prepareWorktreeConfig(git: Git, repo: string, required: boolean): Promise<void> {
  const worktree = await localConfig(git, repo, "core.worktree")
  if (worktree === undefined && !required) return

  const enabled = await git.mutateConfig(repo, ["config", "extensions.worktreeConfig", "true"])
  if (enabled.code !== 0) throw new Error(enabled.stderr || "could not enable worktree config")

  // Enabling extensions.worktreeConfig exposes the shared config to every linked worktree, so a
  // `core.bare=true` or `core.worktree` left there makes those worktrees report as bare. git-worktree(1)
  // requires relocating both into the MAIN worktree's config.worktree.
  await relocateSharedBare(git, repo)
  if (worktree !== undefined) await relocateSharedWorktree(git, repo, worktree)
}

async function healPoisonedWorktreeConfig(git: Git, repo: string): Promise<void> {
  // A shared core.bare=true set AFTER extensions.worktreeConfig was enabled (by any tool, not just Yrd)
  // takes every linked worktree down and blocks a fresh provision, because the main worktree then reports
  // as bare. Repair it on host startup — the config is readable even while the repository reports bare.
  // Only act when the extension is enabled: without it a shared core.bare=true affects only the main
  // worktree and may describe an intentionally bare repository, which is not Yrd's to rewrite.
  if ((await localBool(git, repo, "extensions.worktreeConfig")) !== true) return
  await relocateSharedBare(git, repo)
}

async function ignoreInRepositoryBays(git: Git, repo: string, baysRoot: string): Promise<void> {
  const local = relative(repo, baysRoot)
  if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return
  const normalized = local.split(sep).join("/")
  if (/\r|\n/u.test(normalized)) throw new Error("configured bays root contains a newline")
  const ignored = await git.run(repo, ["check-ignore", "--quiet", "--no-index", "--", normalized], true)
  if (ignored.code === 0) return
  if (ignored.code !== 1) throw new Error(ignored.stderr || `git check-ignore exited ${ignored.code}`)
  const exclude = (
    await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])
  ).stdout.trim()
  if (exclude === "") throw new Error("git rev-parse returned an empty exclude path")
  const escaped = normalized.replace(/([\\[\]*?!#])/gu, "\\$1")
  await appendFile(exclude, `\n/${escaped}/\n`, { encoding: "utf8", mode: 0o600 })
}

async function preserveClosedBay(git: Git, repo: string, bay: string, headSha: string): Promise<string> {
  const preservedRef = `refs/yrd/closed/${bay}`
  const created = await git.run(repo, ["update-ref", preservedRef, headSha, "0".repeat(headSha.length)], true)
  if (created.code === 0) return preservedRef

  const existing = await git.run(repo, ["rev-parse", "--verify", `${preservedRef}^{commit}`], true)
  if (existing.code === 0 && existing.stdout.trim() === headSha) return preservedRef
  throw new Error(created.stderr.trim() || created.stdout.trim() || `could not preserve '${preservedRef}'`)
}

async function requirePreservedBay(git: Git, repo: string, bay: string, headSha: string): Promise<string> {
  const preservedRef = `refs/yrd/closed/${bay}`
  const existing = await git.run(repo, ["rev-parse", "--verify", `${preservedRef}^{commit}`], true)
  if (existing.code === 0 && existing.stdout.trim() === headSha) return preservedRef
  throw new Error(`workspace is absent but '${preservedRef}' does not preserve '${headSha}'`)
}

export async function createGitWorkspace(options: GitWorkspaceOptions): Promise<BayWorkspace> {
  const repo = resolve(options.repo)
  const baysRoot = resolve(options.baysRoot ?? `${repo}/.bays`)
  const git = createGit(options.process, options.env ?? process.env)
  if (options.intakeRemote !== undefined) {
    // Older Yrd versions set this in shared config, making plain `git push` target the Bay receiver.
    await removeLegacySharedPushDefault(git, repo)
  }
  // Repair a shared config that a previous run (or another tool) left in the fleet-breaking
  // worktreeConfig + core.bare=true state before provisioning anything on top of it.
  await healPoisonedWorktreeConfig(git, repo)
  return {
    revision: createHash("sha256")
      .update(
        JSON.stringify({ implementation: "yrd-git-workspace-v3", repo, baysRoot, intakeRemote: options.intakeRemote }),
      )
      .digest("hex"),

    async provision(input: ProvisionBayInput): Promise<JobResult<ProvisionedBay>> {
      const path = safeBayPath(baysRoot, input.bay)
      try {
        await git.run(repo, ["rev-parse", "--show-toplevel"])
        const baseSha = await git.commit(repo, input.baseSha ?? input.base)
        if (existsSync(path)) {
          throw new Error(`workspace path '${path}' already exists; inspect or remove it explicitly`)
        }
        await ignoreInRepositoryBays(git, repo, baysRoot)
        await prepareWorktreeConfig(git, repo, options.intakeRemote !== undefined)
        if (input.from === undefined) {
          await git.run(repo, ["worktree", "add", "-b", input.branch, path, baseSha])
        } else {
          await git.commit(repo, input.from)
          await git.run(repo, ["worktree", "add", path, input.from])
        }
        const materialized = await materializeSubmodules(git, { worktree: path, referenceWorktree: repo })
        if (materialized.code !== 0) {
          throw new Error(materialized.stderr || materialized.stdout || "could not materialize Bay submodules")
        }
        const headSha = await git.commit(path, "HEAD")
        if (options.intakeRemote !== undefined) {
          await configureIntake(git, path, options.intakeRemote)
        }
        return { status: "passed", output: { path, headSha, baseSha } }
      } catch (cause) {
        return failure("provision-failed", cause)
      }
    },

    async refresh(input: RefreshBayInput): Promise<JobResult<RefreshedBay>> {
      if (input.path === undefined) return failure("refresh-failed", `bay '${input.bay}' has no workspace path`)
      try {
        const branch = (await git.run(input.path, ["branch", "--show-current"])).stdout.trim()
        if (branch !== input.branch) {
          throw new Error(`workspace '${input.path}' is on branch '${branch}', expected '${input.branch}'`)
        }
        const [headSha, baseSha, status] = await Promise.all([
          git.commit(input.path, "HEAD"),
          git.commit(repo, input.base),
          git.run(input.path, ["status", "--porcelain"]),
        ])
        return { status: "passed", output: { path: input.path, headSha, baseSha, dirty: status.stdout.trim() !== "" } }
      } catch (cause) {
        return failure("refresh-failed", cause)
      }
    },

    async deprovision(input: DeprovisionBayInput): Promise<JobResult<DeprovisionedBay>> {
      if (input.path === undefined) return { status: "passed", output: {} }
      try {
        if (!existsSync(input.path)) {
          if (input.headSha === undefined) throw new Error("workspace is absent and the Bay has no recorded head")
          return {
            status: "passed",
            output: { preservedRef: await requirePreservedBay(git, repo, input.bay, input.headSha) },
          }
        }
        const status = await git.run(input.path, ["status", "--porcelain", "--ignore-submodules=none"])
        if (status.stdout.trim() !== "") {
          return {
            status: "failed",
            error: {
              code: "dirty-worktree",
              message: `workspace '${input.path}' has uncommitted work:\n${status.stdout.trim()}`,
            },
          }
        }
        const headSha = await git.commit(input.path, "HEAD")
        const preservedRef = await preserveClosedBay(git, repo, input.bay, headSha)
        await git.run(repo, ["worktree", "remove", "--force", input.path])
        return { status: "passed", output: { preservedRef } }
      } catch (cause) {
        return failure("deprovision-failed", cause)
      }
    },
  }
}

function cleanGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
    ),
    KM_NO_AUTO_SUBMODULE_UPDATE: "1",
  }
}
