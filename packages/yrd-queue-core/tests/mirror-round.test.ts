/**
 * @failure A round composes each candidate by fetching every component from GitHub, one ssh login per
 *          read, although the host already holds a mirror refreshed seconds earlier (25570 row 1).
 * @level   l2 (a real round, real git-super composes, a stand-in ssh that serves a local "host" and logs each login)
 * @consumer the queue service's rounds, and the receipt that counts their logins (W2, W4)
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { gitIn, queueRun, submit } from "../src/index.ts"
import type { Git, QueueRunOptions } from "../src/index.ts"

const gitSuperBin = resolve(import.meta.dirname, "../../../../git-super/bin")
if (!existsSync(gitSuperBin)) throw new Error(`git-super bin directory not found at ${gitSuperBin}`)
beforeEach(() => {
  process.env.PATH = `${gitSuperBin}:${process.env.PATH ?? ""}`
})

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const HOSTED = "ssh://git@hosted.test/owned/submodule.git"
const ROOT = "https://root.test/owned/root.git"

type Login = Readonly<{ cwd: string; service: "git-upload-pack" | "git-receive-pack"; path: string }>

type World = Readonly<{
  git: Git
  work: string
  store: string
  queueClone: string
  workdir: string
  submoduleWork: string
  logins(): readonly Login[]
  forget(): void
  options(): Promise<QueueRunOptions>
}>

/**
 * A root at a local path whose one submodule is HOSTED: its URL is ssh, and the
 * stand-in ssh serves it from `<root>/hosted` and writes one line per login with
 * the directory git ran it from. The root itself is not hosted, so every login
 * the log holds is a component read or write.
 */
async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-mirror-round-"))
  roots.push(root)
  const hosted = join(root, "hosted")
  const log = join(root, "ssh.log")
  const ssh = join(root, "fake-ssh")
  writeFileSync(
    ssh,
    [
      "#!/bin/sh",
      "for last; do :; done",
      `printf '%s\\t%s\\n' "$(pwd -P)" "$last" >> '${log}'`,
      `exec sh -c "$(printf '%s' "$last" | sed "s#'/owned/#'${hosted}/owned/#")"`,
      "",
    ].join("\n"),
  )
  chmodSync(ssh, 0o755)
  process.env.GIT_SSH_COMMAND = ssh
  // Every traced process records the url rewrites it was given, so a route is visible per process (W2).
  process.env.GIT_TRACE2_CONFIG_PARAMS = "url.*.insteadof"
  const remote = join(root, "remote.git")
  process.env.GIT_CONFIG_COUNT = "2"
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
  process.env.GIT_CONFIG_VALUE_0 = "always"
  // The root needs a hosted identity to be pushed to, but it is not a component: routed locally, never logged.
  process.env.GIT_CONFIG_KEY_1 = `url.${remote}.insteadOf`
  process.env.GIT_CONFIG_VALUE_1 = ROOT
  const seed = gitIn(root)
  const identity = async (git: Git): Promise<void> => {
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
  }

  mkdirSync(join(hosted, "owned"), { recursive: true })
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", join(hosted, "owned", "submodule.git")])
  const submoduleWork = join(root, "submodule-work")
  await seed(["clone", "--quiet", HOSTED, submoduleWork])
  const sub = gitIn(submoduleWork)
  await identity(sub)
  await sub(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(submoduleWork, "lib.txt"), "one\n")
  await sub(["add", "lib.txt"])
  await sub(["commit", "--quiet", "-m", "one"])
  await sub(["push", "--quiet", "origin", "main"])

  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await identity(git)
  await git(["remote", "set-url", "origin", ROOT])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["submodule", "add", "--quiet", HOSTED, "submodule"])
  await git(["add", ".yrd.yml", ".gitmodules", "submodule"])
  await git(["commit", "--quiet", "-m", "base, with the hosted submodule at its main"])
  await git(["push", "--quiet", "origin", "main"])
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  // The queue's own clone, as the service holds it: no checkout, so every component object a compose
  // needs comes from its reference stores or a remote, never from a submitter's tree.
  const queueClone = join(root, "queue-clone")
  await seed(["clone", "--quiet", "--no-checkout", "--origin", "origin", ROOT, queueClone])
  const queueGit = gitIn(queueClone)
  await identity(queueGit)
  const store = join(root, "git-mirror")
  return {
    git,
    work,
    store,
    queueClone,
    workdir,
    submoduleWork,
    logins: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => {
              const [cwd = "", command = ""] = line.split("\t")
              const [service = "", path = ""] = command.split(" ")
              return { cwd, service: service as Login["service"], path: path.replace(/'/gu, "") }
            })
            // git's own `ssh -G <host>` variant probe is not a login: only a git service command is.
            .filter((login) => login.service === "git-upload-pack" || login.service === "git-receive-pack")
        : [],
    forget: () => rmSync(log, { force: true }),
    options: async () => ({
      checks: [],
      configBlob: "test-config",
      env: { ...process.env, PATH: `${gitSuperBin}:${process.env.PATH ?? ""}` },
      mirror: store,
      populateReference: true,
      repo: queueClone,
      target: { branch: "main", remote: "origin" },
      git: queueGit,
      targetSha: (await git(["ls-remote", "--refs", "origin", "refs/heads/main"])).trim().split(/\s+/u)[0] ?? "",
      workdir,
    }),
  }
}

