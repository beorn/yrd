import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BayState } from "../src/types.ts"
import { preReceiveCheck, patchIdRewriteVerdict } from "../src/layers/receive.ts"
import { git } from "../src/layers/git.ts"

/**
 * Pin rules at the receiver door (/pro A5): descendant moves pass, history
 * REWRITES (rebase/amend — same patches, new SHAs) are tolerated with a note,
 * history REWINDS (patches dropped) refuse, gitlink ADDs pass. Gitlink commits
 * are built with plumbing (update-index --cacheinfo + write-tree + commit-tree)
 * — no real submodule wiring needed; gitlink SHAs are not validated by git.
 */

async function must(args: string[], cwd: string): Promise<string> {
  const res = await git(args, cwd)
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr}`)
  return res.stdout.trim()
}

const EMPTY: BayState = { leases: {}, changesets: {}, slices: {} }

describe("preReceiveCheck — gitlink pin verdicts", () => {
  let root: string
  let main: string // "main repo" containing the nested sub repo
  let sub: string
  let superRepo: string // plays the bay-owned repo.git (diff-tree source)
  let shas: { A: string; B: string; B2: string; Bamend: string }
  let supers: { s0: string; s1: string; sDesc: string; sRewrite: string; sRewind: string }

  async function commitGitlink(pin: string | null, parent: string | null, msg: string): Promise<string> {
    if (pin) {
      await must(["-C", superRepo, "update-index", "--add", "--cacheinfo", `160000,${pin},sub`], superRepo)
    } else {
      const rm = await git(["-C", superRepo, "rm", "--cached", "-q", "sub"], superRepo)
      void rm // absent is fine on the first commit
    }
    const tree = await must(["-C", superRepo, "write-tree"], superRepo)
    const args = ["-C", superRepo, "commit-tree", tree, "-m", msg]
    if (parent) args.push("-p", parent)
    return await must(args, superRepo)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bay-pins-"))
    main = join(root, "main")
    sub = join(main, "sub")
    superRepo = join(root, "super")
    const env = ["-c", "user.name=t", "-c", "user.email=t@x.invalid"]

    await must(["init", "-q", "-b", "main", main], root)
    await must(["init", "-q", "-b", "main", sub], root)
    await writeFile(join(sub, "f.txt"), "one\n")
    await must(["-C", sub, "add", "f.txt"], sub)
    await must(["-C", sub, ...env, "commit", "-qm", "A"], sub)
    const A = await must(["-C", sub, "rev-parse", "HEAD"], sub)
    await writeFile(join(sub, "f.txt"), "two\n")
    await must(["-C", sub, ...env, "commit", "-aqm", "B"], sub)
    const B = await must(["-C", sub, "rev-parse", "HEAD"], sub)
    // fwd: a child of B (descendant move target)
    await writeFile(join(sub, "f.txt"), "three\n")
    await must(["-C", sub, ...env, "commit", "-aqm", "B2"], sub)
    const B2 = await must(["-C", sub, "rev-parse", "HEAD"], sub)
    // rw: amend of B on a side branch — same patch, different SHA, NOT a descendant of B
    await must(["-C", sub, "checkout", "-q", "-b", "rw", B], sub)
    await must(["-C", sub, ...env, "commit", "--amend", "-qm", "B reworded"], sub)
    const Bamend = await must(["-C", sub, "rev-parse", "HEAD"], sub)
    shas = { A, B, B2, Bamend }

    await must(["init", "-q", "-b", "main", superRepo], root)
    const s0 = await commitGitlink(null, null, "s0: no sub")
    const s1 = await commitGitlink(B, s0, "s1: pin B")
    const sDesc = await commitGitlink(B2, s1, "pin B2 (descendant)")
    const sRewrite = await commitGitlink(Bamend, s1, "pin Bamend (rewrite)")
    const sRewind = await commitGitlink(A, s1, "pin A (rewind)")
    supers = { s0, s1, sDesc, sRewrite, sRewind }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const ctx = () => ({ repoGit: superRepo, mainRepo: main })
  const upd = (oldSha: string, newSha: string) => [{ oldSha, newSha, ref: "refs/heads/task/x" }]

  it("descendant pin move passes without a note", async () => {
    const msgs = await preReceiveCheck(EMPTY, upd(supers.s1, supers.sDesc), ctx())
    expect(msgs.join("\n")).toContain("accepted for intake")
    expect(msgs.join("\n")).not.toContain("rewrite")
  })

  it("rebase/amend rewrite is tolerated with a patch-id note", async () => {
    const msgs = await preReceiveCheck(EMPTY, upd(supers.s1, supers.sRewrite), ctx())
    expect(msgs.join("\n")).toMatch(/history rewrite \(1\/1 old patches present/)
    expect(msgs.join("\n")).toContain("accepted for intake")
  })

  it("history rewind (dropped patch) refuses and names the count", async () => {
    await expect(preReceiveCheck(EMPTY, upd(supers.s1, supers.sRewind), ctx())).rejects.toThrow(
      /pin refusal.*1 of 1 old patches missing/s,
    )
  })

  it("gitlink ADD is allowed by design", async () => {
    const msgs = await preReceiveCheck(EMPTY, upd(supers.s0, supers.s1), ctx())
    expect(msgs.join("\n")).toContain("accepted for intake")
  })

  it("patchIdRewriteVerdict: unrelated histories refuse with no-common-ancestor", async () => {
    const orphanRepo = join(root, "orphan")
    await must(["init", "-q", "-b", "main", orphanRepo], root)
    await writeFile(join(orphanRepo, "z.txt"), "z\n")
    await must(["-C", orphanRepo, "add", "z.txt"], orphanRepo)
    await must(["-C", orphanRepo, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "commit", "-qm", "Z"], orphanRepo)
    const Z = await must(["-C", orphanRepo, "rev-parse", "HEAD"], orphanRepo)
    // fetch Z into sub so both SHAs resolve there, histories still unrelated
    await must(["-C", sub, "fetch", "-q", orphanRepo, "main:orphan"], sub)
    const v = await patchIdRewriteVerdict(sub, shas.B, Z)
    expect(v.rewrite).toBe(false)
    expect(v.reason).toContain("no common ancestor")
  })
})
