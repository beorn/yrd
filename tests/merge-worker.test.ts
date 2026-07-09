import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createGitbay,
  createJsonlJournal,
  integratablePrs,
  pipe,
  withMergeWorker,
  withQueue,
} from "../src/index.ts"
import type { BayEvent, BayRuntime, BayState, BayStore, MergeWorkerOptions, PrId } from "../src/index.ts"
import { git } from "../src/layers/git.ts"
import { runMerge } from "../src/layers/pipeline.ts"

const CLOCK = () => "2024-01-01T00:00:00.000Z"
const ACTOR = "tester"

async function tmpJournalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-merge-"))
  return join(dir, "journal.jsonl")
}

function openStore(path: string): BayStore {
  return { journal: createJsonlJournal(path), close: async () => {} }
}

// The merge worker runs the REAL effect handlers against trivial shell commands
// (`true` / `false` / `echo`), so there are no mocks — the config resolution,
// sh -c spawn, exit-code→state mapping, and detail capture all execute for real.
async function buildMergeBay(path: string, opts: MergeWorkerOptions): Promise<BayRuntime> {
  return pipe(
    createGitbay({ store: openStore(path), clock: CLOCK, actor: ACTOR }),
    withQueue(),
    withMergeWorker(opts),
  )
}

function stateOf(state: BayState, id: PrId): string {
  return state.prs[id]!.state
}

function detailOf(events: BayEvent[], to: string): string | undefined {
  const ev = events.find((e) => e.name === "pr/changed" && e.data!.to === to)
  return ev?.data!.detail as string | undefined
}

/** `enqueue` seeds a PR directly into `submitted` (the raw test primitive);
 *  `check` with no check configured is an automatic pass — the shortest path
 *  to a `checked` PR for tests that only care about the MERGE half. */
async function seedChecked(bay: BayRuntime, target: string, pr: PrId): Promise<void> {
  await bay.dispatch({ type: "enqueue", args: { target, pr } })
  await bay.dispatch({ type: "check", args: { pr } })
}

