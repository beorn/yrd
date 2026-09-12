/**
 * `yrd env open|list` — an environment for one branch
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Commands;
 * `yrd bay` is the same command's alias and "bay" its internal name).
 *
 * An environment is a git worktree under the one worktree home
 * (`/hh/var/wt` via `worktreeHomeRoot`); that worktree is its whole
 * identity and lifecycle. Existing `.bays/` trees remain visible to list
 * and close until they move. Opening it runs the target's declared setup after
 * materialization, through the same bounded executor as the queue, but never
 * creates an app, journal or job: the durable `Bay` record, its lifecycle
 * states, the PR mint and the receiver remote went with the old core at M6,
 * and nothing that is left reads them.
 *
 * So `list` reads the worktrees git itself holds under the bays root rather
 * than a record of what was once opened. One source for each update: if git does not
 * have the worktree, the environment is not there.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { createGitWorkspace, worktreeHomeRoot } from "@yrd/bay"
import {
  checkedTree,
  freshWorktree,
  registeredWorktrees,
  runCheck,
  gitIn,
  issueOf,
  readConfig,
  refAt,
  runId,
  runSetup,
  SetupFailed,
  worktreeWithoutSubmodules,
  type Git,
} from "@yrd/queue-core"
import { createProcess, type Process } from "@yrd/process"
import { repositoryHere as findRepository } from "./declaration.ts"
import { originHead } from "./queue-location.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import { workdirOf } from "./workdir.ts"

export type EnvOpenOptions = Readonly<{ bay?: string; issue?: string; json?: boolean; commit?: string }>
export type EnvCloseOptions = Readonly<{ json?: boolean; retain?: string }>
export type EnvListOptions = Readonly<{ json?: boolean }>

/** One environment as git holds it: a worktree under the bays root. */
export type EnvRow = Readonly<{ name: string; path: string; branch?: string; head?: string }>

/**
 * The repository a command stands in, and the target its declaration names.
 * Absent declaration is loud: an environment is cut from the target, and
 * guessing `main` when the repository never said so is the silent default
 * this whole design refuses.
 */
function requireRepository(io: YrdCliIO): string {
  const cwd = io.cwd ?? process.cwd()
  const root = findRepository(cwd)
  if (root === undefined) {
    throw new Error(`yrd env needs a repository: no Git clone contains ${cwd}; run it inside a clone`)
  }
  return root
}

function baysRootOf(): string {
  return worktreeHomeRoot()
}

function legacyBaysRoot(repo: string): string {
  return join(repo, ".bays")
}

async function environmentRoots(root: string, git: Git): Promise<string[]> {
  return [baysRootOf(), legacyBaysRoot(root), join(resolve(root, await workdirOf(git)), "environments")]
}

function withinEnvironmentRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((directory) => {
    if (!existsSync(directory)) return false
    const within = relative(realpathSync(directory), path)
    return within !== "" && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)
  })
}

/** The base a fresh environment is cut from: the target as this checkout last
 * fetched it, else the local branch of that name. Named, so a refusal says
 * which ref was missing rather than "could not resolve HEAD". */
async function resolveBaseSha(git: Git, target: string): Promise<string> {
  const tracking = `refs/remotes/origin/${target}`
  const tracked = await refAt(git, tracking)
  if (tracked !== undefined) return tracked
  const local = await refAt(git, target)
  if (local !== undefined) return local
  throw new Error(`yrd: target '${target}' is absent at both ${tracking} and the local branch`)
}

