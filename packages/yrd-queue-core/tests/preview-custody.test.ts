/**
 * @reach fs-walk <fixture-only: temporary superproject with a nested submodule>
 * @failure A preview's candidate closure is unreadable once its scratch is gone (27510), or its custody grows without
 *          bound, loses the prior candidate on a failed attempt, renews its age on a retry, or leaks across subjects.
 * @level   l2 (real repositories, real submodule stores, real refs)
 * @consumer yrd submit and its preview (verifyCandidate's previewCustody), 27510 AC1-AC3
 * @testonly none
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createLocalGitWorktreeStore } from "git-super/worktree"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import {
  anchorPreviewCustody,
  PREVIEW_MAX_AGE_MS,
  previewCloneKey,
  previewSubjectPrefix,
  retirePreviewSubject,
} from "../src/preview-custody.ts"
import type { Git } from "../src/git.ts"
import { ReferenceUnpopulated } from "../src/reference.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=preview@yrd.test", "-c", "user.name=yrd"] as const

async function repository(path: string, file: string): Promise<void> {
  mkdirSync(path, { recursive: true })
  const git = gitIn(path)
  await git(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(path, file), `${file}\n`)
  await git(["add", "--all"])
  await git([...author, "commit", "--quiet", "--message", `add ${file}`])
}

/** An author's main worktree whose component and its nested component are both initialized stores. */
async function author_clone(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-preview-custody-"))
  roots.push(root)
  await repository(join(root, "nested"), "nested.txt")
  await repository(join(root, "dep"), "dep.txt")
  await gitIn(join(root, "dep"))(["submodule", "add", "--quiet", join(root, "nested"), "apps/nested"])
  await gitIn(join(root, "dep"))([...author, "commit", "--quiet", "--message", "add apps/nested"])
  const product = join(root, "product")
  await repository(product, "product.txt")
  await gitIn(product)(["submodule", "add", "--quiet", join(root, "dep"), "vendor/dep"])
  await gitIn(product)(["submodule", "update", "--init", "--recursive", "--quiet"])
  await gitIn(product)([...author, "commit", "--quiet", "--message", "add vendor/dep"])
  return product
}

/** A new candidate root: the component moves one commit, and the root records it. */
async function candidate(product: string, name: string): Promise<Readonly<{ root: string; dep: string }>> {
  const dep = gitIn(join(product, "vendor/dep"))
  writeFileSync(join(product, "vendor/dep", `${name}.txt`), `${name}\n`)
  await dep(["add", "--all"])
  await dep([...author, "commit", "--quiet", "--message", name])
  const git = gitIn(product)
  await git(["add", "vendor/dep"])
  await git([...author, "commit", "--quiet", "--message", `candidate ${name}`])
  return {
    dep: (await dep(["rev-parse", "HEAD"])).trim(),
    root: (await gitIn(product)(["rev-parse", "HEAD"])).trim(),
  }
}

async function anchorsIn(store: string, prefix = "refs/yrd/preview/"): Promise<Record<string, string>> {
  const listed = (await gitIn(store)(["for-each-ref", "--format=%(refname) %(objectname)", prefix])).trim()
  return Object.fromEntries(listed === "" ? [] : listed.split("\n").map((line) => line.split(" ") as [string, string]))
}

function anchor(product: string, subject: string, root: string): string {
  return `${previewSubjectPrefix(previewCloneKey(join(product, ".git")), subject)}${root}`
}

/** A gitIn whose `nth` deletion of a ref under `prefix` fails, as a held lock or a full disk would. */
function failingDeletion(prefix: string, nth: number): (cwd: string) => Git {
  let deletions = 0
  return (cwd) => {
    const git = gitIn(cwd)
    return async (args, input) => {
      if (args[0] === "update-ref" && args[1] === "-d" && args[2]?.startsWith(prefix) === true && ++deletions === nth) {
        throw new Error(`injected: update-ref -d ${args[2]} refused`)
      }
      return git(args, input)
    }
  }
}

/** Two prior roots under one subject: `first` through custody, `second` written beside it as a lost race leaves it. */
async function twoPriors(product: string) {
  const first = await candidate(product, "first")
  await custody(product, first.root)
  const second = await candidate(product, "second")
  await gitIn(product)(["update-ref", "--create-reflog", anchor(product, "task/a", second.root), second.root])
  // Deletion order is for-each-ref's: by name.
  const [earlier, later] = [first.root, second.root].map((root) => anchor(product, "task/a", root)).sort()
  if (earlier === undefined || later === undefined) throw new Error("two priors expected")
  return { earlier, later }
}