describe("withMergeWorker — check: submitted → checking → checked | rejected", () => {
  it("passes with no check configured (opt-in checks) and transitions to checked", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), {})
    await bay.dispatch({ type: "enqueue", args: { target: "task/x", pr: "C-x" } })

    const { events } = await bay.dispatch({ type: "check", args: { pr: "C-x" } })
    const transitions = events.filter((e) => e.name === "pr/changed").map((e) => `${e.data!.from}→${e.data!.to}`)
    expect(transitions).toEqual(["submitted→checking", "checking→checked"])
    expect(stateOf(await bay.state(), "C-x")).toBe("checked")
  })

  it("rejects with check-failed when the configured check exits nonzero", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { check: "false" })
    await bay.dispatch({ type: "enqueue", args: { target: "task/y", pr: "C-y" } })

    const { events } = await bay.dispatch({ type: "check", args: { pr: "C-y" } })
    expect(detailOf(events, "rejected")).toMatch(/check 'false' failed \(exit 1\)/)
    const finished = events.find((e) => e.name === "line/step/finished")!
    expect(finished.data!.error).toMatchObject({
      code: "check-failed",
      message: expect.stringContaining("check 'false' failed (exit 1)"),
      exitCode: 1,
    })
    const rejected = events.find((e) => e.name === "pr/changed" && e.data!.to === "rejected")!
    expect(rejected.data!.code).toBe("check-failed")
    expect(stateOf(await bay.state(), "C-y")).toBe("rejected")
  })

  it("never merges — check is atomic and stops at the verdict", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    await bay.dispatch({ type: "enqueue", args: { target: "task/z", pr: "C-z" } })
    const { events } = await bay.dispatch({ type: "check", args: { pr: "C-z" } })
    expect(events.some((e) => e.data!.to === "merging" || e.data!.to === "merged")).toBe(false)
    expect(stateOf(await bay.state(), "C-z")).toBe("checked")
  })

  it("refuses a PR that isn't submitted, teaching the right verb", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), {})
    await seedChecked(bay, "task/a", "C-a")
    await expect(bay.dispatch({ type: "check", args: { pr: "C-a" } })).rejects.toThrow(
      /check: C-a is already checked — git bay merge C-a/,
    )
  })

  it("throws checking an unknown PR", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), {})
    await expect(bay.dispatch({ type: "check", args: { pr: "C-none" } })).rejects.toThrow(/no PR 'C-none'/)
  })

  it("a bayless PR's check runs against the PR's target tree, not the mainline working tree", async () => {
    // main has README only; task/x adds only-on-x.txt. A check for that file
    // can only pass if it runs against task/x's tree — running it in the
    // mainline working tree (main checked out) would reject a good PR.
    const repo = await mkdtemp(join(tmpdir(), "gitbay-check-tree-"))
    const g = async (args: string[]) => {
      const res = await git(["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", ...args], repo)
      if (res.code !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${res.stderr}`)
      return res
    }
    await g(["init", "-q", "-b", "main"])
    await writeFile(join(repo, "README"), "base\n")
    await g(["add", "-A"])
    await g(["commit", "-qm", "base"])
    await g(["switch", "-qc", "task/x"])
    await writeFile(join(repo, "only-on-x.txt"), "x\n")
    await g(["add", "-A"])
    await g(["commit", "-qm", "feat: x"])
    await g(["switch", "-q", "main"])

    const bay = await buildMergeBay(await tmpJournalPath(), {
      mainRepo: repo,
      check: "test -f only-on-x.txt",
    })
    await bay.dispatch({ type: "enqueue", args: { target: "task/x", pr: "C-tree" } })

    const { events } = await bay.dispatch({ type: "check", args: { pr: "C-tree" } })
    const transitions = events.filter((e) => e.name === "pr/changed").map((e) => `${e.data!.from}→${e.data!.to}`)
    expect(transitions).toEqual(["submitted→checking", "checking→checked"])
    expect(stateOf(await bay.state(), "C-tree")).toBe("checked")
  })
})

describe("withMergeWorker — merge: checked → merging → merged (happy path)", () => {
  it("transitions checked → merging → merged and captures stdout (both placeholders) as detail", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "echo {pr} {target}" })
    await seedChecked(bay, "task/x", "C-x")

    const { events } = await bay.dispatch({ type: "merge", args: { pr: "C-x" } })

    const transitions = events.filter((e) => e.name === "pr/changed").map((e) => `${e.data!.from}→${e.data!.to}`)
    expect(transitions).toEqual(["checked→merging", "merging→merged"])
    expect(detailOf(events, "merged")).toBe("C-x task/x") // {pr} {target} both substituted
    expect(stateOf(await bay.state(), "C-x")).toBe("merged")
  })

  it("refuses a PR that isn't checked, teaching the right verb", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    await bay.dispatch({ type: "enqueue", args: { target: "t", pr: "C-early" } })
    await expect(bay.dispatch({ type: "merge", args: { pr: "C-early" } })).rejects.toThrow(
      /merge: C-early hasn't been checked yet — git bay check C-early/,
    )
  })

  it("never checks — merge is atomic and requires an explicit PR", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    await expect(bay.dispatch({ type: "merge", args: {} })).rejects.toThrow(/'pr'.*required/)
  })
})

describe("withMergeWorker — merge → rejected (non-zero is a domain outcome, not a crash)", () => {
  it("a non-zero merge command rejects with the exit code in detail (never throws)", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "false" })
    await seedChecked(bay, "t", "C-r")

    const { events } = await bay.dispatch({ type: "merge", args: { pr: "C-r" } }) // resolves, does NOT reject
    expect(detailOf(events, "rejected")).toBe("exit 1")
    const finished = events.find((e) => e.name === "line/step/finished")!
    expect(finished.data!.error).toMatchObject({ code: "merge-command-failed", message: "exit 1", exitCode: 1 })
    expect(stateOf(await bay.state(), "C-r")).toBe("rejected")
  })

  it("captures the stderr tail alongside the exit code", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "echo boom >&2; exit 3" })
    await seedChecked(bay, "t", "C-e")

    const { events } = await bay.dispatch({ type: "merge", args: { pr: "C-e" } })
    expect(detailOf(events, "rejected")).toBe("exit 3: boom")
    expect(stateOf(await bay.state(), "C-e")).toBe("rejected")
  })
})

describe("withMergeWorker — post-merge ancestry verify (the lying-merge guard, G1.1/G1.2)", () => {
  // A REAL repo: main at an init commit, task/x one commit ahead. The guard's
  // question is exactly "did the merge command's exit 0 actually land task/x
  // on the mainline?" — so these tests need true git ancestry, not stubs.
  async function makeVerifyRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "gitbay-verify-repo-"))
    const g = async (args: string[]) => {
      const res = await git(["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", ...args], repo)
      if (res.code !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${res.stderr}`)
      return res
    }
    await g(["init", "-q", "-b", "main"])
    await g(["commit", "-qm", "init", "--allow-empty"])
    await g(["switch", "-qc", "task/x"])
    await g(["commit", "-qm", "feat: x", "--allow-empty"])
    await g(["switch", "-q", "main"])
    return repo
  }

  it("a merge command that exits 0 WITHOUT landing the target is journaled rejected, never merged", async () => {
    const repo = await makeVerifyRepo()
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true", mainRepo: repo })
    await seedChecked(bay, "task/x", "C-lie")

    const { events } = await bay.dispatch({ type: "merge", args: { pr: "C-lie" } })
    expect(stateOf(await bay.state(), "C-lie")).toBe("rejected")
    expect(detailOf(events, "rejected")).toMatch(/lying-merge guard/)
    expect(detailOf(events, "rejected")).toMatch(/not an ancestor/)
  })

  it("a merge command that actually lands the target passes the verify and records merged", async () => {
    const repo = await makeVerifyRepo()
    const bay = await buildMergeBay(await tmpJournalPath(), {
      mergeCommand: `git -C ${repo} -c user.name=t -c user.email=t@e merge --no-ff -q {target}`,
      mainRepo: repo,
    })
    await seedChecked(bay, "task/x", "C-honest")

    await bay.dispatch({ type: "merge", args: { pr: "C-honest" } })
    expect(stateOf(await bay.state(), "C-honest")).toBe("merged")
  })

  it("an unresolvable target with mainRepo set rejects with a teaching detail (never crashes, never merges)", async () => {
    const repo = await makeVerifyRepo()
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true", mainRepo: repo })
    await seedChecked(bay, "task/ghost", "C-ghost")

    const { events } = await bay.dispatch({ type: "merge", args: { pr: "C-ghost" } })
    expect(stateOf(await bay.state(), "C-ghost")).toBe("rejected")
    expect(detailOf(events, "rejected")).toMatch(/does not resolve/)
  })
})

