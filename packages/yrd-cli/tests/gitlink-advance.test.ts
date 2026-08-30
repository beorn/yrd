/**
 * @failure Advancing a submodule's gitlink stays a hand-built sequence — a bespoke subject, a
 *          hand-cut branch, a hand-staged gitlink, a hand-driven submit — so no two advances
 *          look alike and each one costs an author the whole composition.
 * @level l3
 * @consumer @i/10-yrd/gitlink-advance-is-one-command
 *
 * Thirteen gitlink-only bumps reached hh main on 2026-08-29/30 and all thirteen were written
 * by hand. The end-to-end case below is the contract that replaces them: ONE invocation, and
 * the message, the Change-Id and the queue position all come back from it.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger } from "loggily"
import { createDefaultYrdApp, type YrdCliApp, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { failureFact } from "@yrd/core"
import { createJournal } from "@yrd/persistence"
import { createProcess } from "@yrd/process"
import { afterEach, describe, expect, it } from "vitest"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
import { gitlinkAdvanceMessage, gitlinkAdvanceName, resolveSubmoduleOperand } from "../src/gitlink-advance.ts"
import { runYrd as runYrdRaw } from "../src/run.ts"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr || stdout}`)
  return stdout.trim()
}

async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(path, "init", "-q", "-b", "main")
  await git(path, "config", "user.name", "Yrd Test")
  await git(path, "config", "user.email", "yrd@example.invalid")
}

const config: ResolvedYrdProjectConfig = {
  base: "main",
  batch: 1,
  steps: ["check", "merge"],
  requires: [],
  definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
  contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
}

type Fixture = Readonly<{
  root: string
  submodule: string
  /** The submodule's three main commits, oldest first. */
  main: readonly [string, string, string]
  /** A commit pushed to the submodule's origin but never merged on its main. */
  offMain: string
  /** A commit that exists only locally in the submodule and descends from its main. */
  descendant: string
}>

/**
 * A superproject with its own origin, recording a submodule whose main carries three
 * commits, with the gitlink parked on the first. Everything an advance touches is real: two
 * bare remotes, a working submodule checkout, and a `.yrd.yml`-shaped config.
 */
async function superprojectWithThreeCommitSubmodule(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "yrd-gitlink-advance-"))
  cleanups.push(() => rm(parent, { recursive: true, force: true }))
  const submodule = join(parent, "submodule")
  const submoduleRemote = join(parent, "submodule.git")
  const root = join(parent, "root")
  const rootRemote = join(parent, "root.git")

  await repository(submodule)
  const commit = async (text: string, message: string): Promise<string> => {
    await writeFile(join(submodule, "submodule.txt"), `${text}\n`)
    await git(submodule, "add", "submodule.txt")
    await git(submodule, "commit", "-qm", message)
    return git(submodule, "rev-parse", "HEAD")
  }
  const one = await commit("one", "submodule: the first thing")
  const two = await commit("two", "submodule: the second thing")
  const three = await commit("three", "submodule: the third thing")
  await git(parent, "init", "-q", "--bare", "-b", "main", submoduleRemote)
  await git(submodule, "remote", "add", "origin", submoduleRemote)
  await git(submodule, "push", "-q", "-u", "origin", "main")

  // Published on the submodule's origin, never merged on its main — a real, pushed commit
  // that is nevertheless not a min commit.
  await git(submodule, "checkout", "-q", "-b", "someones-wip", one)
  await writeFile(join(submodule, "wip.txt"), "wip\n")
  await git(submodule, "add", "wip.txt")
  await git(submodule, "commit", "-qm", "submodule: somebody's unmerged work")
  const offMain = await git(submodule, "rev-parse", "HEAD")
  await git(submodule, "push", "-q", "origin", `${offMain}:refs/heads/someones-wip`)

  // A local-only descendant of main — the case the verb is allowed to publish itself.
  await git(submodule, "checkout", "-q", "-b", "ahead", three)
  await writeFile(join(submodule, "submodule.txt"), "four\n")
  await git(submodule, "commit", "-qam", "submodule: the fourth thing")
  const descendant = await git(submodule, "rev-parse", "HEAD")
  await git(submodule, "checkout", "-q", "main")

  await repository(root)
  await writeFile(join(root, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n')
  await git(root, "add", ".yrd.yml")
  await git(root, "commit", "-qm", "yrd config")
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "dep")
  await git(join(root, "dep"), "remote", "set-url", "origin", submoduleRemote)
  await git(join(root, "dep"), "fetch", "-q", "origin")
  await git(join(root, "dep"), "checkout", "-q", one)
  await git(root, "add", "dep")
  await git(root, "commit", "-qm", "record dep at its first commit")
  await git(parent, "init", "-q", "--bare", "-b", "main", rootRemote)
  await git(root, "remote", "add", "origin", rootRemote)
  await git(root, "push", "-q", "-u", "origin", "main")

  return { root, submodule, main: [one, two, three], offMain, descendant }
}