/** A commit ahead of the hosted main, pushed under a branch, and a submitted root change that moves the gitlink to it. */
async function submitAhead(w: World, branch: string): Promise<string> {
  const sub = gitIn(w.submoduleWork)
  await sub(["checkout", "--quiet", "-b", `ahead-${branch}`, "main"])
  writeFileSync(join(w.submoduleWork, "lib.txt"), `${branch}\n`)
  await sub(["commit", "--quiet", "-am", `${branch}, ahead of main`])
  await sub(["push", "--quiet", "origin", `ahead-${branch}`])
  const ahead = (await sub(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const pinned = gitIn(join(w.work, "submodule"))
  await pinned(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await pinned(["checkout", "--quiet", ahead])
  await w.git(["add", "submodule"])
  await w.git(["commit", "--quiet", "-m", `${branch}: move the submodule gitlink to ${ahead.slice(0, 12)}`])
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/10", target: { branch: "main", remote: "origin" } })
  return ahead
}

describe("a round composes from the host's mirror", () => {
  it("W4: after the post-snapshot refresh, the compose makes no login; only the refresh and the publication do", async () => {
    const w = await world()
    await submitAhead(w, "task/mirrored")
    w.forget()

    const outcome = await queueRun(await w.options())

    expect(outcome.merged).toEqual(["task/mirrored"])
    const logins = w.logins()
    const reads = logins.filter((login) => login.service === "git-upload-pack")
    const writes = logins.filter((login) => login.service === "git-receive-pack")
    // One read per mirrored repository, made from inside the store: the refresh (here the mirror's first clone), and
    // nothing else. Before the round was wired, the reference store's clone logged in from the queue's clone.
    expect(reads.map((login) => ({ inStore: login.cwd.startsWith(w.store), path: login.path }))).toEqual([
      { inStore: true, path: "/owned/submodule.git" },
    ])
    // Whatever the landing writes to the component goes to the host, never into the store (W1 at round scale).
    for (const write of writes) expect(write.cwd.startsWith(w.store)).toBe(false)
  })

  it("W2: the queue's own Git, which makes every decisive read and lease, never carries a mirror route", async () => {
    const w = await world()
    await submitAhead(w, "task/decisive")
    const outcome = await queueRun(await w.options())
    expect(outcome.merged).toEqual(["task/decisive"])

    const processes = routedProcesses(w)
    const queueOwn = processes.filter((process) => process.repo === realpathSync(w.queueClone))
    const decisive = queueOwn.filter((process) => process.argv.some((arg) => ["ls-remote", "push", "fetch"].includes(arg)))
    // Non-vacuous on both sides: the queue did read and write its remote, and some compose did take the route.
    expect(decisive.length).toBeGreaterThan(0)
    expect(processes.some((process) => process.routed)).toBe(true)
    expect(decisive.filter((process) => process.routed).map((process) => process.argv.join(" "))).toEqual([])
  })
})

/** Every git process of the one round in the workdir, with whether it was given a route into the store. */
function routedProcesses(
  w: World,
): readonly Readonly<{ argv: readonly string[]; repo: string | undefined; routed: boolean }>[] {
  const logs = join(w.workdir, "logs")
  const runs = readdirSync(logs).filter((name) => name.startsWith("q-") && !name.endsWith(".jsonl"))
  if (runs.length !== 1) throw new Error(`expected one round under ${logs}, found ${runs.join(", ") || "none"}`)
  const trace = join(logs, runs[0] ?? "", "trace2")
  const found: Array<Readonly<{ argv: readonly string[]; repo: string | undefined; routed: boolean }>> = []
  for (const file of readdirSync(trace)) {
    let argv: readonly string[] = []
    let repo: string | undefined
    let routed = false
    for (const line of readFileSync(join(trace, file), "utf8").split("\n")) {
      if (line === "") continue
      const event = JSON.parse(line) as { event?: string; argv?: string[]; param?: string; worktree?: string }
      if (event.event === "start" && event.argv !== undefined) argv = event.argv
      // The repository the process opened, whether it was named by cwd or by --git-dir.
      if (event.event === "def_repo" && event.worktree !== undefined) repo = realpathSync(event.worktree)
      if (event.event === "def_param" && event.param?.startsWith(`url.file://${w.store}`) === true) routed = true
    }
    found.push({ argv, repo, routed })
  }
  return found
}