describe("withMergeWorker — zero-config native merge (§4: bay.mergeCommand unset)", () => {
  async function makeNativeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "gitbay-native-repo-"))
    const g = async (args: string[]) => {
      const res = await git(["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", ...args], repo)
      if (res.code !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${res.stderr}`)
      return res
    }
    await g(["init", "-q", "-b", "main"])
    await g(["commit", "-qm", "init", "--allow-empty"])
    await g(["switch", "-qc", "task/x"])
    await g(["commit", "-qm", "feat: x", "--allow-empty"])
    await g(["switch", "-q", "main"])
    return repo
  }

  it("lands with a native git merge --no-ff and records 'merged <sha> onto <mainline>'", async () => {
    const saved = process.env.BAY_MERGE_COMMAND
    delete process.env.BAY_MERGE_COMMAND
    try {
      const repo = await makeNativeRepo()
      const bay = await buildMergeBay(await tmpJournalPath(), { mainRepo: repo }) // no mergeCommand at all
      await seedChecked(bay, "task/x", "C-native")

      const { events } = await bay.dispatch({ type: "merge", args: { pr: "C-native" } })
      expect(stateOf(await bay.state(), "C-native")).toBe("merged")
      expect(detailOf(events, "merged")).toMatch(/^merged [0-9a-f]{40} onto main$/)

      const log = await git(["-C", repo, "log", "--oneline", "-1"], repo)
      expect(log.stdout).toContain("bay: merge C-native (task/x)")
    } finally {
      if (saved !== undefined) process.env.BAY_MERGE_COMMAND = saved
    }
  })

  it("rejects with dirty-mainline when the mainline working tree has a staged (tracked) change", async () => {
    const saved = process.env.BAY_MERGE_COMMAND
    delete process.env.BAY_MERGE_COMMAND
    try {
      const repo = await makeNativeRepo()
      const { writeFile } = await import("node:fs/promises")
      await writeFile(join(repo, "dirty.txt"), "uncommitted\n", "utf8")
      // Untracked files don't block (git merge itself refuses to overwrite
      // them) — stage it so porcelain status reports a real, blocking change.
      await git(["-C", repo, "add", "dirty.txt"], repo)
      const bay = await buildMergeBay(await tmpJournalPath(), { mainRepo: repo })
      await seedChecked(bay, "task/x", "C-dirty")

      const { events } = await bay.dispatch({ type: "merge", args: { pr: "C-dirty" } })
      expect(stateOf(await bay.state(), "C-dirty")).toBe("rejected")
      const rejected = events.find((e) => e.name === "pr/changed" && e.data!.to === "rejected")!
      expect(rejected.data!.code).toBe("dirty-mainline")
      expect(detailOf(events, "rejected")).toMatch(/is dirty/)
    } finally {
      if (saved !== undefined) process.env.BAY_MERGE_COMMAND = saved
    }
  })

  it("stamps the audited Bay-Gate trailer (pr/target/base/check) on the native merge commit", async () => {
    const savedMerge = process.env.BAY_MERGE_COMMAND
    const savedCheck = process.env.BAY_CHECK
    delete process.env.BAY_MERGE_COMMAND
    delete process.env.BAY_CHECK
    try {
      const repo = await makeNativeRepo()
      const base = (await git(["-C", repo, "rev-parse", "main"], repo)).stdout.trim()
      const target = (await git(["-C", repo, "rev-parse", "task/x"], repo)).stdout.trim()
      const bay = await buildMergeBay(await tmpJournalPath(), { mainRepo: repo, check: "true" })
      await seedChecked(bay, "task/x", "C-trailer")

      await bay.dispatch({ type: "merge", args: { pr: "C-trailer" } })

      const trailer = await git(["-C", repo, "log", "-1", "--format=%(trailers:key=Bay-Gate,valueonly=true)", "main"], repo)
      expect(trailer.stdout.trim()).toBe(`pr=C-trailer target=${target} base=${base} check=true`)
      // The trailer's claims are verifiable from the commit graph alone:
      // base is the first parent, target the second.
      expect((await git(["-C", repo, "rev-parse", "main^1"], repo)).stdout.trim()).toBe(base)
      expect((await git(["-C", repo, "rev-parse", "main^2"], repo)).stdout.trim()).toBe(target)
    } finally {
      if (savedMerge !== undefined) process.env.BAY_MERGE_COMMAND = savedMerge
      if (savedCheck !== undefined) process.env.BAY_CHECK = savedCheck
    }
  })

  it("stamps check=none when no gate is configured — non-evidence auditors must reject, not a pass", async () => {
    const savedMerge = process.env.BAY_MERGE_COMMAND
    const savedCheck = process.env.BAY_CHECK
    delete process.env.BAY_MERGE_COMMAND
    delete process.env.BAY_CHECK
    try {
      const repo = await makeNativeRepo()
      const bay = await buildMergeBay(await tmpJournalPath(), { mainRepo: repo })
      await seedChecked(bay, "task/x", "C-nocheck")

      await bay.dispatch({ type: "merge", args: { pr: "C-nocheck" } })

      const trailer = await git(["-C", repo, "log", "-1", "--format=%(trailers:key=Bay-Gate,valueonly=true)", "main"], repo)
      expect(trailer.stdout.trim()).toMatch(/^pr=C-nocheck target=[0-9a-f]{40} base=[0-9a-f]{40} check=none$/)
    } finally {
      if (savedMerge !== undefined) process.env.BAY_MERGE_COMMAND = savedMerge
      if (savedCheck !== undefined) process.env.BAY_CHECK = savedCheck
    }
  })

  it("an inline mergeCommand still overrides the native default", async () => {
    // No mainRepo here — the point is which command RUNS (native vs
    // configured), not the ancestry guard (covered by its own describe block
    // above); a bare `echo` never lands anything, so pairing it with a real
    // ancestry check would always (correctly) reject as a lying merge.
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "echo {pr} {target}" })
    await seedChecked(bay, "task/x", "C-override")

    const { events } = await bay.dispatch({ type: "merge", args: { pr: "C-override" } })
    // the configured command's stdout is the detail, NOT the native "merged … onto …" shape
    expect(detailOf(events, "merged")).toBe("C-override task/x")
  })
})

describe("withMergeWorker — merge command spawn cwd", () => {
  // Both sides resolve through `pwd -P` so a symlinked tmpdir (macOS mounts
  // TMPDIR under /var, itself a symlink to /private/var) can't produce a
  // false negative — a spawned shell's plain `pwd` reports the canonicalized
  // path, which would not string-equal the pre-canonicalization JS value.
  async function makeCwdRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "gitbay-cwd-repo-"))
    const g = async (args: string[]) => {
      const res = await git(["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", ...args], repo)
      if (res.code !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${res.stderr}`)
      return res
    }
    await g(["init", "-q", "-b", "main"])
    await g(["commit", "-qm", "init", "--allow-empty"])
    return repo
  }

  it("runs the merge command with cwd set to mainRepo", async () => {
    const repo = await makeCwdRepo()
    const bay = await buildMergeBay(await tmpJournalPath(), {
      mergeCommand: `[ "$(pwd -P)" = "$(cd ${JSON.stringify(repo)} && pwd -P)" ]`,
      mainRepo: repo,
    })
    await seedChecked(bay, "main", "C-cwd")

    await bay.dispatch({ type: "merge", args: { pr: "C-cwd" } })
    // main is trivially an ancestor of itself, so a correct cwd lands merged;
    // a wrong cwd fails the test command (exit 1) and rejects instead.
    expect(stateOf(await bay.state(), "C-cwd")).toBe("merged")
  })

  it("falls back to process.cwd() when mainRepo is unset", async () => {
    const expectedCwd = process.cwd()
    const bay = await buildMergeBay(await tmpJournalPath(), {
      mergeCommand: `[ "$(pwd -P)" = "$(cd ${JSON.stringify(expectedCwd)} && pwd -P)" ]`,
    })
    await seedChecked(bay, "t", "C-cwd-fallback")

    await bay.dispatch({ type: "merge", args: { pr: "C-cwd-fallback" } })
    expect(stateOf(await bay.state(), "C-cwd-fallback")).toBe("merged")
  })
})

