/**
 * #27363 — the compose revert guard sees content a candidate put back one component store down.
 *
 * The measured incident was a fast-forward km pin move whose INTERIOR content restored a target
 * advance (the write-log cap 480 -> 416 MiB). The root diff shows one mode-160000 entry, so the
 * guard descends into the owning component store; a reused target pin swallows the incoming
 * correction rather than moving the pin at all.
 *
 * @failure Yrd composes a stale-base branch that silently reverts later target changes inside a
 *          component, and the fleet-wide km write deferral repeats unseen.
 * @level l1 (real repositories; local git only, no compose)
 * @consumer `yrd submit` and every queue compose (verifying.ts)
 * @reach fs-walk <fixture-only: temporary repositories created by this test; no authored source tree scan>
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import {
  detectReverted,
  REVERTED_PATHS_PAYLOAD_CAP,
  revertedPathsFinding,
  revertedPathsCounts,
  revertedPathsNotice,
  revertedPathsReason,
  revertGuardAction,
  type RevertGuardReport,
} from "../src/revert-guard.ts"
import { verifyCandidate } from "../src/verifying.ts"
import { gitSuperBin } from "../../../tests/support/git-super-bin.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const env = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
}
const author = ["-c", "user.email=revert@yrd.test", "-c", "user.name=yrd"] as const

async function commit(
  repo: string,
  files: Readonly<Record<string, string>>,
  message: string,
  environment: NodeJS.ProcessEnv = env,
): Promise<string> {
  const git = gitIn(repo, undefined, undefined, { env: environment })
  for (const [name, body] of Object.entries(files)) {
    const full = join(repo, name)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, body)
  }
  await git(["add", "-A"])
  await git([...author, "commit", "--quiet", "--allow-empty", "--message", message])
  return (await git(["rev-parse", "HEAD"])).trim()
}

/** Record one submodule at `path` pinned to `sha`, with the local `url` its checkout needs. */
async function pin(
  repo: string,
  path: string,
  url: string,
  sha: string,
  message: string,
  environment: NodeJS.ProcessEnv = env,
): Promise<string> {
  const git = gitIn(repo, undefined, undefined, { env: environment })
  writeFileSync(join(repo, ".gitmodules"), `[submodule "${path}"]\n\tpath = ${path}\n\turl = ${url}\n`)
  await git(["add", "--", ".gitmodules"])
  await git(["update-index", "--add", "--cacheinfo", `160000,${sha},${path}`])
  await git([...author, "commit", "--quiet", "--allow-empty", "--message", message])
  return (await git(["rev-parse", "HEAD"])).trim()
}

type World = Readonly<{
  root: string
  product: string
  dep: string
  target: string
  head: string
  candidateStale: string
  candidateMetadata: string
  candidateNormal: string
  checkoutAt: (commit: string) => Promise<string>
}>

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-guard-"))
  roots.push(root)
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "a.txt": "base\n" }, "base")
  const c1 = await commit(dep, { "a.txt": "target\n" }, "target advance")
  const c2 = await commit(dep, { "a.txt": "base\n" }, "stale restore")
  const c3 = await commit(dep, { "a.txt": "target\n", "b.txt": "extra\n" }, "incoming advance")
  const c4 = await commit(dep, {}, "metadata-only rebuild")
  const product = join(root, "product")
  mkdirSync(product)
  const productGit = gitIn(product, undefined, undefined, { env })
  await productGit(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  const target = await pin(product, "vendor/dep", dep, c1, "target pins the advance")
  const head = await pin(product, "vendor/dep", dep, c3, "head asks for the incoming advance")
  const candidateStale = await pin(product, "vendor/dep", dep, c2, "candidate restores the stale value")
  const candidateMetadata = await pin(product, "vendor/dep", dep, c4, "candidate re-pins the same tree")
  const candidateNormal = await pin(product, "vendor/dep", dep, c3, "candidate merges the incoming advance")
  const checkoutAt = async (sha: string): Promise<string> => {
    const dir = join(root, `checkout-${sha.slice(0, 12)}`)
    await productGit(["worktree", "add", "--quiet", "--detach", dir, sha])
    await gitIn(dir, undefined, undefined, { env })(["submodule", "update", "--init", "--recursive", "--quiet"])
    return dir
  }
  return { candidateMetadata, candidateNormal, candidateStale, checkoutAt, dep, head, product, root, target }
}

async function detect(
  w: Readonly<{ checkoutAt: (commit: string) => Promise<string>; target: string }>,
  candidate: string,
  head: string,
  targetHead: string = w.target,
): Promise<Awaited<ReturnType<typeof detectReverted>>> {
  const root = await w.checkoutAt(candidate)
  return detectReverted({
    candidate,
    git: gitIn(root, undefined, undefined, { env }),
    head,
    root,
    targetHead,
  })
}