/** Read the registered identity twice around the existing canonical binding reader. */
async function inspectOccupiedEnvironment(
  {
    root,
    name,
    branch,
    targetHead,
    issue,
  }: { root: string; name: string; branch: string; targetHead: string; issue: string },
  git: Git,
  process: Pick<Process, "run">,
) {
  // Inspect the entire registry first: an owner outside the allowed roots
  // still owns the branch. Absence from `env list` is not vacancy.
  const roots = await environmentRoots(root, git)
  const registrations = await registeredWorktrees(git)
  const owners = registrations.filter((entry) => entry.branch === branch)
  if (owners.length > 1) {
    throw new Error(
      `cannot reuse ${branch}: multiple registered worktrees ${owners.map((entry) => entry.path).join(", ")}`,
    )
  }
  const occupied = owners[0]
  if (occupied !== undefined) {
    try {
      const common = realpathSync((await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim())
      const inspect = async (rows: typeof registrations) => {
        const currentOwners = rows.filter((entry) => entry.branch === branch)
        const current = currentOwners[0]
        if (
          currentOwners.length !== 1 ||
          current === undefined ||
          current.path !== occupied.path ||
          current.head !== occupied.head ||
          current.locked !== occupied.locked
        ) {
          throw new Error(
            `registered identity changed; current owners: ${currentOwners.map((entry) => entry.path).join(", ") || "none"}`,
          )
        }
        const path = realpathSync(current.path)
        if (!withinEnvironmentRoots(path, roots)) {
          throw new Error(`registered path ${path} is outside environment roots ${roots.join(" or ")}`)
        }
        const environmentGit = gitIn(path, process)
        const top = realpathSync((await environmentGit(["rev-parse", "--show-toplevel"])).trim())
        const repository = realpathSync(
          (await environmentGit(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
        )
        const symbolicHead = (await environmentGit(["symbolic-ref", "HEAD"])).trim()
        const head = (await environmentGit(["rev-parse", "HEAD"])).trim()
        if (top !== path || repository !== common || symbolicHead !== `refs/heads/${branch}` || head !== current.head) {
          throw new Error(
            `repository/path/branch/HEAD identity changed: ${top}, ${repository}, ${symbolicHead}, ${head}; expected ${path}, ${common}, refs/heads/${branch}, ${String(current.head)}`,
          )
        }
        return { path, head, environmentGit }
      }
      const before = await inspect(registrations)
      const binding = await issueOf(before.environmentGit, branch, before.head, targetHead, issue)
      if (binding?.source !== "binding" || binding.commit === undefined) {
        throw new Error(
          `no explicit issue binding to ${issue} at ${before.head}; occupied work cannot receive an initial binding`,
        )
      }
      const after = await inspect(await registeredWorktrees(git))
      if (after.path !== before.path || after.head !== before.head) {
        throw new Error(`path or HEAD changed from ${before.path} at ${before.head} to ${after.path} at ${after.head}`)
      }
      return {
        path: after.path,
        head: after.head,
        issue: binding.issue,
        issueSource: binding.source,
        issueCommit: binding.commit,
      }
    } catch (error) {
      throw new Error(
        `cannot inspect registered environment ${occupied.path}; all work is preserved: ${error instanceof Error ? error.message : String(error)}\nInspect git worktree list --porcelain before retrying.`,
        { cause: error },
      )
    }
  }
  const candidates = roots.map((directory) => resolve(directory, name))
  const other = registrations.find((entry) => candidates.includes(resolve(entry.path)))
  const existing = other?.path ?? candidates.find((path) => existsSync(path))
  if (existing !== undefined) {
    throw new Error(
      `cannot reuse environment ${existing}: it is not registered on ${branch}; inspect git worktree list and preserve its existing identity`,
    )
  }
  return undefined
}

function reportReusedEnvironment(
  existing: NonNullable<Awaited<ReturnType<typeof inspectOccupiedEnvironment>>>,
  { name, branch, setup, json }: { name: string; branch: string; setup?: string; json?: boolean },
  io: YrdCliIO,
): YrdCliExitCode {
  const result = {
    ...existing,
    branch,
    name,
    reused: true,
    setup: setup === undefined ? "not-required" : "unverified",
  }
  if (setup !== undefined) {
    const reason = `required setup is unverified in preserved environment ${existing.path}; reuse did not run setup`
    const next = `Establish completion of the required setup in ${existing.path} before continuing; command: ${setup}. This reuse command cannot attest prior setup completion.`
    if (json === true) io.stdout(`${JSON.stringify({ ...result, status: "partial", reason, next })}\n`)
    io.stderr(`${reason}\n${next}\n`)
    return 2
  }
  if (json === true) io.stdout(`${JSON.stringify(result)}\n`)
  else {
    io.stderr(
      `${name} reused on ${branch} at ${existing.head.slice(0, 12)}, bound to ${existing.issue}; setup not required\n`,
    )
    io.stdout(`${existing.path}\n`)
  }
  return 0
}

/** Persist only the initial binding, preserving the exact tree and parent. */
async function bindOpenedEnvironment(
  path: string,
  branch: string,
  base: string,
  issue: string,
  process: Pick<Process, "run">,
) {
  let headSha: string
  try {
    const environmentGit = gitIn(path, process)
    headSha = (await environmentGit(["rev-parse", "HEAD"])).trim()
    const binding = await issueOf(environmentGit, branch, headSha, base, issue)
    if (binding === undefined) throw new Error(`no issue resolved for requested binding ${issue}`)
    if (binding.source !== "binding") {
      const tree = (await environmentGit(["rev-parse", `${headSha}^{tree}`])).trim()
      const bound = (
        await environmentGit([
          "commit-tree",
          tree,
          "-p",
          headSha,
          "-m",
          `Bind work to ${binding.issue}\n\nRefs: ${binding.issue}`,
        ])
      ).trim()
      await environmentGit(["update-ref", `refs/heads/${branch}`, bound, headSha])
      headSha = bound
    }
    const issueCommit = binding.source === "binding" ? binding.commit : headSha
    if (issueCommit === undefined) throw new Error(`explicit binding to ${binding.issue} has no carrying commit`)
    const currentHead = (await environmentGit(["rev-parse", "HEAD"])).trim()
    if (currentHead !== headSha) {
      throw new Error(`HEAD changed from verified binding ${headSha} to ${currentHead}`)
    }
    return { head: currentHead, issue: binding.issue, issueSource: "binding" as const, issueCommit }
  } catch (error) {
    throw new Error(
      `issue binding failed in preserved environment ${path}; setup has not run: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/**
 * `yrd env open` — open an environment for one branch and keep it. Prints its
 * path on stdout, which is what a caller `cd`s into.
 */
export async function openEnvironment(options: EnvOpenOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  const commit = options.commit
  if (commit !== undefined && options.issue !== undefined) {
    throw new Error(
      `yrd env open cannot bind --issue ${options.issue} to a detached commit; open a branch with --issue and no commit argument`,
    )
  }
  if (commit !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    // The argument is an exact commit and nothing else; a BRANCH is opened
    // with --bay/--issue and no argument. Offering only `rev-parse HEAD`
    // answered a question the caller had not asked: it resolves to a commit
    // and detaches, discarding the branch identity they named.
    const resolved = await refAt(gitIn(root), commit)
    throw new Error(
      `yrd env open takes an exact commit object ID as its argument, not '${commit}'.` +
        (resolved === undefined ? "" : ` '${commit}' is a ref here, and this argument never accepts one.`) +
        ` To open or adopt a branch, pass --bay <name> or --issue <ref> with no argument;` +
        ` the branch it opens or adopts is always task/<name>.` +
        ` To retain an exact commit detached, resolve one first with git rev-parse ${resolved === undefined ? "HEAD" : commit}.`,
    )
  }
  const target = commit === undefined ? await originHead(gitIn(root)) : "HEAD"
  const name = (
    options.bay ??
    options.issue ??
    (commit === undefined ? `env-${Date.now().toString(36)}` : `${commit.slice(0, 12)}-${runId()}`)
  ).trim()
  if (name === "") throw new Error("yrd: --bay needs a name")
  const branch = commit === undefined ? `task/${name}` : undefined
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process)
  const base = commit ?? (await resolveBaseSha(git, target))
  if (commit !== undefined && (await refAt(git, commit)) !== commit) {
    throw new Error(
      `yrd env open: commit ${commit} is not a commit object in ${root}; fetch that commit before opening it`,
    )
  }
  const config = await readConfig(git, base, { remote: "origin", branch: target })
  if (options.issue !== undefined && branch !== undefined) {
    const existing = await inspectOccupiedEnvironment(
      { root, name, branch, targetHead: base, issue: options.issue },
      git,
      process,
    )
    if (existing !== undefined) {
      return reportReusedEnvironment(existing, { name, branch, setup: config?.setup, json: options.json }, io)
    }
  }
  let provisioned: { path: string; headSha: string; baseSha: string }
  if (branch === undefined) {
    const environments = join(resolve(root, await workdirOf(git)), "environments")
    const path = resolve(environments, name)
    if (!path.startsWith(`${environments}/`)) throw new Error(`environment name '${name}' escapes ${environments}`)
    mkdirSync(environments, { recursive: true })
    await freshWorktree(git, root, base, path)
    provisioned = { path, headSha: base, baseSha: base }
  } else {
    const workspace = await createGitWorkspace({ repo: root, baysRoot: baysRootOf(), process })
    const result = await workspace.provision({ bay: name, name, branch, base })
    if (result.conclusion !== "success") {
      throw new Error(`yrd: could not open environment '${name}': ${result.error.message}`)
    }
    provisioned = result.output
  }
  const { path, baseSha } = provisioned
  let headSha = provisioned.headSha
  let issueBinding: { issue: string; issueSource: "binding"; issueCommit: string } | undefined
  if (options.issue !== undefined && branch !== undefined) {
    const binding = await bindOpenedEnvironment(path, branch, base, options.issue, process)
    headSha = binding.head
    issueBinding = { issue: binding.issue, issueSource: binding.issueSource, issueCommit: binding.issueCommit }
  }
  const setup = config?.setup
  if (setup !== undefined) {
    const artifacts = join(resolve(root, await workdirOf(git)), "logs", "environments", name, runId())
    try {
      const tree = await checkedTree(path, baseSha, process)
      await runSetup({
        cwd: path,
        process,
        setup: { logDir: join(artifacts, "logs"), run: setup, tmpdir: join(artifacts, "tmp") },
        tree,
      })
    } catch (error) {
      if (!(error instanceof SetupFailed)) throw error
      const result = error.ran.result
      const output = readFileSync(result.log, "utf8").trim() || "(setup produced no output)"
      const why = result.why === undefined ? "" : ` (${result.why})`
      const reason = `environment setup ${result.result} in preserved bay ${path}: exit ${String(result.exit)}${why}\ncommand: ${setup}\n${output}\nlog ${result.log}`
      if (options.json === true) {
        io.stdout(
          `${JSON.stringify({
            base: baseSha,
            name,
            path,
            reused: false,
            setup: "failed",
            status: "partial",
            reason,
            next: `Resolve the setup failure in ${path}; command: ${setup}; inspect ${result.log}. Reusing this environment cannot attest setup completion.`,
          })}\n`,
        )
      }
      throw new Error(reason, { cause: error })
    }
  }
  if (setup !== undefined && options.issue !== undefined && branch !== undefined) {
    try {
      const current = await inspectOccupiedEnvironment(
        { root, name, branch, targetHead: base, issue: options.issue },
        git,
        process,
      )
      if (current === undefined || current.path !== realpathSync(path)) {
        throw new Error(`expected ${branch} to remain registered in ${path}; current path: ${current?.path ?? "none"}`)
      }
      headSha = current.head
      issueBinding = { issue: current.issue, issueSource: "binding", issueCommit: current.issueCommit }
    } catch (error) {
      const reason = `environment identity verification failed after setup in preserved bay ${path}: ${error instanceof Error ? error.message : String(error)}`
      const next = `Inspect git worktree list --porcelain and the branch/binding in ${path} before continuing; setup completed, but the requested work identity is unverified.`
      if (options.json === true) {
        io.stdout(
          `${JSON.stringify({ base: baseSha, name, path, reused: false, setup: "passed", status: "partial", reason, next })}\n`,
        )
      }
      throw new Error(`${reason}\n${next}`, { cause: error })
    }
  }
  if (options.json === true) {
    io.stdout(
      `${JSON.stringify({ base: baseSha, branch, head: headSha, name, path, reused: false, ...issueBinding, setup: setup === undefined ? "not-required" : "passed" })}\n`,
    )
  } else {
    io.stderr(
      `${name} ${branch === undefined ? "detached" : `on ${branch}`} at ${headSha.slice(0, 12)}, cut from ${target} ${baseSha.slice(0, 12)}\n`,
    )
    io.stdout(`${path}\n`)
  }
  return 0
}

/** `yrd env list` — the environments this repository holds, as git holds them. */
export async function listEnvironments(options: EnvListOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  await using process = createProcess({ cwd: root })
  const roots = await environmentRoots(root, gitIn(root, process))
  const prefixes = roots.map((path) => `${existsSync(path) ? realpathSync(path) : resolve(path)}/`)
  const rows: EnvRow[] = (await registeredWorktrees(gitIn(root, process)))
    .filter(({ path }) => prefixes.some((prefix) => path.startsWith(prefix)))
    .map(({ path, head, branch }) => ({
      name: basename(path),
      path,
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
    }))
  if (options.json === true) {
    io.stdout(`${JSON.stringify({ environments: rows })}\n`)
    return 0
  }
  if (rows.length === 0) {
    io.stdout(`no registered environments under ${roots.join(" or ")}; worktrees elsewhere excluded\n`)
    return 0
  }
  io.stdout(`${rows.map((row) => `${row.name}  ${row.branch ?? "(detached)"}  ${row.path}`).join("\n")}\n`)
  return 0
}

/** Refuse before running user teardown; a dirty tree is work, not garbage. */
async function requireClean(git: Git, path: string): Promise<void> {
  const dirty = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])
  if (dirty !== "") throw new Error(`environment ${path} is dirty; preserve or commit its changes before yrd env close`)
}

/** Retained environments preserve user work; GitSuper owns populated-submodule removal. */
export async function closeEnvironment(
  operand: string,
  options: EnvCloseOptions,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const root = requireRepository(io)
  await using process = createProcess({ cwd: root })
  const git = gitIn(root, process)
  const workdir = resolve(root, await workdirOf(git))
  const roots = await environmentRoots(root, git)
  const requested = resolve(io.cwd ?? globalThis.process.cwd(), operand)
  let path: string
  try {
    path = realpathSync(requested)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
      throw error
    }
    throw new Error(
      `environment ${requested} is not registered at an existing path; inspect git worktree list before retrying`,
      { cause: error },
    )
  }
  const registered = (await registeredWorktrees(git)).find((entry) => resolve(entry.path) === path)
  if (registered === undefined) {
    throw new Error(`environment ${requested} is not registered in ${root}; inspect git worktree list`)
  }
  const contained = withinEnvironmentRoots(path, roots)
  if (!contained) {
    throw new Error(
      `environment ${path} is outside environment roots ${roots.join(" or ")}; nothing was removed. Retire a worktree outside these roots with your repository's own worktree cleanup (git worktree remove), not yrd env close`,
    )
  }
  if (registered.locked !== undefined) {
    throw new Error(
      `environment ${path} is locked${registered.locked === "" ? "" : `: ${registered.locked}`}; resolve its owner before closing it`,
    )
  }
  const treeGit = gitIn(path, process)
  await requireClean(treeGit, path)
  const commit = (await treeGit(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(treeGit, commit, { branch: "HEAD", remote: "origin" })
  if (config?.teardown !== undefined) {
    const artifacts = join(workdir, "logs", "environments", basename(path), runId())
    const result = await runCheck({
      cwd: path,
      process,
      tree: { base: commit, candidate: commit },
      spec: { name: "teardown", run: config.teardown },
      logDir: join(artifacts, "logs"),
      tmpdir: join(artifacts, "tmp"),
    })
    if (result.result !== "pass") {
      const output = readFileSync(result.log, "utf8").trim() || "(teardown produced no output)"
      throw new Error(
        `environment teardown ${result.result} in preserved environment ${path}: exit ${String(result.exit)}${result.why === undefined ? "" : ` (${result.why})`}\ncommand: ${config.teardown}\n${output}\nlog ${result.log}`,
      )
    }
    await requireClean(treeGit, path)
  }
  const modules = await treeGit(["ls-tree", commit, "--", ".gitmodules"])
  if (modules.trim() !== "" || options.retain !== undefined) {
    const retain =
      options.retain === undefined
        ? join(workdir, "retained-modules")
        : resolve(io.cwd ?? globalThis.process.cwd(), options.retain)
    let removed: unknown
    try {
      removed = JSON.parse(await git(["super", "--json", "worktree", "remove", path, "--retain", retain]))
    } catch (error) {
      throw new Error(
        `environment ${path} could not close through git super worktree remove: ${error instanceof Error ? error.message : String(error)}; inspect its registration and retention directory ${retain} before retrying; no plain-git fallback was attempted`,
        { cause: error },
      )
    }
    if (
      typeof removed !== "object" ||
      removed === null ||
      !("state" in removed) ||
      removed.state !== "updated" ||
      !("path" in removed) ||
      removed.path !== path ||
      !("proof" in removed) ||
      typeof removed.proof !== "object" ||
      removed.proof === null ||
      !("manifest" in removed.proof) ||
      typeof removed.proof.manifest !== "string"
    ) {
      throw new Error(
        `environment ${path} received malformed git-super removal proof; inspect git worktree list and retention directory ${retain} before retrying`,
      )
    }
    io.stderr(`retained environment removal proof ${removed.proof.manifest}\n`)
  } else {
    // No submodules recorded at this commit, so there is no gitlink for
    // git-super to materialize on the way out. The helper re-asks before it
    // issues the plain removal — the probe reads the TREE, the mutation belongs
    // to the repository that owns the worktree registry.
    await worktreeWithoutSubmodules(treeGit, git, commit, ["remove", path])
  }
  io.stdout(options.json === true ? `${JSON.stringify({ closed: path })}\n` : `closed environment ${path}\n`)
  return 0
}
