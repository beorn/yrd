/**
 * @failure  `yrd check` ran the target's checks in the INVOKING tree, so it
 *           answered "is my cwd green" while wearing the name of
 *           the queue's judgement. A checkout whose dependencies are symlinked
 *           from elsewhere is judged instead of the commit, and the error runs
 *           both ways: an uncommitted mistake turns `check` red over a clean
 *           HEAD, and — the expensive direction — a dirty tree that is
 *           accidentally greener than HEAD reports pass over a change the
 *           queue will fail.
 * @level    l2 (a real remote and a clone under a temporary root;
 *           `coreQueueCommand` driven directly, no process boundary)
 * @consumer every seat that runs `yrd check <name>` before submitting, and
 *           expects it to say what the queue will say
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, readJournals, type Git, type LogRecord } from "@yrd/queue-core"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import type { YrdCliIO } from "../src/types.ts"
import { workdirOf } from "../src/workdir.ts"
import { installSelectedGit } from "./support/selected-git.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

/** The check passes only when `marker.txt` is absent from the tree it runs in. */
const DECLARATION = 'checks:\n  - {no-marker: {run: "test ! -f marker.txt"}}\n'

function capture(cwd: string): Readonly<{ io: YrdCliIO; stdout(): string }> {
  let stdout = ""
  return {
    io: { cwd, color: false, stdout: (text) => void (stdout += text), stderr: () => {} },
    stdout: () => stdout,
  }
}

type World = Readonly<{ git: Git; work: string; workdir: string }>

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-check-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), DECLARATION)
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue and one check"])
  await git(["push", "--quiet", "origin", "main"])
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return { git, work, workdir }
}

async function check(w: World): Promise<Readonly<{ exit: number | undefined; out: string }>> {
  const run = capture(w.work)
  const exit = await coreQueueCommand(
    w.work,
    run.io,
    { command: "check", names: ["no-marker"] },
    { workdir: w.workdir },
  )
  return { exit, out: run.stdout() }
}