function custody(
  product: string,
  root: string,
  subject = "task/a",
  extra: Partial<Parameters<typeof anchorPreviewCustody>[0]> = {},
) {
  return anchorPreviewCustody({
    candidate: root,
    excludedSubmodules: [],
    git: gitIn(product),
    gitIn: (cwd) => gitIn(cwd),
    source: product,
    subject,
    ...extra,
  })
}

describe("anchorPreviewCustody (27510)", () => {
  it("keeps the root, its component and the nested component readable through one same-named anchor each", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    const nested = (await gitIn(join(product, "vendor/dep/apps/nested"))(["rev-parse", "HEAD"])).trim()

    const kept = await custody(product, first.root)

    const name = anchor(product, "task/a", first.root)
    expect(kept).toEqual({ anchor: name, retired: [], superseded: [] })
    expect(await anchorsIn(product)).toEqual({ [name]: first.root })
    expect(await anchorsIn(join(product, "vendor/dep"))).toEqual({ [name]: first.dep })
    expect(await anchorsIn(join(product, "vendor/dep/apps/nested"))).toEqual({ [name]: nested })
  }, 60_000)

  it("supersedes root first: the prior candidate's anchors are gone and the prefix names only the successor", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root)
    const second = await candidate(product, "second")

    const kept = await custody(product, second.root)

    const prior = anchor(product, "task/a", first.root)
    const next = anchor(product, "task/a", second.root)
    expect(kept.superseded).toEqual([prior])
    expect(await anchorsIn(product)).toEqual({ [next]: second.root })
    expect(await anchorsIn(join(product, "vendor/dep"))).toEqual({ [next]: second.dep })
    expect(Object.keys(await anchorsIn(join(product, "vendor/dep/apps/nested")))).toEqual([next])
  }, 60_000)

  it("treats the same candidate again as a no-op that keeps the anchor's first reflog entry", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root)
    const name = anchor(product, "task/a", first.root)
    const reflog = await gitIn(product)(["reflog", "show", "--format=%H %gd", name])

    expect(await custody(product, first.root)).toEqual({ anchor: name, retired: [], superseded: [] })
    expect(await gitIn(product)(["reflog", "show", "--format=%H %gd", name])).toBe(reflog)
  }, 60_000)

  it("fails by name on a store the author never initialized, leaving the prior custody and none of its own", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root)
    const before = {
      dep: await anchorsIn(join(product, "vendor/dep")),
      root: await anchorsIn(product),
    }
    // A candidate that also records a component whose store this clone never created.
    const git = gitIn(product)
    const dep = (await gitIn(join(product, "vendor/dep"))(["rev-parse", "HEAD"])).trim()
    await git(["config", "--file", ".gitmodules", "submodule.vendor/missing.path", "vendor/missing"])
    await git(["config", "--file", ".gitmodules", "submodule.vendor/missing.url", join(product, "..", "dep")])
    await git(["add", ".gitmodules"])
    await git(["update-index", "--add", "--cacheinfo", `160000,${dep},vendor/missing`])
    await git([...author, "commit", "--quiet", "--message", "record an uninitialized component"])
    const failing = (await git(["rev-parse", "HEAD"])).trim()

    const attempt = custody(product, failing)

    await expect(attempt).rejects.toBeInstanceOf(ReferenceUnpopulated)
    await expect(attempt).rejects.toThrow(/vendor\/missing/u)
    expect(await anchorsIn(product)).toEqual(before.root)
    expect(await anchorsIn(join(product, "vendor/dep"))).toEqual(before.dep)
  }, 60_000)

  it("stands past the commit point: a later prior's failed deletion keeps the new custody and names the leftover", async () => {
    const product = await author_clone()
    const priors = await twoPriors(product)
    const third = await candidate(product, "third")
    const named: string[] = []

    const kept = await custody(product, third.root, "task/a", {
      gitIn: failingDeletion(anchor(product, "task/a", ""), 2),
      leftover: (why) => void named.push(why),
    })

    const live = anchor(product, "task/a", third.root)
    expect(kept.superseded).toEqual([priors.earlier])
    const held = await anchorsIn(product)
    expect(held[live]).toBe(third.root)
    expect(Object.keys(held).sort()).toEqual([live, priors.later].sort())
    expect((await anchorsIn(join(product, "vendor/dep")))[live]).toBe(third.dep)
    expect(named.join("\n")).toContain(`${priors.later} outlived its supersession by ${live}`)
  }, 60_000)

  it("rolls back before the commit point: a failed first prior deletion leaves the priors and none of its own", async () => {
    const product = await author_clone()
    await twoPriors(product)
    const before = { dep: await anchorsIn(join(product, "vendor/dep")), root: await anchorsIn(product) }
    const third = await candidate(product, "third")

    const attempt = custody(product, third.root, "task/a", { gitIn: failingDeletion(anchor(product, "task/a", ""), 1) })

    await expect(attempt).rejects.toThrow(/injected: update-ref -d/u)
    expect(await anchorsIn(product)).toEqual(before.root)
    expect(await anchorsIn(join(product, "vendor/dep"))).toEqual(before.dep)
  }, 60_000)

  it("keeps each subject's custody independent of the others", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root, "task/a")
    const second = await candidate(product, "second")

    // 29088: custody must not probe each root separately for every component.
    // Behavioral custody assertions alone pass despite the roots × stores cost.
    let rootProbes = 0
    const linked = join(product, "..", "concurrent-writer")
    const contended = Promise.withResolvers<void>()
    const writer = createLocalGitWorktreeStore({ repo: product, report: () => contended.resolve() })
    let writing: Promise<void> | undefined
    await custody(product, second.root, "task/b", {
      gitIn: (cwd) => async (args, input) => {
        // A real supported write must wait while custody reads ages under the lock.
        // This is a safety control before and after the read-volume correction.
        if (args[0] === "reflog" && writing === undefined) {
          writing = writer.add({ kind: "detached", path: linked, ref: "HEAD" })
          await contended.promise
          expect(existsSync(linked)).toBe(false)
        }
        if (
          cwd === product &&
          args[0] === "rev-parse" &&
          args.includes("--verify") &&
          args.some((arg) => arg.startsWith("refs/yrd/preview/"))
        ) {
          rootProbes++
        }
        return gitIn(cwd)(args, input)
      },
    })
    expect(writing).toBeDefined()
    await writing
    expect((await gitIn(linked)(["rev-parse", "HEAD"])).trim()).toBe(second.root)
    expect(rootProbes, "one new-root check; the sweep shares its root observation").toBeLessThanOrEqual(1)

    expect(await anchorsIn(product)).toEqual({
      [anchor(product, "task/a", first.root)]: first.root,
      [anchor(product, "task/b", second.root)]: second.root,
    })

    // 28823: one live root and fifty must cost the same number of Git calls.
    // Custody semantics alone miss a separate age-reading process per root.
    const invocationCounts: number[] = []
    for (const roots of [1, 50]) {
      if (roots === 50) {
        for (let index = 1; index < roots; index++) {
          await gitIn(product)([
            "update-ref",
            "--create-reflog",
            anchor(product, `task/live-${index}`, first.root),
            first.root,
          ])
        }
      }
      let invocations = 0
      const named: string[] = []
      const result = await custody(product, second.root, "task/b", {
        leftover: (why) => void named.push(why),
        gitIn: (cwd) => async (args, input) => {
          invocations++
          return gitIn(cwd)(args, input)
        },
      })
      expect(result.retired).toEqual([])
      expect(named).toEqual([])
      expect(Object.keys(await anchorsIn(product))).toHaveLength(roots + 1)
      invocationCounts.push(invocations)
    }
    expect(invocationCounts[1], "age-reading work must not add a Git process for each live root").toBe(
      invocationCounts[0],
    )
  }, 60_000)

  it("sweeps a component anchor whose root anchor is gone", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    const orphan = anchor(product, "task/gone", "0".repeat(40))
    await gitIn(join(product, "vendor/dep"))(["update-ref", orphan, first.dep])

    await custody(product, first.root)

    expect(Object.keys(await anchorsIn(join(product, "vendor/dep")))).toEqual([anchor(product, "task/a", first.root)])
  }, 60_000)

  /** @failure A shared root observation drops tag peeling, hides errors, or deletes under an unreadable root list.
   * @level l2 @consumer submit preview custody, 29088 lock-bound root observation. */
  it.each(["missing", "tag", "blob", "unreadable"] as const)(
    "sweeps with a %s root using the existing custody and error semantics",
    async (kind) => {
      const product = await author_clone()
      const first = await candidate(product, "first")
      const git = gitIn(product)
      const name = anchor(product, "task/other", first.root)
      const store = join(product, "vendor/dep")
      const named: string[] = []
      if (kind === "tag") {
        await git([...author, "tag", "-a", "preview-tag", first.root, "-m", "preview root"])
        await git(["update-ref", "--create-reflog", name, "refs/tags/preview-tag"])
      } else if (kind === "blob") {
        const blob = (await git(["hash-object", "-w", "--stdin"], "not a commit\n")).trim()
        await git(["update-ref", "--create-reflog", name, blob])
      }
      await gitIn(store)(["update-ref", name, first.dep])
      await custody(product, first.root, "task/a", {
        leftover: (why) => void named.push(why),
        gitIn: (cwd) => async (args, input) => {
          if (
            kind === "unreadable" &&
            cwd === product &&
            args[0] === "for-each-ref" &&
            args.at(-1) === `refs/yrd/preview/${previewCloneKey(join(product, ".git"))}/`
          ) {
            throw new Error("injected root listing failure")
          }
          return gitIn(cwd)(args, input)
        },
      })
      expect((await anchorsIn(store))[name]).toBe(kind === "missing" ? undefined : first.dep)
      if (kind === "tag") expect(named.join("\n")).not.toContain("orphan sweep")
      if (kind === "blob" || kind === "unreadable") {
        expect(named.join("\n")).toContain("orphan sweep")
        expect(named.join("\n")).toContain(kind === "blob" ? name : "injected root listing failure")
      }
    },
    60_000,
  )

  it("retires an ended subject's custody root first, then sweeps its components", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root, "task/landed")
    const second = await candidate(product, "second")

    const kept = await custody(product, second.root, "task/a", { retired: new Set(["task/landed"]) })

    expect(kept.retired).toEqual([anchor(product, "task/landed", first.root)])
    const live = anchor(product, "task/a", second.root)
    expect(await anchorsIn(product)).toEqual({ [live]: second.root })
    expect(Object.keys(await anchorsIn(join(product, "vendor/dep")))).toEqual([live])
  }, 60_000)

  it("retires another subject whose anchor's first reflog entry is past seven days, and keeps a younger one", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root, "task/old")
    const second = await candidate(product, "second")
    // The first reflog entry controls age even if the same anchor was updated
    // recently. Commit timestamps are recent and cannot supply this age.
    const old = anchor(product, "task/old", first.root)
    const log = join(product, ".git", "logs", old)
    const oldSeconds = Math.floor((Date.now() - PREVIEW_MAX_AGE_MS - 60_000) / 1000)
    writeFileSync(log, readFileSync(log, "utf8").replace(/> \d+ ([+-]\d{4})/u, `> ${oldSeconds} $1`))
    await gitIn(product)(["update-ref", old, second.root])
    await gitIn(product)(["update-ref", old, first.root])
    const young = await custody(product, second.root, "task/a", {
      now: () => oldSeconds * 1000 + PREVIEW_MAX_AGE_MS - 60_000,
    })
    expect(young.retired).toEqual([])

    const third = await candidate(product, "third")
    const aged = await custody(product, third.root, "task/a")

    expect(aged.retired).toEqual([anchor(product, "task/old", first.root)])
  }, 60_000)

  it.each(["missing", "malformed"])(
    "keeps, and names, another subject's anchor whose age is %s",
    async (kind) => {
      const product = await author_clone()
      const first = await candidate(product, "first")
      // No --create-reflog: an anchor written outside custody has no first entry to date it.
      const ageless = anchor(product, "task/ageless", first.root)
      await gitIn(product)(["update-ref", ageless, first.root])
      const second = await candidate(product, "second")
      const named: string[] = []

      const kept = await custody(product, second.root, "task/a", {
        leftover: (why) => void named.push(why),
        now: () => Date.now() + 10 * PREVIEW_MAX_AGE_MS,
        gitIn: (cwd) => async (args, input) =>
          kind === "malformed" && args[0] === "reflog" ? `${ageless}@{not-a-date}\n` : gitIn(cwd)(args, input),
      })

      expect(kept.retired).toEqual([])
      expect(Object.keys(await anchorsIn(product))).toContain(ageless)
      expect(named.join("\n")).toContain(`${ageless}'s age is unknown, so it is kept`)
    },
    60_000,
  )

  /** @failure An unreadable bulk age listing expires unknown anchors, hides a slow fallback, or aborts new custody.
   * @level l2 @consumer preview custody's age retirement; ordinary missing-age coverage has no failed batch. */
  it("keeps age-dependent anchors after one named bulk failure while explicit retirement and custody proceed", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    const others = ["task/old-a", "task/old-b", "task/ended"]
    for (const subject of others) {
      await gitIn(product)(["update-ref", "--create-reflog", anchor(product, subject, first.root), first.root])
    }
    const second = await candidate(product, "second")
    const named: string[] = []
    let ageReads = 0
    const result = await custody(product, second.root, "task/a", {
      now: () => Date.now() + PREVIEW_MAX_AGE_MS + 60_000,
      retired: new Set(["task/ended"]),
      leftover: (why) => void named.push(why),
      gitIn: (cwd) => async (args, input) => {
        if (args[0] === "reflog") {
          ageReads++
          throw new Error("injected unreadable preview reflogs")
        }
        return gitIn(cwd)(args, input)
      },
    })
    expect(ageReads).toBe(1)
    expect(named).toHaveLength(1)
    expect(named[0]).toContain("injected unreadable preview reflogs")
    expect(named[0]).toContain(`refs/yrd/preview/${previewCloneKey(join(product, ".git"))}/`)
    expect(result.retired).toEqual([anchor(product, "task/ended", first.root)])
    expect(await anchorsIn(product)).toEqual({
      [anchor(product, "task/old-a", first.root)]: first.root,
      [anchor(product, "task/old-b", first.root)]: first.root,
      [result.anchor]: second.root,
    })
  }, 60_000)

  it("retires one subject on env close, root then components, and leaves every other subject's custody", async () => {
    const product = await author_clone()
    const first = await candidate(product, "first")
    await custody(product, first.root, "task/closing")
    const second = await candidate(product, "second")
    await custody(product, second.root, "task/a")

    const retired = await retirePreviewSubject({
      git: gitIn(product),
      gitIn: (cwd) => gitIn(cwd),
      subject: "task/closing",
    })

    const live = anchor(product, "task/a", second.root)
    expect(retired).toEqual([anchor(product, "task/closing", first.root)])
    expect(await anchorsIn(product)).toEqual({ [live]: second.root })
    expect(Object.keys(await anchorsIn(join(product, "vendor/dep")))).toEqual([live])
    expect(Object.keys(await anchorsIn(join(product, "vendor/dep/apps/nested")))).toEqual([live])
  }, 60_000)

  it("retires a subject on env close past a component this clone never initialized, reading nothing there", async () => {
    const product = await author_clone()
    const git = gitIn(product)
    const dep = (await gitIn(join(product, "vendor/dep"))(["rev-parse", "HEAD"])).trim()
    // A private component: the candidate records it, custody leaves it out, and env close does not know to.
    await git(["config", "--file", ".gitmodules", "submodule.vendor/private.path", "vendor/private"])
    await git(["config", "--file", ".gitmodules", "submodule.vendor/private.url", join(product, "..", "dep")])
    await git(["add", ".gitmodules"])
    await git(["update-index", "--add", "--cacheinfo", `160000,${dep},vendor/private`])
    await git([...author, "commit", "--quiet", "--message", "record a private component"])
    const recorded = (await git(["rev-parse", "HEAD"])).trim()
    await custody(product, recorded, "task/closing", { excludedSubmodules: ["vendor/private"] })

    const retired = await retirePreviewSubject({ git, gitIn: (cwd) => gitIn(cwd), subject: "task/closing" })

    expect(retired).toEqual([anchor(product, "task/closing", recorded)])
    expect(await anchorsIn(product)).toEqual({})
    expect(await anchorsIn(join(product, "vendor/dep"))).toEqual({})
  }, 60_000)

  /**
   * @cto a3b6b631: the swap takes its own acquisition, so two attempts for one subject can interleave as A composes,
   * B composes and swaps inside A's gap, then A swaps. Custody then holds the LAST SWAPPED candidate (here the older
   * one), and B's receipt, emitted first, must still lead its reader to A.
   */
  it("leaves exactly one live candidate when a second attempt swaps inside the first one's gap", async () => {
    const product = await author_clone()
    const a = await candidate(product, "a")
    const nestedA = (await gitIn(join(product, "vendor/dep/apps/nested"))(["rev-parse", "HEAD"])).trim()
    const b = await candidate(product, "b")
    // B swaps first and emits its receipt (release-then-emit); A's swap follows.
    const bReceipt = await custody(product, b.root)
    await custody(product, a.root)

    const live = anchor(product, "task/a", a.root)
    const loser = bReceipt.anchor
    expect(await anchorsIn(product)).toEqual({ [live]: a.root })
    expect(await anchorsIn(join(product, "vendor/dep"))).toEqual({ [live]: a.dep })
    expect(await anchorsIn(join(product, "vendor/dep/apps/nested"))).toEqual({ [live]: nestedA })
    // From B's own receipt: its root anchor names itself as absent, and the subject prefix lists the superseder.
    await expect(gitIn(product)(["rev-parse", "--verify", `${loser}^{commit}`])).rejects.toThrow()
    const prefix = loser.slice(0, loser.lastIndexOf("/") + 1)
    expect(Object.keys(await anchorsIn(product, prefix))).toEqual([live])
  }, 60_000)
})