describe("withMergeWorker — integrate: the umbrella (submitted → … → merged, one dispatch)", () => {
  it("walks a submitted PR all the way to merged in ONE dispatch (check then merge)", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    await bay.dispatch({ type: "enqueue", args: { target: "task/x", pr: "C-x" } })

    const { events } = await bay.dispatch({ type: "integrate", args: { pr: "C-x" } })
    const transitions = events.filter((e) => e.name === "pr/changed").map((e) => `${e.data!.from}→${e.data!.to}`)
    expect(transitions).toEqual(["submitted→checking", "checking→checked", "checked→merging", "merging→merged"])
    expect(stateOf(await bay.state(), "C-x")).toBe("merged")
  })

  it("stops at rejected when the check fails — never reaches merging", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { check: "false", mergeCommand: "true" })
    await bay.dispatch({ type: "enqueue", args: { target: "task/y", pr: "C-y" } })

    const { events } = await bay.dispatch({ type: "integrate", args: { pr: "C-y" } })
    const transitions = events.filter((e) => e.name === "pr/changed").map((e) => `${e.data!.from}→${e.data!.to}`)
    expect(transitions).toEqual(["submitted→checking", "checking→rejected"])
    expect(stateOf(await bay.state(), "C-y")).toBe("rejected")
  })

  it("resumes a PR already `checked` — runs merge only, no re-check", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    await seedChecked(bay, "task/z", "C-z")

    const { events } = await bay.dispatch({ type: "integrate", args: { pr: "C-z" } })
    const transitions = events.filter((e) => e.name === "pr/changed").map((e) => `${e.data!.from}→${e.data!.to}`)
    expect(transitions).toEqual(["checked→merging", "merging→merged"])
    expect(stateOf(await bay.state(), "C-z")).toBe("merged")
  })

  it("refuses a PR that hasn't been submitted yet", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    await expect(bay.dispatch({ type: "integrate", args: { pr: "C-none" } })).rejects.toThrow(
      /integrate: no PR 'C-none'/,
    )
  })

  it("refuses a rejected PR, teaching retry", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { check: "false" })
    await bay.dispatch({ type: "enqueue", args: { target: "t", pr: "C-rej" } })
    await bay.dispatch({ type: "integrate", args: { pr: "C-rej" } }) // → rejected
    await expect(bay.dispatch({ type: "integrate", args: { pr: "C-rej" } })).rejects.toThrow(
      /integrate: C-rej was rejected — put it back in the queue first: git bay retry C-rej/,
    )
  })
})