describe("revert guard (27363)", () => {
  it("S2: a fast-forward pin move that restores a target advance is a reverted path", async () => {
    const w = await world()
    const report = await detect(w, w.candidateStale, w.head)
    expect(report.coverage).toBe("complete")
    expect(report.swallowed).toEqual([])
    expect(report.paths.map((row) => row.path)).toContain("vendor/dep/a.txt")
    expect(report.count).toBe(report.paths.length)
    expect(report.base.state).toBe("single")
  })

  it("S3: a candidate that reuses the target pin swallows the incoming correction", async () => {
    const w = await world()
    const report = await detect(w, w.target, w.head)
    expect(report.paths).toEqual([])
    expect(report.swallowed.map((row) => row.path)).toContain("vendor/dep")
  })

  it("S2 negative (28557): a deliberate deletion of lines an earlier shared change added is not a revert", async () => {
    const w = await deletionWorld()
    const report = await detect(w, w.candidate, w.head)
    expect(report.coverage).toBe("complete")
    expect(report.paths).toEqual([])
    expect(report.swallowed).toEqual([])
    expect(revertedPathsFinding(report)).toBeUndefined()
    expect(revertGuardAction(report, "observe")).toBe("clean")
  })

  it("S2 positive (28557): a revert of a target advance made after the base still warns", async () => {
    const w = await targetAdvanceWorld()
    const report = await detect(w, w.candidate, w.head)
    expect(report.coverage).toBe("complete")
    expect(report.paths.map((row) => row.path)).toContain("vendor/dep/impl.txt")
    expect(revertedPathsFinding(report)?.coverage).toBe("complete")
  })

  it("negative: a metadata-only re-pin with equal trees is not a hit", async () => {
    const w = await world()
    const report = await detect(w, w.candidateMetadata, w.candidateMetadata)
    expect(report.coverage).toBe("complete")
    expect(report.paths).toEqual([])
    expect(report.swallowed).toEqual([])
  })

  it("negative: a normal merge of a genuinely advancing pin is clean", async () => {
    const w = await world()
    const report = await detect(w, w.candidateNormal, w.candidateNormal)
    expect(report.coverage).toBe("complete")
    expect(report.paths).toEqual([])
    expect(report.swallowed).toEqual([])
  })

  it("negative: an incoming pin behind the target is kept-ahead, never swallowed", async () => {
    const w = await world()
    const report = await detect(w, w.head, w.target, w.head)
    expect(report.coverage).toBe("complete")
    expect(report.paths).toEqual([])
    expect(report.swallowed).toEqual([])
  })

  it("bounds: a path cap names the gap and never reports clean", async () => {
    const w = await world()
    const root = await w.checkoutAt(w.candidateStale)
    const report = await detectReverted({
      bounds: { depth: 3, pathCap: 0, window: 50 },
      candidate: w.candidateStale,
      git: gitIn(root, undefined, undefined, { env }),
      head: w.head,
      root,
      targetHead: w.target,
    })
    expect(report.coverage).toBe("incomplete")
    expect(report.gaps.some((gap) => gap.reason.includes("path cap"))).toBe(true)
  })

  it("nested: a gitlink inside a component recurses to the inner path", async () => {
    const w = await nestedWorld()
    const report = await detect(w, w.candidateStale, w.head)
    expect(report.paths.map((row) => row.path)).toContain("vendor/dep/vendor/inner/x.txt")
  })

  /** A standalone repository the guard judges at the ROOT level, with a worktree per commit asked for. */
  async function flatWorld(): Promise<Readonly<{ repo: string; checkoutAt: (commit: string) => Promise<string> }>> {
    const repo = mkdtempSync(join(tmpdir(), "yrd-revert-flat-"))
    roots.push(repo)
    const git = gitIn(repo, undefined, undefined, { env })
    await git(["init", "--quiet", "--initial-branch=main"])
    const checkoutAt = async (sha: string): Promise<string> => {
      const dir = join(repo, `flat-${sha.slice(0, 12)}`)
      await git(["worktree", "add", "--quiet", "--detach", dir, sha])
      return dir
    }
    return { checkoutAt, repo }
  }

  it("touched: a path the target RENAMED AWAY is still judged when the candidate restores its blob (28195)", async () => {
    const w = await flatWorld()
    const git = gitIn(w.repo, undefined, undefined, { env })
    const base = await commit(w.repo, { "a.txt": "base\n" }, "base")
    // The target’s own advance is a rename. Rename detection would list only `b.txt`, so a set built
    // without `--no-renames` calls `a.txt` untouched and skips the one path this compose restored.
    await git(["mv", "a.txt", "b.txt"])
    await git([...author, "commit", "--quiet", "--message", "target renames a.txt to b.txt"])
    const target = (await git(["rev-parse", "HEAD"])).trim()
    // A candidate cut from BELOW the rename whose tree is the pre-rename tree: it puts the old path
    // back with the old blob, which is the revert the guard exists to catch.
    const report = await detect({ checkoutAt: w.checkoutAt, target }, base, base)
    expect(report.coverage).toBe("complete")
    expect(report.paths.map((row) => row.path)).toContain("a.txt")
    expect(revertGuardAction(report, "refuse")).toBe("stick")
  })

  it("touched: a path ending in a space that the target changed is still walked (28195)", async () => {
    const w = await flatWorld()
    const base = await commit(w.repo, { "c d ": "base\n" }, "base")
    const target = await commit(w.repo, { "c d ": "target\n" }, "target advance")
    // `-z` names arrive verbatim; a `trimEnd()` on the parse shortens this path to `c d`, so the set
    // lookup misses and the restored path is skipped in silence.
    const report = await detect({ checkoutAt: w.checkoutAt, target }, base, base)
    expect(report.coverage).toBe("complete")
    expect(report.paths.map((row) => row.path)).toContain("c d ")
  })

  it("touched: a judged path containing a newline is still judged (28195)", async () => {
    const w = await flatWorld()
    // `--stdin` is newline-delimited, so this name cannot be expressed as a pathspec: git splits it
    // into `a` and `b.txt`, matches neither, and the traversal returns nothing for it. The set then
    // calls the path untouched and `assessPath` skips it — a revert no per-path walk would have missed.
    const odd = "a\nb.txt"
    const base = await commit(w.repo, { [odd]: "base\n" }, "base")
    const target = await commit(w.repo, { [odd]: "target\n" }, "target advance")
    const report = await detect({ checkoutAt: w.checkoutAt, target }, base, base)
    expect(report.coverage).toBe("complete")
    expect(report.paths.map((row) => row.path)).toContain(odd)
    expect(revertGuardAction(report, "refuse")).toBe("stick")
  })

  it("the durable finding is silent only for a complete, hit-free report", () => {
    expect(revertedPathsFinding(undefined)).toBeUndefined()
    expect(
      revertedPathsFinding({
        base: { base: "a".repeat(40), state: "single" },
        count: 0,
        coverage: "complete",
        gaps: [],
        paths: [],
        swallowed: [],
      }),
    ).toBeUndefined()
    const hit = revertedPathsFinding({
      base: { base: "a".repeat(40), state: "single" },
      count: 1,
      coverage: "complete",
      gaps: [],
      paths: [{ base: "b", candidate: "c", mode: "100644", path: "vendor/dep/a.txt", target: "t" }],
      swallowed: [],
    })
    expect(hit?.reason).toContain("vendor/dep/a.txt")
    expect(hit?.reason).toContain('"count":1')
    const gap = revertedPathsFinding({
      base: { state: "none" },
      count: 0,
      coverage: "incomplete",
      gaps: [],
      paths: [],
      swallowed: [],
    })
    expect(gap?.coverage).toBe("incomplete")
    expect(gap?.reason).toContain("revert audit undecidable")
  })

  it("durable: a capped gap keeps its component path and depth, not only the reason", () => {
    const capped: RevertGuardReport = {
      base: { base: "a".repeat(40), state: "single" },
      count: 0,
      coverage: "incomplete",
      gaps: [
        { kind: "bounded", depth: 0, path: "a.txt", reason: "target history window W=50 exhausted" },
        { kind: "unjudged", depth: 1, path: "vendor/dep/b.txt", reason: "path cap P_max=500" },
      ],
      paths: [],
      swallowed: [],
    }
    const reason = revertedPathsReason(capped)
    expect(reason).toContain("a.txt@d0")
    expect(reason).toContain("vendor/dep/b.txt@d1")
    expect(reason).toContain('"gaps"')
    expect(revertedPathsFinding(capped)?.reason).toContain("a.txt@d0")
  })

  it("counts every kind BEFORE the payload’s cap, and a reader takes them from the payload alone (28195)", () => {
    const many: RevertGuardReport = {
      base: { base: "a".repeat(40), state: "single" },
      count: 1,
      coverage: "incomplete",
      gaps: [
        ...Array.from({ length: 40 }, (_, index) => ({
          kind: "unjudged" as const,
          depth: 1,
          path: `content/a${String(index)}.json`,
          reason: "path cap P_max=500",
        })),
        { kind: "bounded" as const, depth: 0, path: "kept.txt", reason: "target history window W=50 exhausted" },
      ],
      paths: [{ base: "b", candidate: "c", mode: "100644", path: "vendor/dep/a.txt", target: "t" }],
      swallowed: [{ candidate: "x", incoming: "y", path: "vendor/dep", target: "z" }],
    }
    expect(revertedPathsCounts(many)).toEqual({ reverted: 1, swallowed: 1, gaps: 41, unjudged: 40, bounded: 1 })
    expect(revertedPathsFinding(many)?.counts.gaps).toBe(41)
    const reason = revertedPathsReason(many)
    expect(reason).toContain('"counts":{"reverted":1,"swallowed":1,"gaps":41,"unjudged":40,"bounded":1}')
    // The stored lists are capped and the counts are not, so a reader states 41 gaps while the payload
    // holds only the cap: a truncated total is named, never counted out of the gap prose.
    expect(revertedPathsNotice(reason)).toEqual({
      counts: { reverted: 1, swallowed: 1, gaps: 41, unjudged: 40, bounded: 1 },
      coverage: "incomplete",
      gapsStored: REVERTED_PATHS_PAYLOAD_CAP,
      truncated: true,
    })
    // A row written before the counts were recorded: coverage and the capped total are still read,
    // the counts are simply not there, and nothing is invented for them.
    const older = `0 reverted/swallowed path(s); {"count":0,"coverage":"incomplete","paths":[],"swallowed":[],"gaps":${JSON.stringify(
      Array.from({ length: REVERTED_PATHS_PAYLOAD_CAP }, (_, index) => ({
        kind: "unjudged",
        depth: 1,
        reason: "path cap P_max=500",
        path: `content/a${String(index)}.json`,
      })),
    )}}; gaps: path cap P_max=500 [content/a0.json@d1], …`
    expect(revertedPathsNotice(older)).toEqual({
      coverage: "incomplete",
      gapsStored: REVERTED_PATHS_PAYLOAD_CAP,
      truncated: true,
    })
    // A path whose own bytes carry braces and quotes cannot break the object scan.
    const braced = revertedPathsReason({
      ...many,
      paths: [{ base: "b", candidate: "c", mode: "100644", path: 'a{b}"c/d.txt', target: "t" }],
    })
    expect(revertedPathsNotice(braced)?.counts?.gaps).toBe(41)
    // Not a revert reason at all.
    expect(revertedPathsNotice("admission policy warning task/x@abc123: no kind")).toBeUndefined()
  })

  it("policy: a hit warns by default and sticks only under refuse, and a gap never goes clean", () => {
    const clean: RevertGuardReport = {
      base: { base: "a".repeat(40), state: "single" },
      count: 0,
      coverage: "complete",
      gaps: [],
      paths: [],
      swallowed: [],
    }
    expect(revertGuardAction(clean, "observe")).toBe("clean")
    expect(revertGuardAction(clean, "refuse")).toBe("clean")
    const hit: RevertGuardReport = {
      ...clean,
      count: 1,
      paths: [{ base: "b", candidate: "c", mode: "100644", path: "vendor/dep/a.txt", target: "t" }],
    }
    expect(revertGuardAction(hit, "observe")).toBe("warn")
    expect(revertGuardAction(hit, "refuse")).toBe("stick")
    const gap: RevertGuardReport = {
      base: { state: "none" },
      count: 0,
      coverage: "incomplete",
      gaps: [],
      paths: [],
      swallowed: [],
    }
    expect(revertGuardAction(gap, "observe")).toBe("warn")
    expect(revertGuardAction(gap, "refuse")).toBe("stick")
    expect(revertGuardAction(undefined, "refuse")).toBe("clean")
  })

  it("the compose wires the finding through: a stale-base candidate reports the reverted interior path", async () => {
    const w = await composeWorld()
    const verified = await verifyCandidate({
      env: w.env,
      git: w.git,
      head: w.head,
      message: "compose a stale-base candidate",
      noFetch: true,
      path: join(w.root, "verifying"),
      repo: w.repo,
      targetHead: w.targetHead,
      worktree: { env: w.env },
    })
    if (verified.state !== "verified") throw new Error(JSON.stringify(verified.verifying.detail))
    expect(verified.verifying.reverted?.paths.map((row) => row.path)).toContain("vendor/dep/a.txt")
    expect(verified.verifying.reverted?.coverage).toBe("complete")
  }, 120_000)
})