async function appFor(repo: string): Promise<{
  app: YrdCliApp
  process: ReturnType<typeof createProcess>
  journal: NonNullable<YrdCliServices["journal"]>
}> {
  const stateDir = join(repo, ".git", "yrd")
  const log = createLogger("yrd", [{ level: "silent" }])
  const runtimeProcess = createProcess({ cwd: repo })
  const journal = createJournal({ dir: stateDir, inject: { log } })
  const app = await createDefaultYrdApp({
    repo,
    stateDir,
    baysRoot: join(repo, ".bays"),
    journal,
    process: runtimeProcess,
    config,
    log,
  })
  cleanups.push(async () => {
    await app.close()
    await runtimeProcess.close()
  })
  // The mutable journal exposes its floor raise as a non-enumerable `administration`
  // capability; the CLI takes it as a service. `importOrphan` is required by that service
  // type and is not part of this suite — it throws rather than pretending to work.
  const { bump } = (journal as unknown as { administration: NonNullable<YrdCliServices["journal"]> }).administration
  const administration: NonNullable<YrdCliServices["journal"]> = {
    importOrphan: () => {
      throw new Error("gitlink-advance fixture installs no orphan journal importer")
    },
    ...(bump === undefined ? {} : { bump }),
  }
  return { app, process: runtimeProcess, journal: administration }
}

function outputIO(repo: string): { io: YrdCliIO; stdout: () => string; stderr: () => string } {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      cwd: repo,
      runner: "cli-test",
      leaseMs: 60_000,
    } as YrdCliIO,
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

/**
 * A fresh fixture journal starts at floor v0 and refuses every write until the floor is
 * raised to the schema the running code requires. The number is the runtime's own, and if it
 * ever moves this fails loudly with the exact `yrd admin journal bump <n>` to use — which is
 * the whole reason the raise is explicit rather than automatic.
 */
const JOURNAL_FLOOR = 3

async function runAdvance(
  repo: string,
  args: readonly string[],
): Promise<{ exit: number; stdout: string; stderr: string; app: YrdCliApp }> {
  const { app, process: runtimeProcess, journal } = await appFor(repo)
  const services: YrdCliServices = {
    process: runtimeProcess,
    base: "main",
    journal,
    queueReadModel: testQueueReadModel(app),
    // The advance's own delivery is what this suite is about; the repository's required
    // checks are somebody else's contract, stubbed green so a check failure cannot be
    // mistaken for the composition failing.
    checks: {
      names: [],
      run: async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 0, timedOut: false }),
      install: async (cwd: string) => join(cwd, ".git/yrd/hooks/pre-submit"),
    },
  }
  const bump = outputIO(repo)
  const bumped = await runYrdRaw(app, ["yrd", "admin", "journal", "bump", String(JOURNAL_FLOOR)], bump.io, services)
  if (bumped !== 0) throw new Error(`journal floor raise failed: ${bump.stdout()}\n${bump.stderr()}`)
  const out = outputIO(repo)
  const exit = await runYrdRaw(app, ["yrd", ...args], out.io, services)
  return { exit, stdout: out.stdout(), stderr: out.stderr(), app }
}

/**
 * A refusal read from the JSON envelope, so the assertion names the typed CODE — the stable
 * contract — rather than only the prose a human sees.
 */