describe("withMergeWorker — integrate: no-arg auto-pick (submitted + checked, FIFO)", () => {
  it("each no-arg integrate lands exactly the oldest submitted/checked PR", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    for (const t of ["A", "B", "C"]) {
      await bay.dispatch({ type: "enqueue", args: { target: t, pr: `C-${t}` } })
    }

    await bay.dispatch({ type: "integrate" })
    let s = await bay.state()
    expect(stateOf(s, "C-A")).toBe("merged")
    expect(integratablePrs(s).map((c) => c.id)).toEqual(["C-B", "C-C"]) // B, C still waiting, in order

    await bay.dispatch({ type: "integrate" })
    expect(stateOf(await bay.state(), "C-B")).toBe("merged")

    await bay.dispatch({ type: "integrate" })
    s = await bay.state()
    expect(stateOf(s, "C-C")).toBe("merged")
    expect(integratablePrs(s)).toEqual([])
  })

  it("is a non-event when nothing is submitted/checked — no marker event, just an empty events array", async () => {
    const bay = await buildMergeBay(await tmpJournalPath(), { mergeCommand: "true" })
    const { events } = await bay.dispatch({ type: "integrate" })
    expect(events).toEqual([])
    expect(Object.keys((await bay.state()).prs)).toEqual([])
  })
})