describe("revert guard review regressions (27363)", () => {
  it("bounds (#28000, #29963): a reached history window reports coverage incomplete with what the bound proves, warns nobody, and refusal still sticks", async () => {
    const w = await cappedWorld()
    const root = await w.checkoutAt(w.candidate)
    const capped = await detectReverted({
      bounds: { depth: 3, pathCap: 500, window: 1 },
      candidate: w.candidate,
      git: gitIn(root, undefined, undefined, { env }),
      head: w.head,
      root,
      targetHead: w.target,
    })
    // #29963: an audit that names gaps is incomplete, never complete; the gap states what the bounded reading proves.
    expect(capped.coverage).toBe("incomplete")
    expect(
      capped.gaps.some(
        (gap) =>
          gap.kind === "bounded" &&
          gap.reason.includes("window W=1 exhausted") &&
          gap.reason.includes(
            "proves no revert within the latest 1 first-parent target commit(s) touching this path",
          ) &&
          gap.reason.includes("older target history was not read"),
      ),
    ).toBe(true)
    // `observe` must mean "nobody could judge this change": a bounded search warns nobody (0 reverted paths plus a
    // warning on every change touching an established path is a warning with no signal).
    expect(revertedPathsFinding(capped)).toBeUndefined()
    expect(revertGuardAction(capped, "observe")).toBe("clean")
    // Refusal never loosens for it: the cap CAN hide a real revert, as the full run below proves.
    expect(revertGuardAction(capped, "refuse")).toBe("stick")
    // The full window finds the restore the cap hid: the cap, not the change, was the finding.
    const full = await detect(w, w.candidate, w.head)
    expect(full.paths.map((row) => row.path)).toContain("vendor/dep/a.txt")
  })

  /**
   * #30354: when the walk was already bounded at the candidate merge base, a
   * capped gap's reason names that bound and the unread remainder of that
   * range. Coverage and refusal semantics do not move: a candidate can
   * restore a value from history it carries (the original cappedWorld
   * above), so no range recount may call a capped walk complete.
   */
  async function boundedWorld(rangeTouches: number) {
    const root = mkdtempSync(join(tmpdir(), "yrd-revert-30354-"))
    roots.push(root)
    const dep = join(root, "dep")
    mkdirSync(dep)
    const depGit = gitIn(dep, undefined, undefined, { env })
    await depGit(["init", "--quiet", "--initial-branch=main"])
    const base = await commit(dep, { "a.txt": "base\n" }, "base")
    let targetPin = base
    for (let i = 0; i < rangeTouches; i++) targetPin = await commit(dep, { "a.txt": `target-${i}\n` }, `target touch ${i}`)
    await depGit(["checkout", "--quiet", "-b", "candidate", base])
    const candidatePin = await commit(dep, { "a.txt": "candidate\n" }, "candidate advance")
    await depGit(["checkout", "--quiet", "main"])
    const product = join(root, "product")
    mkdirSync(product)
    const productGit = gitIn(product, undefined, undefined, { env })
    await productGit(["init", "--quiet", "--initial-branch=main"])
    await commit(product, { "readme.txt": "product\n" }, "product base")
    const target = await pin(product, "vendor/dep", dep, targetPin, "target pin")
    const candidate = await pin(product, "vendor/dep", dep, candidatePin, "candidate pin")
    const checkoutAt = async (sha: string): Promise<string> => {
      const dir = join(root, `checkout-${sha.slice(0, 12)}`)
      await productGit(["worktree", "add", "--quiet", "--detach", dir, sha])
      await gitIn(dir, undefined, undefined, { env })(["submodule", "update", "--init", "--recursive", "--quiet"])
      return dir
    }
    return { base, candidate, checkoutAt, target }
  }

  it("30354: a diverged range at the window bound reports complete", async () => {
    const w = await boundedWorld(2)
    const root = await w.checkoutAt(w.candidate)
    const report = await detectReverted({
      bounds: { depth: 3, pathCap: 500, window: 2 },
      candidate: w.candidate,
      git: gitIn(root, undefined, undefined, { env }),
      head: w.candidate,
      root,
      targetHead: w.target,
    })
    expect(report.paths).toEqual([])
    expect(report.gaps).toEqual([])
    expect(report.coverage).toBe("complete")
  })

  it("30354: a diverged range above the window names its merge-base bound and the missing coverage", async () => {
    const w = await boundedWorld(3)
    const root = await w.checkoutAt(w.candidate)
    const report = await detectReverted({
      bounds: { depth: 3, pathCap: 500, window: 2 },
      candidate: w.candidate,
      git: gitIn(root, undefined, undefined, { env }),
      head: w.candidate,
      root,
      targetHead: w.target,
    })
    expect(report.paths).toEqual([])
    expect(report.coverage).toBe("incomplete")
    expect(
      report.gaps.some(
        (gap) =>
          gap.kind === "bounded" &&
          gap.reason.includes("window W=2 exhausted") &&
          gap.reason.includes(w.base) &&
          gap.reason.includes("was not read"),
      ),
    ).toBe(true)
  })

  it("merge candidate (29963): a composed merge candidate at root and component level bounds the walk at the divergence base instead of exhausting W on pre-base history", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-revert-29963-"))
    roots.push(root)
    const dep = join(root, "dep")
    mkdirSync(dep)
    const depGit = gitIn(dep, undefined, undefined, { env })
    await depGit(["init", "--quiet", "--initial-branch=main"])
    await commit(dep, { "code.ts": "v1\n" }, "dep c1")
    await commit(dep, { "code.ts": "v2\n" }, "dep c2")
    const depBase = await commit(dep, { "code.ts": "v3\n" }, "dep c3 (base)")
    const depTarget = await commit(dep, { "other.ts": "target\n" }, "dep target advances other.ts")
    await depGit(["checkout", "--quiet", "-b", "author", depBase])
    await commit(dep, { "code.ts": "v4-author\n" }, "author edits code.ts")
    // Author merges target into the component branch (exact #29456 ag shape: ea5cc44c = merge(target, author)).
    await depGit(["checkout", "--quiet", "-B", "composed-dep", depTarget])
    await depGit([...author, "merge", "--no-ff", "--quiet", "-m", "merge author into dep target", "author"])
    const depCandidate = (await depGit(["rev-parse", "HEAD"])).trim()

    const product = join(root, "product")
    mkdirSync(product)
    const productGit = gitIn(product, undefined, undefined, { env })
    await productGit(["init", "--quiet", "--initial-branch=main"])
    await commit(product, { "staffing.ts": "s1\n" }, "root c1")
    await commit(product, { "staffing.ts": "s2\n" }, "root c2")
    await commit(product, { "staffing.ts": "s3\n" }, "root c3")
    const rootBase = await pin(product, "vendor/dep", dep, depBase, "root base pins depBase")
    await commit(product, { "unrelated.ts": "u\n" }, "root target advances unrelated")
    const targetHead = await pin(product, "vendor/dep", dep, depTarget, "root target pins depTarget")
    await productGit(["checkout", "--quiet", "-b", "branch", rootBase])
    await commit(product, { "staffing.ts": "s4-author\n" }, "branch edits staffing.ts")
    const head = await pin(product, "vendor/dep", dep, depCandidate, "branch pins depCandidate")
    // Compose candidate is merge(targetHead, head) at root (exact verifyCandidate / #29456 shape).
    await productGit(["checkout", "--quiet", "-B", "composed-root", head])
    writeFileSync(join(product, "unrelated.ts"), "u\n")
    await productGit(["add", "unrelated.ts"])
    const composedTree = (await productGit(["write-tree"])).trim()
    const candidate = (
      await productGit([
        ...author,
        "commit-tree",
        composedTree,
        "-p",
        targetHead,
        "-p",
        head,
        "-m",
        "compose branch into target",
      ])
    ).trim()
    await productGit(["update-ref", "refs/heads/composed-root", candidate])

    const checkoutDir = await regressionCheckout(root, product, candidate)
    const report = await detectReverted({
      bounds: { depth: 3, pathCap: 500, window: 1 },
      candidate,
      git: gitIn(checkoutDir, undefined, undefined, { env }),
      head,
      root: checkoutDir,
      targetHead,
    })
    expect(report.base).toEqual({ base: rootBase, state: "single" })
    expect(report.gaps).toEqual([])
    expect(report.coverage).toBe("complete")
    expect(report.paths).toEqual([])
    expect(report.swallowed).toEqual([])
  })

  it("mode: a mode-only restore of a target advance is a hit, not clean", async () => {
    const w = await modeWorld()
    const report = await detect(w, w.candidate, w.head)
    expect(report.base.state).toBe("single")
    expect(report.coverage).toBe("complete")
    expect(report.paths.map((row) => row.path)).toContain("vendor/dep/a.txt")
  })

  it.each(["restore", "multi-restore", "shared", "swallowed"] as const)(
    "base: braided history judges %s against every base",
    async (kind) => {
      const w = await ambiguousWorld(kind)
      const root = await w.checkoutAt(w.candidate)
      const git = gitIn(root, undefined, undefined, { env })
      const bases = (await git(["merge-base", "--all", w.target, w.head])).trim().split("\n")
      expect(bases).toHaveLength(2)
      // Native ancestor-set exclusion is the oracle: exclude full ancestry, never only first parents.
      const targetOnly = (excluded: readonly string[]) =>
        git(["rev-list", "--first-parent", w.target, ...excluded.map((base) => `^${base}`)])
      const allBases = await targetOnly(bases)
      expect(allBases).toBe(await targetOnly([w.head]))
      expect(allBases).toBe(await targetOnly([...bases].reverse()))
      const report = await detectReverted({ candidate: w.candidate, git, head: w.head, root, targetHead: w.target })
      expect(await git(["ls-tree", w.target, "vendor/dep"])).toContain("160000 commit")
      // CTO4aeb221b amends the old blanket ambiguity veto: this real put-back remains a named S2.
      expect(report.base).toEqual({ state: "multiple", bases: expect.arrayContaining(bases) })
      expect(report.coverage).toBe("complete")
      expect(report.gaps).toEqual([])
      expect(report.paths.map((row) => row.path)).toEqual(
        kind === "restore" || kind === "multi-restore" ? ["vendor/dep/a.txt"] : [],
      )
      expect(report.swallowed.map((row) => row.path)).toEqual(kind === "swallowed" ? ["vendor/dep"] : [])
      expect(revertGuardAction(report, "observe")).toBe(kind === "shared" ? "clean" : "warn")
      expect(revertGuardAction(report, "refuse")).toBe(kind === "shared" ? "clean" : "stick")
      if (kind !== "multi-restore") {
        const clean = await detect(w, w.head, w.head)
        expect(clean.base).toEqual({ state: "multiple", bases: expect.arrayContaining(bases) })
        expect(clean.coverage).toBe("complete")
        expect(clean.gaps).toEqual([])
        expect(clean.paths).toEqual([])
        expect(clean.swallowed).toEqual([])
        expect(revertedPathsFinding(clean)).toBeUndefined()
        expect(revertGuardAction(clean, "observe")).toBe("clean")
        expect(revertGuardAction(clean, "refuse")).toBe("clean")
      }
      await using native = createProcess({ cwd: root, env })
      const reorderedGit = gitIn(
        root,
        {
          async run(request) {
            const result = await native.run(request)
            return request.argv.includes("merge-base") && result.exitCode === 0
              ? { ...result, stdout: result.stdout.trim().split("\n").reverse().join("\n") + "\n" }
              : result
          },
        },
        undefined,
        { env },
      )
      const reordered = await detectReverted({
        candidate: w.candidate,
        git: reorderedGit,
        head: w.head,
        root,
        targetHead: w.target,
      })
      expect(reordered.base).toEqual({ state: "multiple", bases: expect.arrayContaining(bases) })
      expect({ ...reordered, base: report.base }).toEqual(report)
    },
  )

  // A missing proof must skip S2, not widen into shared history or erase independently proved S3.
  it.each(["root", "child"] as const)("base: unreadable %s ancestry stays unjudged", async (failedLevel) => {
    const w = await ambiguousWorld(failedLevel === "root" ? "swallowed" : "restore")
    const root = await w.checkoutAt(w.candidate)
    await using native = createProcess({ cwd: root, env })
    const git = gitIn(
      root,
      {
        async run(request) {
          if (
            request.argv.includes("merge-base") &&
            request.cwd === (failedLevel === "root" ? root : join(root, "vendor/dep"))
          ) {
            throw new Error("fixture ancestry read unavailable")
          }
          return native.run(request)
        },
      },
      undefined,
      { env },
    )
    const report = await detectReverted({ candidate: w.candidate, git, head: w.head, root, targetHead: w.target })
    expect(report.coverage).toBe("incomplete")
    expect(report.paths).toEqual([])
    expect(report.swallowed.map((row) => row.path)).toEqual(failedLevel === "root" ? ["vendor/dep"] : [])
    expect(
      report.gaps.some((gap) => gap.kind === "unjudged" && gap.reason.includes("fixture ancestry read unavailable")),
    ).toBe(true)
    expect(revertedPathsReason(report)).toContain("revert audit undecidable")
    expect(revertGuardAction(report, "observe")).toBe("warn")
    expect(revertGuardAction(report, "refuse")).toBe("stick")
    if (failedLevel === "child" && report.base.state === "multiple") {
      for (const base of report.base.bases) expect(revertedPathsReason(report)).toContain(base)
    } else expect(report.base).toEqual({ state: "none" })
  })

  it("base: genuinely unrelated incoming history stays undecidable and preserves S3", async () => {
    const w = await ambiguousWorld("no-base")
    const report = await detect(w, w.candidate, w.head)
    expect(report.base).toEqual({ state: "none" })
    expect(report.coverage).toBe("incomplete")
    expect(report.paths).toEqual([])
    expect(report.swallowed.map((row) => row.path)).toEqual(["vendor/dep"])
    expect(revertedPathsReason(report)).toContain("no merge base between the target and the change")
    expect(revertGuardAction(report, "observe")).toBe("warn")
    expect(revertGuardAction(report, "refuse")).toBe("stick")
  })

  it("add-only: the untouched paths cost one traversal per level, not one walk per path", async () => {
    const w = await addOnlyWorld()
    const root = await w.checkoutAt(w.candidate)
    const calls: (readonly string[])[] = []
    const git = gitIn(root, undefined, undefined, {
      env,
      onInvocation: (invocation) => {
        calls.push(invocation.args)
      },
    })
    const report = await detectReverted({
      bounds: { depth: 3, pathCap: 1, window: 50 },
      candidate: w.candidate,
      git,
      head: w.head,
      root,
      targetHead: w.target,
    })
    expect(report.coverage).toBe("complete")
    // touched-or-not is decided by ONE `log --first-parent --name-only` per level; NO path takes the
    // per-path `rev-list` walk, so the 12 added paths never each scan the target’s history (#28195).
    expect(calls.filter((args) => args[0] === "rev-list")).toEqual([])
    // The one traversal is found by subcommand, never by argv[0], because `--literal-pathspecs` is a
    // leading global flag. It is path-limited (paths on stdin) and rename-blind, so it names EVERY path
    // the range moved rather than only a rename’s destination (#28195).
    const traversals = calls.filter((args) => args.includes("log"))
    expect(traversals).toHaveLength(1)
    expect(traversals[0]?.includes("--stdin")).toBe(true)
    expect(traversals[0]?.includes("--literal-pathspecs")).toBe(true)
    expect(traversals[0]?.includes("--no-renames")).toBe(true)
  })
})