async function refusalFrom(repo: string, args: readonly string[]): Promise<{ exit: number; text: string }> {
  const result = await runAdvance(repo, [...args, "--json"])
  return { exit: result.exit, text: `${result.stdout}\n${result.stderr}` }
}

describe("yrd gitlink advance", { timeout: 120_000 }, () => {
  it("settles the whole advance in one invocation: message, Change-Id and queue position", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const result = await runAdvance(fixture.root, ["gitlink", "advance", "dep"])
    expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0)

    // The change id and where it sits — both back from the one call, with no `pr view`.
    expect(result.stdout).toMatch(/PR\d+ queued at position \d+ — advance dep [0-9a-f]{7}\.\.[0-9a-f]{7}/u)

    // The generated commit is real, on the pushed branch, with the generated message.
    const branch = `task/${gitlinkAdvanceName("dep", fixture.main[2])}`
    // Positive control for the pattern the refusal cases below assert is EMPTY: it matches a
    // branch that exists, so an empty result there is evidence and not a mis-typed glob.
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).not.toBe("")
    const message = await git(fixture.root, "log", "-1", "--format=%B", `refs/heads/${branch}`)
    expect(message).toContain(
      `chore(dep): advance gitlink ${fixture.main[0].slice(0, 7)}..${fixture.main[2].slice(0, 7)}`,
    )
    // The submodule's own first-parent subjects, in order, as the body.
    expect(message).toContain("- submodule: the second thing")
    expect(message).toContain("- submodule: the third thing")
    // Never the commit the gitlink already recorded.
    expect(message).not.toContain("- submodule: the first thing")
    expect(message).toMatch(/^Change-Id: I[0-9a-f]{40}$/mu)

    // And the commit actually moves the gitlink.
    expect(await git(fixture.root, "rev-parse", `refs/heads/${branch}:dep`)).toBe(fixture.main[2])
    // Exactly one commit: a gitlink advance is one gitlink and nothing else.
    expect(await git(fixture.root, "rev-list", "--count", `origin/main..refs/heads/${branch}`)).toBe("1")
    expect(await git(fixture.root, "diff", "--name-only", `origin/main..refs/heads/${branch}`)).toBe("dep")
  })

  it("refuses a target the submodule's main never took, naming min-commit-unpublished and the cure", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const refusal = await refusalFrom(fixture.root, ["gitlink", "advance", "dep", fixture.offMain])

    expect(refusal.exit).not.toBe(0)
    expect(refusal.text).toContain("min-commit-unpublished")
    expect(refusal.text).toContain("merge it on that submodule's own main first")
    // Nothing was created on the way to the refusal.
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).toBe("")
  })

  it("refuses a target behind the recorded gitlink rather than composing a backwards bump", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()
    // Move the recorded gitlink forward to the third commit first.
    await git(join(fixture.root, "dep"), "checkout", "-q", fixture.main[2])
    await git(fixture.root, "add", "dep")
    await git(fixture.root, "commit", "-qm", "record dep at its third commit")
    await git(fixture.root, "push", "-q", "origin", "main")

    const refusal = await refusalFrom(fixture.root, ["gitlink", "advance", "dep", fixture.main[0]])

    expect(refusal.exit).not.toBe(0)
    expect(refusal.text).toContain("gitlink-moves-backward")
    expect(refusal.text).toContain("is behind by 2 commits")
    expect(refusal.text).toContain("re-merge this change onto current main")
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).toBe("")
  })

  it("--dry-run settles and prints the whole advance, and creates nothing", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const result = await runAdvance(fixture.root, ["gitlink", "advance", "dep", "--dry-run"])

    expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("submodule dep (dep)")
    expect(result.stdout).toContain(`${fixture.main[0]} -> ${fixture.main[2]}`)
    expect(result.stdout).toMatch(/change id {2}I[0-9a-f]{40}/u)
    expect(result.stdout).toContain("chore(dep): advance gitlink")
    // Nothing published, nothing branched, nothing submitted.
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).toBe("")
    expect(await git(fixture.root, "rev-parse", "HEAD:dep")).toBe(fixture.main[0])
  })

  it("fast-forwards the submodule's own main when the target descends from it", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()
    const remote = join(fixture.root, "..", "submodule.git")
    expect(await git(remote, "rev-parse", "main")).toBe(fixture.main[2])
    // The target is local to the submodule checkout and has never been pushed anywhere.
    await git(join(fixture.root, "dep"), "fetch", "-q", fixture.submodule, fixture.descendant)

    const result = await runAdvance(fixture.root, ["gitlink", "advance", "dep", fixture.descendant])

    expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0)
    // Submodules are `landing: none`, so the verb publishes the min commit itself — and says so.
    expect(await git(remote, "rev-parse", "main")).toBe(fixture.descendant)
    expect(result.stderr).toContain("fast-forwarded dep main")
  })

  it("names every candidate when the operand matches no submodule", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const refusal = await refusalFrom(fixture.root, ["gitlink", "advance", "vendor/nope"])

    expect(refusal.exit).not.toBe(0)
    expect(refusal.text).toContain("unknown-submodule")
    expect(refusal.text).toContain("records no submodule 'vendor/nope'")
    expect(refusal.text).toContain("it records dep")
  })

  it("refuses when the gitlink is already where the advance would put it", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const refusal = await refusalFrom(fixture.root, ["gitlink", "advance", "dep", fixture.main[0]])

    expect(refusal.exit).not.toBe(0)
    expect(refusal.text).toContain("gitlink-already-current")
    expect(refusal.text).toContain("nothing to advance")
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).toBe("")
  })
})