describe("withMergeWorker — no merge command configured and no mainRepo", () => {
  it("throws a loud error, and the checked→merging event stays durable", async () => {
    const saved = process.env.BAY_MERGE_COMMAND
    delete process.env.BAY_MERGE_COMMAND
    try {
      const path = await tmpJournalPath()
      const configCwd = await mkdtemp(join(tmpdir(), "gitbay-noconfig-")) // not a git repo → bay.mergeCommand unset
      const bay = await buildMergeBay(path, { configCwd })
      await seedChecked(bay, "t", "C-m")

      await expect(bay.dispatch({ type: "merge", args: { pr: "C-m" } })).rejects.toThrow(
        /no merge command configured and no mainRepo/,
      )
      // Journal-first: the checked→merging event was durable before the effect
      // ran and threw — so the PR is left `merging` (resumable), not lost.
      expect(stateOf(await bay.state(), "C-m")).toBe("merging")
    } finally {
      if (saved !== undefined) process.env.BAY_MERGE_COMMAND = saved
    }
  })
})

describe("withMergeWorker — resume-on-restart via replay + requeue", () => {
  it("a PR stuck in merging replays as merging and is resumed (requeue + integrate)", async () => {
    const saved = process.env.BAY_MERGE_COMMAND
    delete process.env.BAY_MERGE_COMMAND
    try {
      const path = await tmpJournalPath()
      const configCwd = await mkdtemp(join(tmpdir(), "gitbay-noconfig-"))

      // Run 1: get C-s to `checked`, then merge with no command and no
      // mainRepo → throws mid-effect, leaving it durable in `merging`.
      const bay1 = await buildMergeBay(path, { configCwd })
      await seedChecked(bay1, "task/s", "C-s")
      await expect(bay1.dispatch({ type: "merge", args: { pr: "C-s" } })).rejects.toThrow(
        /no merge command configured and no mainRepo/,
      )

      // Run 2 (restart): fresh bay over the SAME journal with a working command.
      // Replay reconstructs C-s in `merging` WITHOUT re-running any effect.
      const bay2 = await buildMergeBay(path, { mergeCommand: "true" })
      expect(stateOf(await bay2.state(), "C-s")).toBe("merging")

      // requeue resumes it (merging → submitted, restarting the WHOLE
      // pipeline — a half-landed merge is not trusted); integrate re-runs
      // check (unconfigured, auto-passes) then merge.
      await bay2.dispatch({ type: "requeue", args: { pr: "C-s" } })
      expect(stateOf(await bay2.state(), "C-s")).toBe("submitted")
      await bay2.dispatch({ type: "integrate", args: { pr: "C-s" } })
      expect(stateOf(await bay2.state(), "C-s")).toBe("merged")
    } finally {
      if (saved !== undefined) process.env.BAY_MERGE_COMMAND = saved
    }
  })
})