type RegressionWorld = Readonly<{
  root: string
  target: string
  head: string
  candidate: string
  checkoutAt: (commit: string) => Promise<string>
}>

let regressionCheckouts = 0

async function regressionCheckout(root: string, product: string, sha: string): Promise<string> {
  regressionCheckouts += 1
  const dir = join(root, "checkout-" + sha.slice(0, 12) + "-" + String(regressionCheckouts))
  await gitIn(product, undefined, undefined, { env })(["worktree", "add", "--quiet", "--detach", dir, sha])
  await gitIn(dir, undefined, undefined, { env })(["submodule", "update", "--init", "--recursive", "--quiet"])
  return dir
}

/** Target A -> B -> C; the candidate restores A, which only a walk past the window can see. */
async function cappedWorld(): Promise<RegressionWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-capped-"))
  roots.push(root)
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "a.txt": "one\n" }, "A")
  await commit(dep, { "a.txt": "two\n" }, "B")
  const targetPin = await commit(dep, { "a.txt": "three\n" }, "C")
  const candidatePin = await commit(dep, { "a.txt": "one\n" }, "restore A")
  const product = join(root, "product")
  mkdirSync(product)
  await gitIn(product, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  const target = await pin(product, "vendor/dep", dep, targetPin, "target pins C")
  const head = await pin(product, "vendor/dep", dep, targetPin, "head pins C")
  const candidate = await pin(product, "vendor/dep", dep, candidatePin, "candidate restores A")
  return { candidate, checkoutAt: (sha) => regressionCheckout(root, product, sha), head, root, target }
}

