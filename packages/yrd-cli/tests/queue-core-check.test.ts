/**
 * @failure  `yrd check` ran the queue branch's checks in the INVOKING tree, so it
 *           answered "is my working directory green" while wearing the name of
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

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, type Git } from "@yrd/queue-core"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import type { YrdCliIO } from "../src/types.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

/** The check passes only when `marker.txt` is absent from the tree it runs in. */
const DECLARATION = 'remote: origin\nbranch: main\nchecks:\n  - {no-marker: {run: "test ! -f marker.txt"}}\n'

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

describe("yrd check judges HEAD, never the invoking tree", () => {
  it("passes over an UNCOMMITTED error the invoking tree carries", async () => {
    const w = await world()
    // The error exists only in the working tree. No worktree of HEAD can
    // contain it, so a command that builds one passes; a command that reads
    // the invoking tree fails. That difference is the whole test.
    writeFileSync(join(w.work, "marker.txt"), "uncommitted\n")
    expect(existsSync(join(w.work, "marker.txt"))).toBe(true)

    const { exit, out } = await check(w)
    expect(out).toContain("no-marker pass")
    expect(exit).toBe(0)
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

  it("an unknown check refuses before any worktree is built", async () => {
    const w = await world()
    const run = capture(w.work)
    await expect(
      coreQueueCommand(w.work, run.io, { command: "check", names: ["nope"] }, { workdir: w.workdir }),
    ).rejects.toThrow(/is not a check the queue's branch declares/u)
    // Nothing was materialized for a name that was never going to run.
    expect(existsSync(join(w.workdir, "check"))).toBe(false)
  })
})