describe("gitlinkAdvanceMessage", () => {
  const from = "a".repeat(40)
  const to = "b".repeat(40)

  it("writes the subject, the submodule's subjects as the body, and the Change-Id trailer", () => {
    const message = gitlinkAdvanceMessage({
      name: "yrd",
      path: "vendor/yrd",
      from,
      to,
      subjects: ["fix(cli): one", "feat(queue): two"],
      changeId: `I${"c".repeat(40)}`,
    })

    expect(message.split("\n")[0]).toBe("chore(yrd): advance gitlink aaaaaaa..bbbbbbb")
    expect(message).toContain("Advances vendor/yrd by 2 commits:")
    expect(message).toContain("- fix(cli): one")
    expect(message).toContain("- feat(queue): two")
    expect(message.trimEnd().split("\n").at(-1)).toBe(`Change-Id: I${"c".repeat(40)}`)
  })

  it("stays singular for one commit and says so plainly when the range is empty", () => {
    expect(gitlinkAdvanceMessage({ name: "km", path: "km", from, to, subjects: ["only"], changeId: "I0" })).toContain(
      "Advances km by 1 commit:",
    )
    expect(gitlinkAdvanceMessage({ name: "km", path: "km", from, to, subjects: [], changeId: "I0" })).toContain(
      `No first-parent commits between ${from} and ${to}.`,
    )
  })
})

describe("resolveSubmoduleOperand", () => {
  const entries = [
    { name: "vendor/yrd", path: "vendor/yrd" },
    { name: "km", path: "km" },
  ]

  it("accepts the full path and the bare name for the same submodule", () => {
    expect(resolveSubmoduleOperand("vendor/yrd", entries)).toEqual({ name: "vendor/yrd", path: "vendor/yrd" })
    expect(resolveSubmoduleOperand("yrd", entries)).toEqual({ name: "vendor/yrd", path: "vendor/yrd" })
    expect(resolveSubmoduleOperand("vendor/yrd/", entries)).toEqual({ name: "vendor/yrd", path: "vendor/yrd" })
  })

  it("refuses an unknown operand by naming what this repository does record", () => {
    try {
      resolveSubmoduleOperand("ag", entries)
      throw new Error("expected a refusal")
    } catch (error) {
      const fact = failureFact(error)
      expect(fact?.code).toBe("unknown-submodule")
      expect(fact?.message).toContain("vendor/yrd, km")
    }
  })

  it("refuses an ambiguous operand instead of guessing", () => {
    try {
      resolveSubmoduleOperand("yrd", [
        { name: "vendor/yrd", path: "vendor/yrd" },
        { name: "yrd", path: "tools/yrd" },
      ])
      throw new Error("expected a refusal")
    } catch (error) {
      expect(failureFact(error)?.code).toBe("ambiguous-submodule")
    }
  })
})