/** The target advances a path's MODE with the blob unchanged; the candidate puts the mode back. */
async function modeWorld(): Promise<RegressionWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-mode-"))
  roots.push(root)
  const dep = join(root, "dep")
  mkdirSync(dep)
  const depGit = gitIn(dep, undefined, undefined, { env })
  await depGit(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(dep, "a.txt"), "same\n")
  await depGit(["add", "a.txt"])
  await depGit([...author, "commit", "--quiet", "--message", "base"])
  await depGit(["update-index", "--chmod=+x", "a.txt"])
  await depGit([...author, "commit", "--quiet", "--message", "mode advance"])
  const targetPin = (await depGit(["rev-parse", "HEAD"])).trim()
  await depGit(["update-index", "--chmod=-x", "a.txt"])
  await depGit([...author, "commit", "--quiet", "--message", "mode restore"])
  const candidatePin = (await depGit(["rev-parse", "HEAD"])).trim()
  const product = join(root, "product")
  mkdirSync(product)
  await gitIn(product, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  const target = await pin(product, "vendor/dep", dep, targetPin, "target pins the mode advance")
  const head = await pin(product, "vendor/dep", dep, targetPin, "head pins the mode advance")
  const candidate = await pin(product, "vendor/dep", dep, candidatePin, "candidate restores the mode")
  return { candidate, checkoutAt: (sha) => regressionCheckout(root, product, sha), head, root, target }
}