describe("runMerge — LE-2: the lying-merge guard verifies against a FRESH mainline (21002)", () => {
  const IDENT = ["-c", "user.name=t", "-c", "user.email=t@e"]

  async function must(args: string[], cwd: string): Promise<string> {
    const res = await git(args, cwd)
    if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr}`)
    return res.stdout.trim()
  }

  /** bare origin (main @ S0, task/x @ X) + two clones: A is the caller's
   *  mainRepo with a STALE origin/main; B is the "separate clean clone" the
   *  merge command lands + pushes from — the hh integrator shape (20969). */
  async function makeStaleFixture(): Promise<{ cloneA: string; cloneB: string }> {
    const root = await mkdtemp(join(tmpdir(), "gitbay-le2-"))
    const origin = join(root, "origin.git")
    await must(["init", "-q", "--bare", "-b", "main", origin], root)
    const seed = join(root, "seed")
    await must(["clone", "-q", origin, seed], root)
    await must(["-C", seed, ...IDENT, "commit", "-qm", "S0", "--allow-empty"], seed)
    await must(["-C", seed, "push", "-q", "origin", "main"], seed)
    await must(["-C", seed, "switch", "-qc", "task/x"], seed)
    await must(["-C", seed, ...IDENT, "commit", "-qm", "X", "--allow-empty"], seed)
    await must(["-C", seed, "push", "-q", "origin", "task/x"], seed)
    const cloneA = join(root, "cloneA")
    const cloneB = join(root, "cloneB")
    await must(["clone", "-q", origin, cloneA], root)
    await must(["clone", "-q", origin, cloneB], root)
    return { cloneA, cloneB }
  }

  it("accepts a REAL landing made from a separate clone (stale tracking ref would have false-rejected)", async () => {
    const { cloneA, cloneB } = await makeStaleFixture()
    // The merge command lands task/x onto main in clone B and pushes — clone
    // A's refs/remotes/origin/main knows nothing about it until a fetch.
    const cmd = `git -C ${cloneB} -c user.name=t -c user.email=t@e merge --no-ff -q -m landed origin/task/x && git -C ${cloneB} push -q origin main && echo "merged $(git -C ${cloneB} rev-parse HEAD) onto main"`
    const outcome = await runMerge({ mainRepo: cloneA, pr: "PR3", target: "origin/task/x", mergeCommand: cmd })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.detail).toContain("merged")
  })

  it("fails LOUD when the mainline cannot be fetched — never judges against a possibly-stale ref", async () => {
    const { cloneA } = await makeStaleFixture()
    await must(["-C", cloneA, "remote", "set-url", "origin", join(cloneA, "does-not-exist.git")], cloneA)
    await expect(
      runMerge({ mainRepo: cloneA, pr: "PR3", target: "origin/task/x", mergeCommand: "true" }),
    ).rejects.toThrow(/fetch origin main.*failed|refuses to verify/s)
  })
})