describe("the queue workdir is git configuration, never a declaration key", () => {
  // 25716 row 9: the workdir is the queue's root under the host state dir, never beside the repository (25848).
  it("is the queue root under the host state dir when the repository configures none", async () => {
    const w = await world()

    const run = capture(w.work)
    expect(await coreQueueCommand(w.work, run.io, { command: "check", names: ["no-marker"] })).toBe(0)

    const workdir = await workdirOf(w.git, { cwd: w.work })
    expect(workdir.startsWith(join(process.env.XDG_STATE_HOME ?? "", "yrd") + "/")).toBe(true)
    expect(existsSync(join(workdir, "checks"))).toBe(true)
    const common = (await w.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    expect(existsSync(join(common, "yrd"))).toBe(false)
  })

  it("is the queue root under `git config yrd.workdir` when the repository sets one, in whatever scope git resolves it", async () => {
    const w = await world()
    const elsewhere = join(w.workdir, "declared")
    await w.git(["config", "yrd.workdir", elsewhere])

    const run = capture(w.work)
    expect(await coreQueueCommand(w.work, run.io, { command: "check", names: ["no-marker"] })).toBe(0)

    const workdir = await workdirOf(w.git, { cwd: w.work })
    expect(workdir.startsWith(elsewhere + "/")).toBe(true)
    expect(existsSync(join(workdir, "checks"))).toBe(true)
    const common = (await w.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
    expect(existsSync(join(common, "yrd"))).toBe(false)
  })
})

describe("yrd check judges HEAD, never the invoking tree", () => {
  it("passes over an UNCOMMITTED error the invoking tree carries", async () => {
    const w = await world()
    // T1: preparation must keep the invoking command's selection in its fresh tree.
    const selected = await installSelectedGit(w.work)
    // The error exists only in the working tree. No worktree of HEAD can
    // contain it, so a command that builds one passes; a command that reads
    // the invoking tree fails. That difference is the whole test.
    writeFileSync(join(w.work, "marker.txt"), "uncommitted\n")
    expect(existsSync(join(w.work, "marker.txt"))).toBe(true)

    const { exit, out } = await check(w)
    expect(out).toContain("no-marker pass")
    expect(exit).toBe(0)
    const treeCalls = selected.readCalls().filter(({ cwd }) => cwd.startsWith(join(w.workdir, "worktrees")))
    expect(treeCalls.some(({ args }) => args[0] === "rev-parse" && args.includes("HEAD"))).toBe(true)
    expect(treeCalls.some(({ args }) => args[0] === "merge-base")).toBe(true)
  })

  it("POSITIVE CONTROL: fails when the error is COMMITTED", async () => {
    // Without this the pass above is satisfied just as well by a check that
    // can never fail, which is how a green suite certifies nothing.
    const w = await world()
    writeFileSync(join(w.work, "marker.txt"), "committed\n")
    await w.git(["add", "marker.txt"])
    await w.git(["commit", "--quiet", "-m", "the error is in HEAD now"])

    const { exit, out } = await check(w)
    expect(out).toContain("no-marker fail")
    expect(exit).toBe(1)
  })

  it("says that uncommitted paths were not judged, and names the commit that was", async () => {
    // A pass that silently ignored the seat's edits would replace one
    // invisible mismatch with another.
    const w = await world()
    writeFileSync(join(w.work, "marker.txt"), "uncommitted\n")
    await w.git(["add", "marker.txt"])

    const { out } = await check(w)
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(out).toContain("were NOT judged")
    expect(out).toContain(head.slice(0, 12))
  })

  it("a clean tree says nothing about uncommitted work", async () => {
    const w = await world()
    const { exit, out } = await check(w)
    expect(exit).toBe(0)
    expect(out).not.toContain("NOT judged")
  })

  it("writes under the same four directories a queue run writes, keyed by a run id of its own", async () => {
    // One layout, so a reader looking for a check's log looks in one place
    // whether the queue ran it or a seat did:
    // `<workdir>/checks/<change>/<run id>/<phase>/<name>.log`, beside
    // `worktrees/`, `logs/` and `tmp/`.
    const w = await world()
    const head = (await w.git(["rev-parse", "HEAD"])).trim()

    const { exit, out } = await check(w)

    expect(exit).toBe(0)
    const log = /\(log ([^)]+)\)/u.exec(out)?.[1] ?? ""
    expect(log).toContain(join(w.workdir, "checks", `main@${head}`))
    expect(log.endsWith(join("check", "no-marker.log"))).toBe(true)
    // The worktree it made is gone, and so is the run's own directory under it.
    expect(existsSync(join(w.workdir, "worktrees"))).toBe(true)
    expect(readdirSync(join(w.workdir, "worktrees"))).toEqual([])
  })

  it("running the same check name twice keeps both logs; the first survives the second run untouched (24101)", async () => {
    // Two invocations of `yrd check no-marker` are two runs, each minted its
    // own run id (log.ts's runId, time plus a random tail), so each writes
    // under a checks/<change>/<run id>/check/ directory of its own. This is
    // the entry point @i/10-yrd/24101 was about — the queue side already had
    // this proved in run.test.ts's "a check log is written once" — so the
    // same invariant is proved here at `yrd check` itself: a second run of
    // the same check name must not silently replace the first run's log.
    const w = await world()

    const first = await check(w)
    const log1 = /\(log ([^)]+)\)/u.exec(first.out)?.[1] ?? ""
    expect(existsSync(log1)).toBe(true)
    const content1 = readFileSync(log1, "utf8")

    const second = await check(w)
    const log2 = /\(log ([^)]+)\)/u.exec(second.out)?.[1] ?? ""
    expect(existsSync(log2)).toBe(true)

    expect(log2).not.toBe(log1)
    // The second run did not touch the first log's path or its bytes.
    expect(existsSync(log1)).toBe(true)
    expect(readFileSync(log1, "utf8")).toBe(content1)
  })

  it("an unknown check refuses before any worktree is built", async () => {
    const w = await world()
    const run = capture(w.work)
    await expect(
      coreQueueCommand(w.work, run.io, { command: "check", names: ["nope"] }, { workdir: w.workdir }),
    ).rejects.toThrow(/is not a check the target declares/u)
    // Nothing was materialized for a name that was never going to run.
    expect(existsSync(join(w.workdir, "worktrees"))).toBe(false)
  })
})