/** Real root criss-crosses, including a child criss-cross whose shared advance may be restored. */
async function ambiguousWorld(
  kind: "restore" | "multi-restore" | "shared" | "swallowed" | "no-base",
): Promise<RegressionWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-ambiguous-"))
  roots.push(root)
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "a.txt": "base\n" }, "base")
  const c1 = await commit(dep, { "a.txt": "target\n" }, "target advance")
  const c2 = await commit(dep, { "a.txt": "base\n" }, "stale restore")
  const dg = gitIn(dep, undefined, undefined, { env })
  let targetPin = c1
  let incomingPin = c1
  let candidatePin = c2
  if (kind === "shared" || kind === "multi-restore") {
    await dg(["checkout", "--quiet", "-b", "dep-left", c1])
    const left = await commit(dep, { "dep-left.txt": "left\n" }, "left from shared advance")
    await dg(["checkout", "--quiet", "-b", "dep-right", c1])
    const right = await commit(dep, { "dep-right.txt": "right\n" }, "right from shared advance")
    await dg(["checkout", "--quiet", "dep-left"])
    await dg([...author, "merge", "--no-ff", "--quiet", "-m", "left merges right", right])
    targetPin = (await dg(["rev-parse", "HEAD"])).trim()
    if (kind === "multi-restore") {
      targetPin = await commit(dep, { "a.txt": "target-only\n" }, "target-only advance beyond both bases")
    }
    await dg(["checkout", "--quiet", "dep-right"])
    await dg([...author, "merge", "--no-ff", "--quiet", "-m", "right merges left", left])
    incomingPin = await commit(
      dep,
      { "a.txt": kind === "multi-restore" ? "target\n" : "base\n" },
      "deliberately restore prior content",
    )
    candidatePin = incomingPin
    expect((await dg(["merge-base", "--all", targetPin, incomingPin])).trim().split("\n")).toHaveLength(2)
  } else if (kind === "swallowed" || kind === "no-base") {
    await dg(["checkout", "--quiet", "--detach", c1])
    incomingPin = await commit(dep, { "b.txt": "incoming\n" }, "incoming-only change")
    candidatePin = c1
  }
  const product = join(root, "product")
  mkdirSync(product)
  const pg = gitIn(product, undefined, undefined, { env })
  await pg(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  const root0 = await pin(product, "vendor/dep", dep, targetPin, "target pins the advance")
  // Later commit() calls stage the worktree: materialize the pin so add -A cannot delete it.
  await pg(["submodule", "update", "--init", "--quiet"])
  await pg(["checkout", "--quiet", "-b", "left"])
  await commit(product, { "left.txt": "l\n" }, "left")
  const left0 = (await pg(["rev-parse", "HEAD"])).trim()
  await pg(["checkout", "--quiet", "-b", "right", root0])
  await commit(product, { "right.txt": "r\n" }, "right")
  const right0 = (await pg(["rev-parse", "HEAD"])).trim()
  await pg(["checkout", "--quiet", "left"])
  await pg([...author, "merge", "--no-ff", "--quiet", "-m", "left merges right", right0])
  const target = (await pg(["rev-parse", "HEAD"])).trim()
  await pg(["checkout", "--quiet", "right"])
  await pg([...author, "merge", "--no-ff", "--quiet", "-m", "right merges left", left0])
  let head =
    incomingPin === targetPin
      ? (await pg(["rev-parse", "HEAD"])).trim()
      : await pin(product, "vendor/dep", dep, incomingPin, "head carries incoming change")
  if (kind === "no-base") {
    head = (await pg([...author, "commit-tree", `${head}^{tree}`, "-m", "unrelated incoming root"])).trim()
  }
  await pg(["checkout", "--quiet", "-b", "stale", root0])
  const candidate =
    candidatePin === targetPin
      ? (await pg(["rev-parse", "HEAD"])).trim()
      : await pin(product, "vendor/dep", dep, candidatePin, "candidate selects component result")
  return { candidate, checkoutAt: (sha) => regressionCheckout(root, product, sha), head, root, target }
}

