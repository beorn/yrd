/**
 * @failure Submodule stores chained to recycled worktrees stay invisible until an object read dies mid-submit.
 * @level l1
 * @consumer yrd queue audit (environment census)
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { censusSubmoduleAlternates, submoduleAlternatesFindings } from "../src/alternates-audit.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Lay out a module gitdir with an objects dir and, optionally, alternates lines. */
async function store(gitdir: string, lines?: readonly string[]): Promise<string> {
  const objects = join(gitdir, "objects")
  await mkdir(join(objects, "info"), { recursive: true })
  if (lines !== undefined) await writeFile(join(objects, "info", "alternates"), `${lines.join("\n")}\n`)
  return objects
}

/**
 * The measured 2026-08-25 estate in miniature: durable stores under
 * `modules/`, worktree stores under `worktrees/<wt>/modules/`, one line each
 * of every classification the outage produced.
 */
async function estate(): Promise<{
  commonDir: string
  durable: string
  armedObjects: string
  deadObjects: string
}> {
  const root = await mkdtemp(join(tmpdir(), "yrd-alternates-census-"))
  roots.push(root)
  const commonDir = join(root, "common")

  // The primary repository's durable stores, nested layout included.
  const durable = await store(join(commonDir, "modules", "dep"))
  const durableNested = await store(join(commonDir, "modules", "km", "modules", "apps", "maddoc"))

  // w1 borrows straight from the durable store — healthy.
  const w1 = await store(join(commonDir, "worktrees", "w1", "modules", "dep"), [durable])
  // w2's ONLY live line is w1's worktree store — armed: dies with w1.
  const armedObjects = await store(join(commonDir, "worktrees", "w2", "modules", "dep"), [w1])
  // w3 points only at a recycled worktree's store — dead now.
  const deadObjects = await store(join(commonDir, "worktrees", "w3", "modules", "dep"), [
    join(commonDir, "worktrees", "recycled", "modules", "dep", "objects"),
  ])
  // w4 carries a dangling line AND the durable line — the surviving two-line
  // form: healthy, which is exactly why only 62 of the 66 danglers died.
  await store(join(commonDir, "worktrees", "w4", "modules", "dep"), [
    join(commonDir, "worktrees", "recycled", "modules", "dep", "objects"),
    durable,
  ])
  // w5's NESTED store reaches the durable nested store via a RELATIVE line —
  // proves nested traversal and relative resolution both happen.
  await store(join(commonDir, "worktrees", "w5", "modules", "km", "modules", "apps", "maddoc"), [
    join("..", "..", "..", "..", "..", "..", "..", "..", "modules", "km", "modules", "apps", "maddoc", "objects"),
  ])
  // A store with NO alternates file at all is not scanned — it borrows nothing.
  await store(join(commonDir, "worktrees", "w6", "modules", "dep"))
  void durableNested
  return { commonDir, durable, armedObjects, deadObjects }
}

describe("submodule alternates census", () => {
  it("classifies dead, armed, and healthy stores across nested module trees", async () => {
    const { commonDir, armedObjects, deadObjects } = await estate()

    const census = await censusSubmoduleAlternates(commonDir)

    // DENOMINATOR: w1..w5 carry alternates files; w6 and the durable stores do
    // not. A wrong count here means the walk skipped a tree it should read.
    expect(census.scanned).toBe(5)
    expect(census.dead.map(({ objects }) => objects)).toEqual([deadObjects])
    expect(census.armed.map(({ objects }) => objects)).toEqual([armedObjects])
  })

  it("projects one aggregated finding per class, read-only, with the count in the message", async () => {
    const { commonDir } = await estate()

    const findings = submoduleAlternatesFindings(await censusSubmoduleAlternates(commonDir), commonDir)

    expect(findings.map(({ code }) => code)).toEqual([
      "submodule-alternates-dead-store",
      "submodule-alternates-worktree-only",
    ])
    const dead = findings[0]
    const armed = findings[1]
    expect(dead?.message).toContain("1 of 5")
    expect(dead?.message).toContain(join(commonDir, "worktrees", "w3", "modules", "dep", "objects"))
    expect(dead?.specimen).toBe(commonDir)
    // The resolution routes repair; it never performs it.
    expect(dead?.resolution?.join("\n")).toContain("@chief")
    expect(armed?.message).toContain("1 of 5")
    expect(armed?.message).toContain(join(commonDir, "worktrees", "w2", "modules", "dep", "objects"))
  })

  it("reports a clean estate as NO findings, with the denominator still measured", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-alternates-clean-"))
    roots.push(root)
    const commonDir = join(root, "common")
    const durable = await store(join(commonDir, "modules", "dep"))
    await store(join(commonDir, "worktrees", "w1", "modules", "dep"), [durable])

    const census = await censusSubmoduleAlternates(commonDir)

    expect(census).toMatchObject({ scanned: 1, dead: [], armed: [] })
    expect(submoduleAlternatesFindings(census, commonDir)).toEqual([])
  })

  it("reads an estate with no module trees at all as zero scanned, not an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-alternates-empty-"))
    roots.push(root)
    const commonDir = join(root, "common")
    await mkdir(commonDir, { recursive: true })

    const census = await censusSubmoduleAlternates(commonDir)

    expect(census).toMatchObject({ scanned: 0, dead: [], armed: [] })
  })
})