/**
 * @failure An opted-in check refused without P, or could judge candidate code / publish its subject.
 * @level l2: the actual command caller, real Git and shell children in the existing isolated world.
 * @consumer Authors need the queue's protected P/C lifecycle without any merge possibility.
 */
async function protectedWorld(setup = "true"): Promise<World> {
  const w = await world()
  writeFileSync(
    join(w.work, "program.sh"),
    [
      'test "$YRD_PROGRAM_ROOT" != "$YRD_REPO" || exit 41',
      'test "$(git -C "$YRD_PROGRAM_ROOT" rev-parse HEAD)" = "$YRD_BASE_SHA" || exit 42',
      'test "$(git rev-parse HEAD)" = "$YRD_CANDIDATE_SHA" || exit 43',
      'test "$(cat program.sh)" = "exit 0" || exit 44',
      'printf "protected-program-ran\\n"',
      'test "$(cat value.txt)" = green',
      "",
    ].join("\n"),
  )
  writeFileSync(join(w.work, "value.txt"), "green\n")
  writeFileSync(
    join(w.work, ".yrd.yml"),
    JSON.stringify({
      setup: `printf '%s\\n' "$YRD_REPO" >> ${JSON.stringify(join(w.workdir, "setup-roots"))}; ${setup}`,
      checks: [{ protected: { programRoot: true, run: 'sh "$YRD_PROGRAM_ROOT/program.sh"', scripts: ["program.sh"] } }],
    }),
  )
  await w.git(["add", "."])
  await w.git(["commit", "--quiet", "-m", "target declares protected check"])
  await w.git(["push", "--quiet", "origin", "main"])
  return w
}