type ComposeWorld = Readonly<{
  root: string
  repo: string
  env: NodeJS.ProcessEnv
  git: ReturnType<typeof gitIn>
  targetHead: string
  head: string
}>

/** A queue clone, a real git-super compose, and a candidate whose component pin is a stale restore. */
async function composeWorld(): Promise<ComposeWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-guard-compose-"))
  roots.push(root)
  const depPath = join(root, "dep")
  mkdirSync(depPath)
  const productRemote = "https://github.com/beorn/yrd-27363-product-fixture.git"
  const depRemote = "https://github.com/beorn/yrd-27363-dep-fixture.git"
  const remotePath = join(root, "product.git")
  const environment = {
    ...process.env,
    PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
    GIT_CONFIG_KEY_1: `url.${remotePath}.insteadOf`,
    GIT_CONFIG_VALUE_1: productRemote,
    GIT_CONFIG_KEY_2: `url.${depPath}.insteadOf`,
    GIT_CONFIG_VALUE_2: depRemote,
  }
  await gitIn(root, undefined, undefined, { env: environment })([
    "init",
    "--quiet",
    "--bare",
    "--initial-branch=main",
    remotePath,
  ])
  await gitIn(depPath, undefined, undefined, { env: environment })(["init", "--quiet", "--initial-branch=main"])
  await commit(depPath, { "a.txt": "base\n" }, "base", environment)
  const c1 = await commit(depPath, { "a.txt": "target\n" }, "target advance", environment)
  const c2 = await commit(depPath, { "a.txt": "base\n" }, "stale restore", environment)
  const productPath = join(root, "product")
  mkdirSync(productPath)
  const productGit = gitIn(productPath, undefined, undefined, { env: environment })
  await productGit(["init", "--quiet", "--initial-branch=main"])
  await commit(productPath, { "readme.txt": "product\n" }, "product base", environment)
  await pin(productPath, "vendor/dep", depRemote, c1, "base pins the advance", environment)
  await productGit(["remote", "add", "origin", productRemote])
  await productGit(["push", "--quiet", "origin", "main"])
  await productGit(["checkout", "--quiet", "-b", "candidate"])
  await pin(productPath, "vendor/dep", depRemote, c2, "candidate restores the stale value", environment)
  const head = (await productGit(["rev-parse", "HEAD"])).trim()
  await productGit(["checkout", "--quiet", "main"])
  await commit(productPath, { "main-only.txt": "main\n" }, "advance main", environment)
  const targetHead = (await productGit(["rev-parse", "HEAD"])).trim()
  await productGit(["push", "--quiet", "origin", "main", "candidate"])
  const repo = join(root, "queue-clone")
  await gitIn(root, undefined, undefined, { env: environment })([
    "clone",
    "--quiet",
    "--no-checkout",
    productRemote,
    repo,
  ])
  const git = gitIn(repo, undefined, undefined, { env: environment })
  await git(["fetch", "--quiet", "origin", "main", "candidate"])
  await git(["checkout", "--quiet", "main"])
  await git(["submodule", "update", "--init", "--quiet", "--", "vendor/dep"])
  return { env: environment, git, head, repo, root, targetHead }
}

type NestedWorld = Readonly<{
  target: string
  head: string
  candidateStale: string
  checkoutAt: (commit: string) => Promise<string>
}>

async function nestedWorld(): Promise<NestedWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-guard-nested-"))
  roots.push(root)
  const inner = join(root, "inner")
  mkdirSync(inner)
  await gitIn(inner, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(inner, { "x.txt": "base\n" }, "inner base")
  const i1 = await commit(inner, { "x.txt": "target\n" }, "inner target advance")
  const i2 = await commit(inner, { "x.txt": "base\n" }, "inner stale restore")
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "dep.txt": "dep\n" }, "dep base")
  const d1 = await pin(dep, "vendor/inner", inner, i1, "dep pins the inner advance")
  const d2 = await pin(dep, "vendor/inner", inner, i2, "dep restores the inner stale value")
  const product = join(root, "product")
  mkdirSync(product)
  const productGit = gitIn(product, undefined, undefined, { env })
  await productGit(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  const target = await pin(product, "vendor/dep", dep, d1, "target pins the dep advance")
  const head = await pin(product, "vendor/dep", dep, d1, "head keeps the dep advance")
  const candidateStale = await pin(product, "vendor/dep", dep, d2, "candidate restores the dep stale value")
  const checkoutAt = async (sha: string): Promise<string> => {
    const dir = join(root, `checkout-${sha.slice(0, 12)}`)
    await productGit(["worktree", "add", "--quiet", "--detach", dir, sha])
    await gitIn(dir, undefined, undefined, { env })(["submodule", "update", "--init", "--recursive", "--quiet"])
    return dir
  }
  return { candidateStale, checkoutAt, head, target }
}

/**
 * #28557: the target never advanced the path since the base; the branch's own commit deletes lines
 * an earlier merge added. Shapes the measured 27421 compose (km write-log-ledger `walkFrom`: the
 * branch deletes exactly the six lines feb326ab42 added, and `git log <base>..<target> -- <file>`
 * is empty because the target never touched that path). The older change is already shared history,
 * so restoring its pre-image is the branch's deliberate deletion, not a put-back of a target advance.
 */
