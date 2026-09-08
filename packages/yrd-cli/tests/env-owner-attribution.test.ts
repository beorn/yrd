/**
 * @failure A bay's directory name is exactly the caller's `--bay` argument, so
 *          the worktree carries no owner. `yrd env list` derives its row name
 *          from `basename(path)` and can only report that same unowned label,
 *          which leaves a reconciler no way to tell a live bay from an orphan
 *          without a lookup table beside git's own registry.
 * @level   l2 (real bare remote and real retained Git worktree)
 * @consumer every seat opening an environment through `yrd env open`
 * @bead    @i/4-supervision/24306-worktrees-have-three-homes-and-no-lifecycle-that-guarantees-removal
 *
 * Mechanism 2 of 24306. @cto's verdict (2026-09-08) approved the primitive —
 * a worktree is an attribute of a durable owner and the path encodes the owner
 * id — and a git 2.53 probe the same day fixed WHICH field carries it: `git
 * worktree list --porcelain` prints `worktree <path>`, `HEAD` and `branch` and
 * never the registration name, so the path is the field a reconciler reads.
 *
 * `env-commands.ts` composes the bay directory at `resolve(environments, name)`
 * from the caller's `--bay` name alone, and `list` reads it back with
 * `basename(path)`. Both ends therefore already agree on one source of truth —
 * git's own worktrees, per this command's own docstring, "if git does not have
 * the worktree, the environment is not there" — and the only thing missing is
 * that the name says nothing about who owns it.
 *
 * RED until the owner-attribution primitive lands. Where that primitive LIVES
 * is an open decision with @chief (bearly holds it today; yrd has no bearly
 * dependency, and the km root reconciler needs it too), so these tests assert
 * the CONTRACT rather than importing it — they stay honest under any placement.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, type Git } from "@yrd/queue-core"
import { openEnvironment } from "../src/env-commands.ts"
import type { YrdCliIO } from "../src/types.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

/** The ruled contract, restated locally so this test does not depend on where
 * the shared primitive ends up living. `<label>~<owner>`; anything without
 * exactly one separator is unattributable rather than owned by a guess. */
const OWNER_SEPARATOR = "~"
function ownerOf(pathOrName: string): string | undefined {
  const parts = basename(pathOrName).split(OWNER_SEPARATOR)
  if (parts.length !== 2) return undefined
  const [label, owner] = parts
  if (label === undefined || owner === undefined) return undefined
  if (label.length === 0 || owner.length === 0) return undefined
  return owner
}

type World = Readonly<{ git: Git; work: string }>

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-env-owner-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "env-owner@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), 'setup: "true"\n')
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "declare environment setup"])
  await git(["push", "--quiet", "origin", "main"])
  return { git, work }
}

describe("a bay's path names its owner (24306 mechanism 2)", () => {
  it("today's bay path carries no owner — this is the defect", async () => {
    const w = await world()
    // The name a caller passes today is the whole directory name. Whatever the
    // caller chooses, nothing in it attributes the bay to a durable owner.
    expect(ownerOf(join(w.work, ".bays", "dev11-24153"))).toBeUndefined()
    expect(ownerOf(join(w.work, ".bays", "some-task"))).toBeUndefined()
  })

  it("a bay opened for an owner yields that owner from its path alone", async () => {
    const w = await world()
    const owner = "hab-session-7f3a1c"
    const opened = await openBayForOwner(w, "24153", owner)
    expect(ownerOf(opened)).toBe(owner)
  })

  it("two owners get distinct, each-attributable directories", async () => {
    // Distinct LABELS, because the branch still carries the bare label and git
    // refuses to check one ref out into two worktrees. What happens when the
    // labels are the SAME is no longer open — see the next test.
    const w = await world()
    const a = await openBayForOwner(w, "24153", "hab-session-aaaa")
    const b = await openBayForOwner(w, "24154", "hab-session-bbbb")
    expect(a).not.toBe(b)
    expect(ownerOf(a)).toBe("hab-session-aaaa")
    expect(ownerOf(b)).toBe("hab-session-bbbb")
  })

  it("a second owner opening a held label is refused, and the refusal names the holder", async () => {
    // @chief's ruling, 2026-09-08: one label is one branch is one piece of work.
    //
    // This assertion is deliberately on the refusal's OWN phrase. A second open
    // already fails without any guard -- git will not check `task/24153` out
    // into two worktrees -- and git's message quotes the first worktree's path,
    // which contains both the label and the holder's id. So asserting only that
    // the error mentions "hab-session-aaaa" passes with nothing implemented at
    // all. Matching a string that ANY failure would produce is not a test.
    const w = await world()
    const held = await openBayForOwner(w, "24153", "hab-session-aaaa")
    expect(ownerOf(held)).toBe("hab-session-aaaa")

    const second = openBayForOwner(w, "24153", "hab-session-bbbb")
    await expect(second).rejects.toThrow(/one label is one branch is one piece of work/)
    // ...and having established it is OUR refusal, that it names the holder --
    // the entire difference between a refusal and an obstacle.
    await expect(second).rejects.toThrow(/hab-session-aaaa/)
  })

  it("the second-owner refusal does not misfire on the owner that already holds the label", async () => {
    // The guard is about a SECOND owner, not about reopening. A reopen by the
    // SAME owner fails today for an unrelated reason (the bay directory exists),
    // and that is not what this test pins: it pins that the owner is never told
    // someone else holds a label it holds itself. Asserting idempotence here
    // would encode my assumption rather than the ruling.
    const w = await world()
    await openBayForOwner(w, "24153", "hab-session-aaaa")
    const again = openBayForOwner(w, "24153", "hab-session-aaaa")
    await expect(again).rejects.toThrow()
    await expect(again).rejects.not.toThrow(/one label is one branch is one piece of work/)
  })
})

/** The seam under test: opening a bay while an owner is in scope must produce a
 * self-attributing path. `--json` prints the record the command composed, so the
 * path is read from the command's own output rather than guessed from the label. */
async function openBayForOwner(w: World, label: string, owner: string): Promise<string> {
  let stdout = ""
  const io: YrdCliIO = {
    color: false,
    cwd: w.work,
    stderr: () => {},
    stdout: (text) => void (stdout += text),
  }
  const exit = await openEnvironment({ bay: label, json: true, owner }, io)
  if (exit !== 0) throw new Error(`yrd env open exited ${exit}: ${stdout}`)
  const record = JSON.parse(stdout.trim()) as { path: string }
  return record.path
}