function checkJournal(w: World): readonly LogRecord[] {
  const files = readdirSync(join(w.workdir, "logs", "check")).filter((name) => name.endsWith(".jsonl"))
  expect(files).toHaveLength(1)
  return readFileSync(join(w.workdir, "logs", "check", files[0]!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LogRecord)
}

describe("yrd check uses the protected program without publishing", () => {
  it.each([false, true])("judges committed candidate red=%s through P and never writes remote refs", async (red) => {
    const w = await protectedWorld()
    await w.git(["checkout", "--quiet", "-b", "task/control"])
    writeFileSync(join(w.work, "program.sh"), "exit 0\n")
    writeFileSync(join(w.work, "value.txt"), red ? "red\n" : "green\n")
    await w.git(["add", "."])
    await w.git(["commit", "--quiet", "-m", "candidate attempts to replace its judge"])
    const refs = await w.git(["ls-remote", "origin"])
    const localRefs = await w.git(["for-each-ref", "refs/yrd/"])
    const selected = await installSelectedGit(w.work)
    const run = capture(w.work)
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "check", names: ["protected"] },
      {
        workdir: w.workdir,
        env: {
          ...process.env,
          YRD_PROGRAM_ROOT: "/candidate-forged",
          YRD_REPO: "/candidate-forged",
          YRD_CANDIDATE_SHA: "forged",
        },
      },
    )
    expect(exit).toBe(red ? 1 : 0)
    expect(run.stdout()).toContain(red ? "protected fail" : "protected pass")
    const log = /\(log ([^)]+)\)/u.exec(run.stdout())?.[1] ?? ""
    expect(readFileSync(log, "utf8")).toContain("protected-program-ran")
    const setupRoots = readFileSync(join(w.workdir, "setup-roots"), "utf8").trim().split("\n")
    expect(setupRoots).toHaveLength(2)
    expect(setupRoots.map((path) => path.split("/").at(-1))).toEqual(["P", "C"])
    const rows = checkJournal(w)
    for (const stage of [
      "program-program-tree",
      "program-subject-tree",
      "program-program-source",
      "program-subject-source",
    ]) {
      const witnesses = rows.filter((row) => row.kind === "judged" && row.stage === stage)
      expect(witnesses).toHaveLength(2)
      expect(witnesses.every((row) => row.same === true)).toBe(true)
    }
    expect(rows.some((row) => ["merge", "publish", "change"].includes(row.kind))).toBe(false)
    expect(readJournals(join(w.workdir, "logs")).runs.size).toBe(0)
    expect(await w.git(["ls-remote", "origin"])).toBe(refs)
    expect(await w.git(["for-each-ref", "refs/yrd/"])).toBe(localRefs)
    expect(selected.readCalls().some(({ args }) => args.includes("push") || args.includes("update-ref"))).toBe(false)
    expect(readdirSync(join(w.workdir, "worktrees"))).toEqual([])
    const trees = (await w.git(["worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
    expect(trees).toEqual([`worktree ${w.work}`])
  })

  // The shared lifecycle must remove all prepared roots on setup or identity refusal,
  // before a check can report an exit-code verdict. Legacy tests never crossed P/C.
  it.each([
    ["target setup", "exit 1", /setup fail/u, 1],
    ["subject setup", 'if [ "$YRD_CANDIDATE_SHA" != "$YRD_BASE_SHA" ]; then exit 1; fi', /setup fail/u, 2],
    [
      "source",
      'if [ "$YRD_CANDIDATE_SHA" != "$YRD_BASE_SHA" ]; then echo mutated > program.sh; fi',
      /subject source.*differs/u,
      2,
    ],
    [
      "program after preparation",
      'if [ "$YRD_CANDIDATE_SHA" != "$YRD_BASE_SHA" ]; then echo mutated > ../P/program.sh; fi',
      /program source.*differs/u,
      2,
    ],
    [
      "head",
      'if [ "$YRD_CANDIDATE_SHA" != "$YRD_BASE_SHA" ]; then echo moved > moved.txt; git add moved.txt; git -c user.name=yrd -c user.email=yrd@test commit --quiet -m moved; fi',
      /subject.*moved during setup/u,
      2,
    ],
    [
      "changed product",
      'if [ "$YRD_CANDIDATE_SHA" != "$YRD_BASE_SHA" ]; then echo mutated > value.txt; fi',
      /subject.*differs from its recorded candidate blobs/u,
      2,
    ],
  ] as const)("cleans roots and retains evidence after %s failure", async (_name, setup, error, count) => {
    const w = await protectedWorld(setup)
    await w.git(["checkout", "--quiet", "-b", "task/control"])
    writeFileSync(join(w.work, "value.txt"), "red\n")
    await w.git(["add", "value.txt"])
    await w.git(["commit", "--quiet", "-m", "candidate product"])
    const refs = await w.git(["ls-remote", "origin"])
    const run = capture(w.work)
    await expect(
      coreQueueCommand(w.work, run.io, { command: "check", names: ["protected"] }, { workdir: w.workdir }),
    ).rejects.toThrow(error)
    const setupRoots = readFileSync(join(w.workdir, "setup-roots"), "utf8").trim().split("\n")
    expect(setupRoots).toHaveLength(count)
    for (const path of setupRoots) expect(existsSync(path)).toBe(false)
    expect(readdirSync(join(w.workdir, "worktrees"))).toEqual([])
    expect(
      (await w.git(["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree ")),
    ).toEqual([`worktree ${w.work}`])
    expect(await w.git(["ls-remote", "origin"])).toBe(refs)
    const rows = checkJournal(w)
    expect(rows.some((row) => row.kind === "check" && row.name === "protected")).toBe(false)
    if (_name === "target setup" || _name === "subject setup") {
      const failed = rows.find((row) => row.kind === "check" && typeof row.end === "string")
      expect(failed?.log).toEqual(expect.any(String))
      expect(existsSync(String(failed?.log))).toBe(true)
    } else {
      expect(rows.some((row) => row.kind === "judged" && row.same === false)).toBe(true)
    }
  })
})
