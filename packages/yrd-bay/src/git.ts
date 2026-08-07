import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { JobResult } from "@yrd/job"
import type { Process } from "@yrd/process"
import { createGitWorktreeStore, type Git } from "git-super/worktree"
import type { BayWorkspace } from "./plugin.ts"
import type {
  CheckpointBayInput,
  CheckpointedBay,
  DeprovisionBayInput,
  DeprovisionedBay,
  ProvisionBayInput,
  ProvisionedBay,
  RefreshBayInput,
  RefreshedBay,
} from "./model.ts"

export type GitWorkspaceOptions = Readonly<{
  repo: string
  process: Pick<Process, "run">
  baysRoot?: string
  intakeRemote?: string
  env?: NodeJS.ProcessEnv
}>

function failure(code: string, cause: unknown): JobResult<never> {
  return {
    status: "completed",
    conclusion: "failure",
    error: { code, message: cause instanceof Error ? cause.message : String(cause) },
  }
}

function rethrowWorktreeOwnershipConflict(cause: unknown): never {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (!/already used by worktree|is already checked out/iu.test(message)) throw cause
  throw new Error(
    `${message}\nThe branch remains owned by its existing worktree; ` +
      "materialize the recorded commit in detached HEAD instead.",
  )
}

async function worktreePosture(
  git: Git,
  input: Readonly<{ bay: string; path: string; branch: string; from?: string }>,
): Promise<"branch" | "detached"> {
  const branch = (await git.run(input.path, ["branch", "--show-current"])).stdout.trim()
  if (branch === input.branch) return "branch"
  if (branch === "" && input.from !== undefined) {
    const carriesSource = await git.run(input.path, ["merge-base", "--is-ancestor", input.from, "HEAD"], true)
    if (carriesSource.code === 0) return "detached"
    throw new Error(
      `detached workspace '${input.path}' no longer descends from Bay '${input.bay}' source '${input.from}'`,
    )
  }
  throw new Error(`workspace '${input.path}' is on branch '${branch}', expected '${input.branch}'`)
}

async function remoteBranchHead(git: Git, repo: string, branch: string): Promise<string | undefined> {
  const result = await git.run(repo, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], true)
  if (result.code === 2) return undefined
  if (result.code !== 0) {
    throw new Error(
      `could not verify branch '${branch}' on origin: ` +
        (result.stderr.trim() || result.stdout.trim() || `git ls-remote exited ${result.code}`),
    )
  }
  const headSha = result.stdout.trim().split(/\s+/u)[0]
  if (headSha === undefined || !/^[0-9a-f]{40,64}$/u.test(headSha)) {
    throw new Error(`origin returned no commit for branch '${branch}'`)
  }
  return headSha
}

type BranchCarrier = "remote" | "tracking"
type BranchProvisionDecision =
  | Readonly<{ kind: "open"; source: "local" | "tracking" | "base"; carrier?: BranchCarrier }>
  | Readonly<{ kind: "refuse"; reason: "unproven-existing" | "missing-carrier" }>