async function deletionWorld(): Promise<RegressionWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-deletion-"))
  roots.push(root)
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "impl.txt": "one\n" }, "impl before the earlier merge")
  await commit(dep, { "impl.txt": "one\nwalk-from\n" }, "earlier merged change adds the bound")
  const basePin = await commit(dep, { "shared.txt": "shared\n" }, "base")
  const targetPin = await commit(dep, { "target-only.txt": "target\n" }, "target advances elsewhere")
  await gitIn(dep, undefined, undefined, { env })(["checkout", "--quiet", "-b", "branch", basePin])
  const candidatePin = await commit(dep, { "impl.txt": "one\n" }, "branch deletes the bound")
  const product = join(root, "product")
  mkdirSync(product)
  await gitIn(product, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  await pin(product, "vendor/dep", dep, basePin, "fork pins the base")
  const target = await pin(product, "vendor/dep", dep, targetPin, "target advances elsewhere")
  const head = await pin(product, "vendor/dep", dep, candidatePin, "branch deletes the bound")
  return { candidate: head, checkoutAt: (sha) => regressionCheckout(root, product, sha), head, root, target }
}

/** #28557: the target DID advance the path after the base; the candidate restores the pre-advance value. */
async function targetAdvanceWorld(): Promise<RegressionWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-advance-"))
  roots.push(root)
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "impl.txt": "one\n" }, "impl before the earlier merge")
  await commit(dep, { "impl.txt": "one\nwalk-from\n" }, "earlier merged change adds the bound")
  const basePin = await commit(dep, { "shared.txt": "shared\n" }, "base")
  const targetPin = await commit(dep, { "impl.txt": "one\nwalk-from\nmore\n" }, "target advances the path")
  await gitIn(dep, undefined, undefined, { env })(["checkout", "--quiet", "-b", "branch", basePin])
  const candidatePin = await commit(dep, { "candidate.txt": "c\n" }, "candidate keeps the pre-advance value")
  const product = join(root, "product")
  mkdirSync(product)
  await gitIn(product, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  await pin(product, "vendor/dep", dep, basePin, "fork pins the base")
  const target = await pin(product, "vendor/dep", dep, targetPin, "target advances the path")
  const head = await pin(product, "vendor/dep", dep, candidatePin, "candidate keeps the pre-advance value")
  return { candidate: head, checkoutAt: (sha) => regressionCheckout(root, product, sha), head, root, target }
}

/**
 * #28195, the add-only shape: the candidate CONTAINS the target pin (a fast-forward), exactly the
 * specimen (terminfo.dev 7c2d2dfe -> 871cb62e, target an ancestor of the candidate), and only ADDS
 * paths absent from the target with no target history to walk.
 */
async function addOnlyWorld(): Promise<RegressionWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-addonly-"))
  roots.push(root)
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "keep.txt": "keep\n" }, "base")
  const targetPin = await commit(dep, { "keep.txt": "keep\n", "advance.txt": "adv\n" }, "target advance")
  const added: Record<string, string> = {}
  for (let at = 0; at < 12; at += 1) added[`content/artifacts/a-${String(at)}.json`] = `{"n":${String(at)}}\n`
  const candidatePin = await commit(dep, added, "add-only content")
  const product = join(root, "product")
  mkdirSync(product)
  await gitIn(product, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  const target = await pin(product, "vendor/dep", dep, targetPin, "target pins the advance")
  const head = await pin(product, "vendor/dep", dep, candidatePin, "head asks for the add-only compose")
  return { candidate: head, checkoutAt: (sha) => regressionCheckout(root, product, sha), head, root, target }
}

/**
 * #28195, the discrimination: the target DELETED a path (its own advance) and the candidate, a child
 * of the target pin, restores the older value. The path is present at the candidate and ABSENT at the
 * target — an add-only diff row — yet it hides a revert and must still be judged and refused.
 */
async function targetDeletedWorld(): Promise<RegressionWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-revert-deleted-"))
  roots.push(root)
  const dep = join(root, "dep")
  mkdirSync(dep)
  await gitIn(dep, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(dep, { "a.txt": "one\n", "keep.txt": "keep\n" }, "base")
  rmSync(join(dep, "a.txt"))
  const targetPin = await commit(dep, { "keep.txt": "keep\n" }, "target deletes a.txt")
  const candidatePin = await commit(dep, { "a.txt": "one\n" }, "candidate restores a.txt")
  const product = join(root, "product")
  mkdirSync(product)
  await gitIn(product, undefined, undefined, { env })(["init", "--quiet", "--initial-branch=main"])
  await commit(product, { "readme.txt": "product\n" }, "product base")
  const target = await pin(product, "vendor/dep", dep, targetPin, "target pins the deletion")
  const head = await pin(product, "vendor/dep", dep, candidatePin, "head asks for the restore")
  return { candidate: head, checkoutAt: (sha) => regressionCheckout(root, product, sha), head, root, target }
}

describe("revert guard path cap (28195)", () => {
  it("add-only: absent paths spend no cap, name no gap, and the landing is clean", async () => {
    const w = await addOnlyWorld()
    const root = await w.checkoutAt(w.candidate)
    // pathCap 1 with 12 added paths: pre-#28195 this spent the single unit and marked 11 paths
    // kind:unjudged / reason:path cap P_max=1, so an add-only landing reported coverage incomplete.
    const report = await detectReverted({
      bounds: { depth: 3, pathCap: 1, window: 50 },
      candidate: w.candidate,
      git: gitIn(root, undefined, undefined, { env }),
      head: w.head,
      root,
      targetHead: w.target,
    })
    expect(report.coverage).toBe("complete")
    expect(report.gaps).toEqual([])
    expect(report.paths).toEqual([])
    expect(report.swallowed).toEqual([])
    expect(revertedPathsFinding(report)).toBeUndefined()
    expect(revertGuardAction(report, "observe")).toBe("clean")
    expect(revertGuardAction(report, "refuse")).toBe("clean")
  })

  it("restored-older-value: an added path the target deleted is still judged and still refused", async () => {
    const w = await targetDeletedWorld()
    const root = await w.checkoutAt(w.candidate)
    const report = await detectReverted({
      bounds: { depth: 3, pathCap: 500, window: 50 },
      candidate: w.candidate,
      git: gitIn(root, undefined, undefined, { env }),
      head: w.head,
      root,
      targetHead: w.target,
    })
    expect(report.paths.map((row) => row.path)).toContain("vendor/dep/a.txt")
    expect(revertedPathsFinding(report)?.reason).toContain("vendor/dep/a.txt")
    expect(revertGuardAction(report, "observe")).toBe("warn")
    expect(revertGuardAction(report, "refuse")).toBe("stick")
  })
})
