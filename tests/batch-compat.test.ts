import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { composeBatch, overlap } from "../src/batch-compat.ts"
import { changedPaths, git } from "../src/layers/git.ts"

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function must(args: string[], cwd: string): Promise<string> {
  const res = await git(args, cwd)
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr}`)
  return res.stdout.trim()
}

const IDENT = ["-c", "user.name=t", "-c", "user.email=t@x.invalid"]

/**
 * A real repo with a `base` commit on `main`, then one branch per entry — each
 * forks from `base` and writes its files. Branch names double as merge targets.
 */
async function repoWith(branches: Record<string, Record<string, string>>): Promise<{
  repo: string
  base: string
  targets: string[]
}> {
  const repo = await mkdtemp(join(tmpdir(), "bay-batch-"))
  dirs.push(repo)
  await must(["-C", repo, "init", "-q", "-b", "main"], repo)
  await writeFile(join(repo, "README"), "base\n")
  await must(["-C", repo, "add", "-A"], repo)
  await must(["-C", repo, ...IDENT, "commit", "-q", "-m", "base"], repo)
  const base = await must(["-C", repo, "rev-parse", "HEAD"], repo)

  const targets: string[] = []
  for (const [branch, files] of Object.entries(branches)) {
    await must(["-C", repo, "checkout", "-q", "-b", branch, base], repo)
    for (const [path, body] of Object.entries(files)) {
      const full = join(repo, path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, body)
    }
    await must(["-C", repo, "add", "-A"], repo)
    await must(["-C", repo, ...IDENT, "commit", "-q", "-m", branch], repo)
    targets.push(branch)
  }
  await must(["-C", repo, "checkout", "-q", "main"], repo)
  return { repo, base, targets }
}

describe("overlap (pure)", () => {
  it("a shared real path → real non-empty, not generatedOnly", () => {
    const ov = overlap(new Set(["a.ts", "b.ts"]), new Set(["b.ts", "c.ts"]), [])
    expect(ov.real).toEqual(["b.ts"])
    expect(ov.generatedOnly).toBe(false)
  })

  it("no shared path → empty, not generatedOnly", () => {
    const ov = overlap(new Set(["a.ts"]), new Set(["b.ts"]), [])
    expect(ov.real).toEqual([])
    expect(ov.generatedOnly).toBe(false)
  })

  it("the only shared path is generated → real empty, generatedOnly true", () => {
    const ov = overlap(new Set(["a.ts", "bun.lock"]), new Set(["b.ts", "bun.lock"]), ["bun.lock"])
    expect(ov.real).toEqual([])
    expect(ov.generatedOnly).toBe(true)
  })

  it("mixed real + generated overlap → real wins (not generatedOnly)", () => {
    const ov = overlap(new Set(["a.ts", "bun.lock"]), new Set(["a.ts", "bun.lock"]), ["bun.lock"])
    expect(ov.real).toEqual(["a.ts"])
    expect(ov.generatedOnly).toBe(false)
  })

  it("a `**` glob excludes generated paths at any depth", () => {
    const ov = overlap(new Set(["src/gen/x.ts"]), new Set(["src/gen/x.ts"]), ["**/gen/**"])
    expect(ov.real).toEqual([])
    expect(ov.generatedOnly).toBe(true)
  })
})

describe("changedPaths (git)", () => {
  it("lists exactly the target branch's changed paths", async () => {
    const { repo, base } = await repoWith({ A: { "a.ts": "a", "dir/n.ts": "n" } })
    const paths = await changedPaths(repo, base, "A")
    expect(paths.sort()).toEqual(["a.ts", "dir/n.ts"])
  })
})

describe("composeBatch (git)", () => {
  it("disjoint branches all join the batch", async () => {
    const { repo, base, targets } = await repoWith({ A: { "a.ts": "a" }, B: { "b.ts": "b" }, C: { "c.ts": "c" } })
    const r = await composeBatch(repo, base, targets, { generatedGlobs: [] })
    expect(r.members).toEqual(["A", "B", "C"])
    expect(r.skipped).toEqual([])
  })

  it("a real-path collision skips the LATER target (first-come-wins), not the earlier", async () => {
    const { repo, base, targets } = await repoWith({
      A: { "shared.ts": "a" },
      B: { "shared.ts": "b" },
      C: { "c.ts": "c" },
    })
    const r = await composeBatch(repo, base, targets, { generatedGlobs: [] })
    expect(r.members).toEqual(["A", "C"])
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]).toMatchObject({
      target: "B",
      reason: "path-overlap",
      overlapWith: "A",
      paths: ["shared.ts"],
    })
  })

  it("generated-only overlap is allowed — both join", async () => {
    const { repo, base, targets } = await repoWith({
      A: { "a.ts": "a", "bun.lock": "lockA" },
      B: { "b.ts": "b", "bun.lock": "lockB" },
    })
    const r = await composeBatch(repo, base, targets, { generatedGlobs: ["bun.lock"] })
    expect(r.members).toEqual(["A", "B"])
    expect(r.skipped).toEqual([])
  })

  it("without the generated glob, the same lockfile overlap refuses", async () => {
    const { repo, base, targets } = await repoWith({
      A: { "a.ts": "a", "bun.lock": "lockA" },
      B: { "b.ts": "b", "bun.lock": "lockB" },
    })
    const r = await composeBatch(repo, base, targets, { generatedGlobs: [] })
    expect(r.members).toEqual(["A"])
    expect(r.skipped[0]).toMatchObject({ target: "B", reason: "path-overlap", paths: ["bun.lock"] })
  })

  it("max caps the batch; over-cap targets are skipped batch-full (still queued)", async () => {
    const { repo, base, targets } = await repoWith({ A: { "a.ts": "a" }, B: { "b.ts": "b" }, C: { "c.ts": "c" } })
    const r = await composeBatch(repo, base, targets, { generatedGlobs: [], max: 2 })
    expect(r.members).toEqual(["A", "B"])
    expect(r.skipped).toEqual([{ target: "C", reason: "batch-full", overlapWith: "", paths: [] }])
  })
})