function decideBranchProvision(input: {
  claim: boolean
  reuse: boolean
  local: boolean
  tracking: boolean
  remote: boolean
}): BranchProvisionDecision {
  // One state table owns branch provenance:
  // - ordinary open: local > tracking > base;
  // - fresh claim: every pre-existing carrier refuses, otherwise base;
  // - live claim: authoritative remote > tracking, no carrier refuses, and local is only a candidate source.
  if (!input.claim) {
    return { kind: "open", source: input.local ? "local" : input.tracking ? "tracking" : "base" }
  }
  if (!input.reuse) {
    return input.local || input.tracking || input.remote
      ? { kind: "refuse", reason: "unproven-existing" }
      : { kind: "open", source: "base" }
  }
  const carrier: BranchCarrier | undefined = input.remote ? "remote" : input.tracking ? "tracking" : undefined
  return carrier === undefined
    ? { kind: "refuse", reason: "missing-carrier" }
    : { kind: "open", source: input.local ? "local" : "tracking", carrier }
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

async function preserveClosedBay(git: Git, repo: string, bay: string, headSha: string): Promise<string> {
  const preservedRef = `refs/yrd/closed/${bay}`
  const created = await git.run(repo, ["update-ref", preservedRef, headSha, "0".repeat(headSha.length)], true)
  if (created.code === 0) return preservedRef

  const existing = await git.run(repo, ["rev-parse", "--verify", `${preservedRef}^{commit}`], true)
  if (existing.code === 0 && existing.stdout.trim() === headSha) return preservedRef
  throw new Error(created.stderr.trim() || created.stdout.trim() || `could not preserve '${preservedRef}'`)
}

export async function createGitWorkspace(options: GitWorkspaceOptions): Promise<BayWorkspace> {
  const repo = resolve(options.repo)
  const baysRoot = resolve(options.baysRoot ?? `${repo}/.bays`)
  const worktrees = createGitWorktreeStore(options)
  const { git } = worktrees
  if (options.intakeRemote !== undefined) {
    // Older Yrd versions set this in shared config, making plain `git push` target the Bay receiver.
    await worktrees.removeLegacySharedPushDefault()
  }
  await worktrees.ready()
  return {
    revision: createHash("sha256")
      .update(
        JSON.stringify({ implementation: "yrd-git-workspace-v6", repo, baysRoot, intakeRemote: options.intakeRemote }),
      )
      .digest("hex"),

    async provision(input: ProvisionBayInput): Promise<JobResult<ProvisionedBay>> {
      const path = safeBayPath(baysRoot, input.bay)
      try {
        const baseSha = await git.commit(repo, input.baseSha ?? input.base)
        await worktrees.prepareRoot(baysRoot, options.intakeRemote !== undefined)
        if (input.from === undefined) {
          const localRef = `refs/heads/${input.branch}`
          const remoteRef = `refs/remotes/origin/${input.branch}`
          if (input.remoteBranch !== undefined && input.remoteBranch.branch !== input.branch) {
            throw new Error(
              `remote branch snapshot '${input.remoteBranch.branch}' does not match Bay branch '${input.branch}'`,
            )
          }
          const [local, tracking] = await Promise.all([
            git.run(repo, ["rev-parse", "--verify", `${localRef}^{commit}`], true),
            git.run(repo, ["rev-parse", "--verify", `${remoteRef}^{commit}`], true),
          ])
          const trackedHead = tracking.code === 0 ? tracking.stdout.trim() : undefined
          if (input.remoteBranch !== undefined && trackedHead !== input.remoteBranch.headSha) {
            throw new Error(
              `remote-tracking branch '${input.branch}' changed after its authority snapshot; ` +
                "retry Bay provisioning against one fresh queue/branch snapshot",
            )
          }
          const remoteHead =
            input.issue === undefined
              ? undefined
              : input.remoteBranch === undefined
                ? await remoteBranchHead(git, repo, input.branch)
                : input.remoteBranch.headSha
          const remoteExists = remoteHead !== undefined
          const decision = decideBranchProvision({
            claim: input.issue !== undefined,
            reuse: input.reuseBranch === true,
            local: local.code === 0,
            tracking: tracking.code === 0,
            remote: remoteExists,
          })
          if (decision.kind === "refuse" && decision.reason === "unproven-existing") {
            throw new Error(
              `branch '${input.branch}' already exists without matching claim provenance; ` +
                "link that branch to the claim's draft PR, then reopen with bay open",
            )
          }
          if (decision.kind === "refuse") {
            throw new Error(
              `live claim branch '${input.branch}' has no remote or tracking branch; ` +
                "restore the draft PR head before reopening with bay open",
            )
          }
          if (decision.carrier === "remote" && input.remoteBranch === undefined) {
            await git.run(repo, [
              "fetch",
              "--no-recurse-submodules",
              "origin",
              `refs/heads/${input.branch}:${remoteRef}`,
            ])
          }
          if (decision.carrier !== undefined && decision.source === "local") {
            const carriesClaimHead = await git.run(repo, ["merge-base", "--is-ancestor", remoteRef, localRef], true)
            if (carriesClaimHead.code !== 0) {
              throw new Error(
                `local branch '${input.branch}' does not descend from the live claim head; ` +
                  "restore or reconcile the draft PR branch before reopening with bay open",
              )
            }
          }
          if (decision.source === "local") {
            try {
              await worktrees.add({ kind: "branch", path, branch: input.branch })
            } catch (cause) {
              rethrowWorktreeOwnershipConflict(cause)
            }
          } else if (decision.source === "tracking") {
            await worktrees.add({ kind: "new-branch", path, branch: input.branch, ref: remoteRef })
          } else {
            await worktrees.add({ kind: "new-branch", path, branch: input.branch, ref: baseSha })
          }
          if (decision.carrier !== undefined || decision.source === "tracking") {
            await git.run(path, ["branch", "--set-upstream-to", `origin/${input.branch}`, input.branch])
          }
        } else {
          await git.commit(repo, input.from)
          try {
            await worktrees.add({ kind: "ref", path, ref: input.from })
          } catch (cause) {
            rethrowWorktreeOwnershipConflict(cause)
          }
        }
        await worktrees.materializeSubmodules(path)
        const headSha = await git.commit(path, "HEAD")
        if (options.intakeRemote !== undefined) {
          await configureIntake(git, path, options.intakeRemote)
        }
        return { status: "completed", conclusion: "success", output: { path, headSha, baseSha } }
      } catch (cause) {
        return failure("provision-failed", cause)
      }
    },

    async refresh(input: RefreshBayInput): Promise<JobResult<RefreshedBay>> {
      if (input.path === undefined) return failure("refresh-failed", `bay '${input.bay}' has no workspace path`)
      try {
        await worktreePosture(git, { ...input, path: input.path })
        const [headSha, baseSha, status] = await Promise.all([
          git.commit(input.path, "HEAD"),
          git.commit(repo, input.base),
          git.run(input.path, ["status", "--porcelain"]),
        ])
        return {
          status: "completed",
          conclusion: "success",
          output: { path: input.path, headSha, baseSha, dirty: status.stdout.trim() !== "" },
        }
      } catch (cause) {
        return failure("refresh-failed", cause)
      }
    },

    async checkpoint(input: CheckpointBayInput): Promise<JobResult<CheckpointedBay>> {
      if (input.path === undefined) return failure("checkpoint-failed", `bay '${input.bay}' has no workspace path`)
      try {
        const posture = await worktreePosture(git, { ...input, path: input.path })
        const submodules = await git.run(
          input.path,
          [
            "submodule",
            "foreach",
            "--recursive",
            "--quiet",
            'dirty=$(git status --porcelain); test -z "$dirty" || { printf "%s\\n" "$displaypath"; exit 1; }',
          ],
          true,
        )
        if (submodules.code !== 0) {
          throw new Error(
            `workspace '${input.path}' has dirty submodule work at ${submodules.stdout.trim() || "an unknown path"}; ` +
              "leaving the Bay open so the nested work stays recoverable",
          )
        }
        const status = await git.run(input.path, ["status", "--porcelain", "--ignore-submodules=none"])
        const dirtyStatus = status.stdout.trim()
        const wip = dirtyStatus !== ""
        const beforeHead = await git.commit(input.path, "HEAD")
        let headSha = beforeHead
        if (wip) {
          await git.run(input.path, ["add", "-A"])
          const stagedTree = (await git.run(input.path, ["write-tree"])).stdout.trim()
          const committed = await git.run(input.path, ["commit", "-m", `wip: ${input.claim}`], true)
          if (committed.code !== 0) {
            const remaining = (
              await git.run(input.path, ["status", "--porcelain", "--ignore-submodules=none"])
            ).stdout.trim()
            throw new Error(
              `workspace '${input.path}' reported uncommitted work:\n${dirtyStatus}\n` +
                `but the checkpoint commit failed: ${committed.stderr.trim() || committed.stdout.trim() || `exit ${String(committed.code)}`}` +
                (remaining === "" ? "" : `\nremaining uncommitted work:\n${remaining}`) +
                "\nThe Bay remains open and no archive receipt was written. Fix the commit failure, then retry.",
            )
          }
          headSha = await git.commit(input.path, "HEAD")
          if (headSha === beforeHead) {
            const remaining = (
              await git.run(input.path, ["status", "--porcelain", "--ignore-submodules=none"])
            ).stdout.trim()
            throw new Error(
              `workspace '${input.path}' reported uncommitted work:\n${dirtyStatus}\n` +
                `but the checkpoint commit reported success and did not advance HEAD '${beforeHead}'; ` +
                (remaining === ""
                  ? "the dirty content disappeared from the index/worktree during the commit"
                  : `the work remains uncommitted:\n${remaining}`) +
                "\nThe Bay remains open and no archive receipt was written. " +
                "Fix the Git hook or filter so committing the listed paths advances HEAD, then retry.",
            )
          }
          const committedTree = (await git.run(input.path, ["rev-parse", "--verify", "HEAD^{tree}"])).stdout.trim()
          if (committedTree !== stagedTree) {
            throw new Error(
              `workspace '${input.path}' reported uncommitted work:\n${dirtyStatus}\n` +
                `but checkpoint commit '${headSha}' contains tree '${committedTree}', not staged tree '${stagedTree}'; ` +
                "the commit did not preserve the staged content.\n" +
                "The Bay remains open and no archive receipt was written. " +
                "Fix the Git hook or filter that replaced the staged content, then retry.",
            )
          }
        }
        const trackingRef = `refs/remotes/origin/${input.branch}`
        const [tracking, remoteHead] = await Promise.all([
          git.run(input.path, ["rev-parse", "--verify", `${trackingRef}^{commit}`], true),
          remoteBranchHead(git, input.path, input.branch),
        ])
        const trackedHead = tracking.code === 0 ? tracking.stdout.trim() : undefined
        if (trackedHead !== undefined) {
          const carriesTrackedHead = await git.run(
            input.path,
            ["merge-base", "--is-ancestor", trackedHead, headSha],
            true,
          )
          if (carriesTrackedHead.code !== 0) {
            throw new Error(
              `Bay '${input.bay}' no longer descends from its tracked claim head; ` +
                "restore or reconcile the branch before checkpointing again",
            )
          }
        }
        if (remoteHead === headSha) {
          // A previous attempt can complete the ordinary push before its process result is observed.
          // Content-addressed equality proves that origin already has this exact authored checkpoint.
          await git.run(input.path, ["update-ref", trackingRef, remoteHead, trackedHead ?? "0".repeat(headSha.length)])
          if (posture === "branch") {
            await git.run(input.path, ["branch", "--set-upstream-to", `origin/${input.branch}`, input.branch])
          }
          return { status: "completed", conclusion: "success", output: { headSha, pushed: true, wip } }
        }
        if (
          (trackedHead === undefined && remoteHead !== undefined) ||
          (trackedHead !== undefined && remoteHead !== undefined && remoteHead !== trackedHead)
        ) {
          throw new Error(
            `origin branch '${input.branch}' changed after Bay '${input.bay}' was provisioned; ` +
              `fetch origin '${input.branch}' and reconcile it before checkpointing again`,
          )
        }
        await git.run(input.path, [
          "push",
          ...(posture === "branch" ? ["--set-upstream"] : []),
          "origin",
          `HEAD:refs/heads/${input.branch}`,
        ])
        return { status: "completed", conclusion: "success", output: { headSha, pushed: true, wip } }
      } catch (cause) {
        return failure("checkpoint-failed", cause)
      }
    },

    async deprovision(input: DeprovisionBayInput): Promise<JobResult<DeprovisionedBay>> {
      try {
        if (input.path === undefined || !existsSync(input.path)) {
          // Provision can fail before either a workspace path or head is
          // recorded. Closing that lifecycle is an idempotent no-op: there is
          // no authored head to preserve and therefore no archive proof to invent.
          // A recorded head is already durable content, so atomically create
          // or verify its preservation ref even though no worktree exists.
          if (input.headSha === undefined) return { status: "completed", conclusion: "success", output: {} }
          return {
            status: "completed",
            conclusion: "success",
            output: {
              headSha: input.headSha,
              preservedRef: await preserveClosedBay(git, repo, input.bay, input.headSha),
            },
          }
        }
        const status = await git.run(input.path, ["status", "--porcelain", "--ignore-submodules=none"])
        if (status.stdout.trim() !== "") {
          return {
            status: "completed",
            conclusion: "failure",
            error: {
              code: "dirty-worktree",
              message: `workspace '${input.path}' has uncommitted work:\n${status.stdout.trim()}`,
            },
          }
        }
        const headSha = await git.commit(input.path, "HEAD")
        const preservedRef = await preserveClosedBay(git, repo, input.bay, headSha)
        await worktrees.remove(input.path)
        return { status: "completed", conclusion: "success", output: { headSha, preservedRef } }
      } catch (cause) {
        return failure("deprovision-failed", cause)
      }
    },
  }
}
