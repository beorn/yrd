import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createGitbay,
  createJsonlJournal,
  pipe,
  submittedPrs,
  withBatchBuild,
  withMergeWorker,
  withQueue,
} from "../src/index.ts"
import type { BayEvent, BayRuntime, BayState, BayStore, PrId } from "../src/index.ts"
import { git } from "../src/layers/git.ts"

const CLOCK = () => "2024-01-01T00:00:00.000Z"
const ACTOR = "tester"
const IDENT = ["-c", "user.name=t", "-c", "user.email=t@e"]
const dirs: string[] = []

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function must(args: string[], cwd: string): Promise<string> {
  const res = await git(args, cwd)
  if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr}`)
  return res.stdout.trim()
}

function openStore(path: string): BayStore {
  return { journal: createJsonlJournal(path), close: async () => {} }
}

async function tmpJournalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitbay-batch-journal-"))
  dirs.push(dir)
  return join(dir, "journal.jsonl")
}

async function buildBatchBay(
  repo: string,
  path?: string,
  mergeCommand?: string,
  batchOpts?: { provisionCommand?: string },
): Promise<BayRuntime> {
  const journalPath = path ?? (await tmpJournalPath())
  return pipe(
    createGitbay({ store: openStore(journalPath), clock: CLOCK, actor: ACTOR }),
    withQueue(),
    withBatchBuild({ mainRepo: repo, generatedGlobs: [], ...batchOpts }),
    withMergeWorker({
      mainRepo: repo,
      mergeCommand: mergeCommand ?? `git -c user.name=t -c user.email=t@e merge --no-ff -q {target}`,
    }),
  )
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "gitbay-batch-repo-"))
  dirs.push(repo)
  await must(["-C", repo, "init", "-q", "-b", "main"], repo)
  await writeFile(join(repo, "README"), "base\n")
  await must(["-C", repo, "add", "-A"], repo)
  await must(["-C", repo, ...IDENT, "commit", "-q", "-m", "base"], repo)
  return repo
}

async function branch(repo: string, name: string, files: Record<string, string>): Promise<void> {
  await must(["-C", repo, "switch", "-qc", name, "main"], repo)
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body)
  }
  await must(["-C", repo, "add", "-A"], repo)
  await must(["-C", repo, ...IDENT, "commit", "-q", "-m", name], repo)
  await must(["-C", repo, "switch", "-q", "main"], repo)
}

function stateOf(state: BayState, id: PrId): string {
  return state.prs[id]!.state
}

function eventsOf(events: BayEvent[], type: string): BayEvent[] {
  return events.filter((e) => e.name === type)
}

function queueTarget(state: BayState, pr: PrId): string {
  const slice = state.slices.queue as { targets: Record<PrId, string> }
  return slice.targets[pr]!
}

describe("withBatchBuild — scratch candidate for the existing serial drain", () => {
  it("builds one candidate branch with one ordinary merge commit per member and queues it ahead of skipped work", async () => {
    const repo = await makeRepo()
    await branch(repo, "task/a", { "a.ts": "a\n" })
    await branch(repo, "task/b", { "b.ts": "b\n" })
    await branch(repo, "task/collides", { "a.ts": "later\n" })

    const bay = await buildBatchBay(repo)
    await bay.dispatch({ type: "enqueue", args: { target: "task/a", pr: "PR1" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/b", pr: "PR2" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/collides", pr: "PR3" } })

    const { events } = await bay.dispatch({ type: "batch-build" })

    expect(eventsOf(events, "line/batch/started")).toHaveLength(1)
    expect(eventsOf(events, "line/batch/isolated")).toEqual([])

    const state = await bay.state()
    expect(stateOf(state, "PR1")).toBe("checking")
    expect(stateOf(state, "PR2")).toBe("checking")
    expect(stateOf(state, "PR3")).toBe("submitted")
    expect(submittedPrs(state).map((pr) => pr.id)).toEqual(["PR4", "PR3"])

    const candidate = queueTarget(state, "PR4")
    expect(candidate).toBe("bay/batch/PR4")
    const subjects = await must(["-C", repo, "log", "--first-parent", "--format=%s", `main..${candidate}`], repo)
    expect(subjects.split("\n")).toEqual(["bay: batch PR4 member PR2", "bay: batch PR4 member PR1"])

    await bay.dispatch({ type: "integrate" })
    const drained = await bay.state()
    expect(stateOf(drained, "PR4")).toBe("merged")
    expect(stateOf(drained, "PR1")).toBe("merged")
    expect(stateOf(drained, "PR2")).toBe("merged")
    expect(submittedPrs(drained).map((pr) => pr.id)).toEqual(["PR3"])
  })

  it("ejects a build-conflict member with a teaching detail and rebuilds the candidate without it", async () => {
    const repo = await makeRepo()
    await branch(repo, "task/file", { dir: "file blocks directory\n" })
    await branch(repo, "task/nested", { "dir/file.ts": "nested file\n" })

    const bay = await buildBatchBay(repo)
    await bay.dispatch({ type: "enqueue", args: { target: "task/file", pr: "PR1" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/nested", pr: "PR2" } })

    const { events } = await bay.dispatch({ type: "batch-build" })

    const ejected = eventsOf(events, "line/batch/isolated")
    expect(ejected).toHaveLength(1)
    expect(ejected[0]!.data).toMatchObject({
      batch: "PR3",
      outcome: "ejected",
      reason: "build-conflict",
      pr: "PR2",
      target: "task/nested",
    })
    expect(String(ejected[0]!.data!.detail)).toContain("ejected from batch PR3")
    expect(String(ejected[0]!.data!.detail)).toContain("Fix and retry: git bay retry PR2")

    const state = await bay.state()
    expect(stateOf(state, "PR1")).toBe("checking")
    expect(stateOf(state, "PR2")).toBe("rejected")
    expect(submittedPrs(state).map((pr) => pr.id)).toEqual(["PR3"])

    const candidate = queueTarget(state, "PR3")
    const subjects = await must(["-C", repo, "log", "--first-parent", "--format=%s", `main..${candidate}`], repo)
    expect(subjects.split("\n")).toEqual(["bay: batch PR3 member PR1"])
  })

  it("bisects a red batch gate to the first bad prefix and queues a rebuilt clean remainder", async () => {
    const repo = await makeRepo()
    await branch(repo, "task/good-a", { "a.ts": "a\n" })
    await branch(repo, "task/bad", { "bad.txt": "breaks the batch\n" })
    await branch(repo, "task/good-c", { "c.ts": "c\n" })

    const bay = await buildBatchBay(repo, undefined, "false")
    await bay.dispatch({ type: "enqueue", args: { target: "task/good-a", pr: "PR1" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/bad", pr: "PR2" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/good-c", pr: "PR3" } })

    await bay.dispatch({ type: "batch-build" })
    await bay.dispatch({ type: "integrate", args: { pr: "PR4" } })

    const red = await bay.state()
    expect(stateOf(red, "PR4")).toBe("rejected")
    expect(stateOf(red, "PR1")).toBe("checking")
    expect(stateOf(red, "PR2")).toBe("checking")
    expect(stateOf(red, "PR3")).toBe("checking")

    const { events } = await bay.dispatch({
      type: "batch-bisect",
      args: {
        pr: "PR4",
        gateCommand: "test ! -f bad.txt",
      },
    })

    // The bisect walk is line/step pairs: the baseline first (role "baseline",
    // no pr — it gates the untouched batch base), then each prefix until red.
    expect(eventsOf(events, "line/step/finished").map((e) => e.data)).toMatchObject([
      { step: "check", batch: "PR4", target: "HEAD", role: "baseline", ok: true },
      { batch: "PR4", pr: "PR1", target: "bay/batch-prefix/PR4/1-PR1", role: "prefix", ok: true },
      {
        batch: "PR4",
        pr: "PR2",
        target: "bay/batch-prefix/PR4/2-PR2",
        role: "prefix",
        ok: false,
        error: { code: "check-failed", exitCode: 1 },
      },
    ])
    const ejected = eventsOf(events, "line/batch/isolated")
    expect(ejected).toHaveLength(1)
    expect(ejected[0]!.data).toMatchObject({
      batch: "PR4",
      outcome: "ejected",
      reason: "gate-red",
      pr: "PR2",
      target: "task/bad",
    })
    expect(String(ejected[0]!.data!.detail)).toContain("first red batch prefix")

    const rebuilt = eventsOf(events, "line/batch/started")
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0]!.data).toMatchObject({
      batch: "PR5",
      target: "bay/batch/PR5",
      sourceBatch: "PR4",
      members: [
        { pr: "PR1", target: "task/good-a" },
        { pr: "PR3", target: "task/good-c" },
      ],
    })

    const state = await bay.state()
    expect(stateOf(state, "PR1")).toBe("checking")
    expect(stateOf(state, "PR2")).toBe("rejected")
    expect(stateOf(state, "PR3")).toBe("checking")
    expect(submittedPrs(state).map((pr) => pr.id)).toEqual(["PR5"])

    const candidate = queueTarget(state, "PR5")
    const subjects = await must(["-C", repo, "log", "--first-parent", "--format=%s", `main..${candidate}`], repo)
    expect(subjects.split("\n")).toEqual(["bay: batch PR5 member PR3", "bay: batch PR5 member PR1"])
  })

  it("journals a bisect-refused verdict when the per-prefix gate lies green — walk evidence kept, nobody ejected", async () => {
    const repo = await makeRepo()
    await branch(repo, "task/a", { "a.ts": "a\n" })
    await branch(repo, "task/b", { "b.ts": "b\n" })

    const bay = await buildBatchBay(repo, undefined, "false")
    await bay.dispatch({ type: "enqueue", args: { target: "task/a", pr: "PR1" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/b", pr: "PR2" } })
    await bay.dispatch({ type: "batch-build" })
    await bay.dispatch({ type: "integrate", args: { pr: "PR3" } })

    const { events } = await bay.dispatch({
      type: "batch-bisect",
      args: { pr: "PR3", gateCommand: "true" },
    })

    // The per-prefix walk stays durable — this evidence used to be discarded
    // by a throw. Finished rows: baseline + both prefixes, all green.
    const finished = eventsOf(events, "line/step/finished").map((e) => e.data)
    expect(finished.filter((d) => d!.role === "prefix")).toHaveLength(2)
    const refused = eventsOf(events, "line/batch/isolated")
    expect(refused).toHaveLength(1)
    expect(refused[0]!.data).toMatchObject({ batch: "PR3", outcome: "refused", reason: "all-green" })
    expect(String(refused[0]!.data!.detail)).toContain("per-member gate is lying")

    const state = await bay.state()
    expect(state.prs.PR4).toBeUndefined()
    expect(stateOf(state, "PR1")).toBe("checking")
    expect(stateOf(state, "PR2")).toBe("checking")
  })

  it("refuses bisect with a journaled baseline verdict when the gate is red on the batch base itself", async () => {
    const repo = await makeRepo()
    await branch(repo, "task/a", { "a.ts": "a\n" })
    await branch(repo, "task/b", { "b.ts": "b\n" })

    const bay = await buildBatchBay(repo, undefined, "false")
    await bay.dispatch({ type: "enqueue", args: { target: "task/a", pr: "PR1" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/b", pr: "PR2" } })
    await bay.dispatch({ type: "batch-build" })
    await bay.dispatch({ type: "integrate", args: { pr: "PR3" } })

    // A gate that is red EVERYWHERE — including on the untouched batch base —
    // is an environment/mainline fault. Nobody gets ejected for it.
    const { events } = await bay.dispatch({
      type: "batch-bisect",
      args: { pr: "PR3", gateCommand: "false" },
    })

    const refused = eventsOf(events, "line/batch/isolated")
    expect(refused).toHaveLength(1)
    expect(refused[0]!.data).toMatchObject({ batch: "PR3", outcome: "refused", reason: "baseline-red" })
    expect(String(refused[0]!.data!.detail)).toContain("git bay retry PR3")
    // The prefix walk never started — only the baseline pair was journaled.
    const finished = eventsOf(events, "line/step/finished").map((e) => e.data)
    expect(finished.filter((d) => d!.role === "prefix")).toEqual([])
    expect(finished.filter((d) => d!.role === "baseline")).toHaveLength(1)

    const state = await bay.state()
    expect(state.prs.PR4).toBeUndefined()
    expect(stateOf(state, "PR1")).toBe("checking")
    expect(stateOf(state, "PR2")).toBe("checking")
  })

  it("runs the provision command in every gate scratch before the gate", async () => {
    const repo = await makeRepo()
    await branch(repo, "task/good-a", { "a.ts": "a\n" })
    await branch(repo, "task/bad", { "bad.txt": "breaks the batch\n" })
    await branch(repo, "task/good-c", { "c.ts": "c\n" })

    const bay = await buildBatchBay(repo, undefined, "false", { provisionCommand: "touch provisioned.marker" })
    await bay.dispatch({ type: "enqueue", args: { target: "task/good-a", pr: "PR1" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/bad", pr: "PR2" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/good-c", pr: "PR3" } })
    await bay.dispatch({ type: "batch-build" })
    await bay.dispatch({ type: "integrate", args: { pr: "PR4" } })

    // The gate depends on the provision marker: without provisioning it would
    // be red on the baseline and every prefix (env-fault refusal), so a correct
    // ejection of task/bad proves provisioning ran in each scratch.
    const { events } = await bay.dispatch({
      type: "batch-bisect",
      args: { pr: "PR4", gateCommand: "test -f provisioned.marker && test ! -f bad.txt" },
    })

    const isolated = eventsOf(events, "line/batch/isolated")
    expect(isolated).toHaveLength(1)
    expect(isolated[0]!.data).toMatchObject({ batch: "PR4", outcome: "ejected", reason: "gate-red", pr: "PR2" })
    expect(eventsOf(events, "line/batch/started")).toHaveLength(1)
  })

  it("classifies a failing provision command as an infrastructure fault, never a member ejection", async () => {
    const repo = await makeRepo()
    await branch(repo, "task/a", { "a.ts": "a\n" })
    await branch(repo, "task/b", { "b.ts": "b\n" })

    const bay = await buildBatchBay(repo, undefined, "false", {
      provisionCommand: "echo provision boom >&2; exit 7",
    })
    await bay.dispatch({ type: "enqueue", args: { target: "task/a", pr: "PR1" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/b", pr: "PR2" } })
    await bay.dispatch({ type: "batch-build" })
    await bay.dispatch({ type: "integrate", args: { pr: "PR3" } })

    const { events } = await bay.dispatch({
      type: "batch-bisect",
      args: { pr: "PR3", gateCommand: "true" },
    })

    const refused = eventsOf(events, "line/batch/isolated")
    expect(refused).toHaveLength(1)
    expect(refused[0]!.data).toMatchObject({ batch: "PR3", outcome: "refused", reason: "provision-failed" })
    expect(String(refused[0]!.data!.detail)).toContain("exit 7")

    const state = await bay.state()
    expect(stateOf(state, "PR1")).toBe("checking")
    expect(stateOf(state, "PR2")).toBe("checking")
  })
})

describe("withBatchBuild — per-member journal truth when the candidate lands (LE-5)", () => {
  it("journals per-member merged events with compose-time member tips, plus one line/batch/finished", async () => {
    const repo = await makeRepo()
    await branch(repo, "task/a", { "a.ts": "a\n" })
    await branch(repo, "task/b", { "b.ts": "b\n" })
    const tipA = await must(["-C", repo, "rev-parse", "task/a"], repo)
    const tipB = await must(["-C", repo, "rev-parse", "task/b"], repo)

    const journalPath = await tmpJournalPath()
    const bay = await buildBatchBay(repo, journalPath)
    await bay.dispatch({ type: "enqueue", args: { target: "task/a", pr: "PR1" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/b", pr: "PR2" } })
    await bay.dispatch({ type: "batch-build" })

    const { events } = await bay.dispatch({ type: "integrate", args: { pr: "PR3" } })

    const memberMerged = events.filter(
      (e) => e.name === "pr/changed" && e.data!.to === "merged" && e.data!.pr !== "PR3",
    )
    expect(memberMerged.map((e) => e.data)).toMatchObject([
      { pr: "PR1", from: "checking", to: "merged", sha: tipA },
      { pr: "PR2", from: "checking", to: "merged", sha: tipB },
    ])
    expect(String(memberMerged[0]!.data!.detail)).toContain("batch PR3")

    const settled = eventsOf(events, "line/batch/finished")
    expect(settled).toHaveLength(1)
    expect(settled[0]!.data).toMatchObject({
      batch: "PR3",
      members: [
        { pr: "PR1", target: "task/a", tip: tipA },
        { pr: "PR2", target: "task/b", tip: tipB },
      ],
    })

    // The journal itself carries the member outcomes — replay consumers
    // (bay-stats) must not need the batch layer's fold to infer them.
    const journaled: BayEvent[] = []
    for await (const evt of createJsonlJournal(journalPath).replay()) journaled.push(evt)
    const journaledMemberMerged = journaled.filter(
      (e) => e.name === "pr/changed" && e.data!.to === "merged" && e.data!.pr !== "PR3",
    )
    expect(journaledMemberMerged.map((e) => e.data!.pr)).toEqual(["PR1", "PR2"])

    // Settle is idempotent: the recovery verb finds nothing left to do.
    const again = await bay.dispatch({ type: "batch-settle", args: { pr: "PR3" } })
    expect(again.events).toEqual([])

    const state = await bay.state()
    expect(stateOf(state, "PR1")).toBe("merged")
    expect(stateOf(state, "PR2")).toBe("merged")
    expect(stateOf(state, "PR3")).toBe("merged")
  })
})

describe("withBatchBuild — Bay-Gate trailer on a native candidate landing (main-mover audit evidence)", () => {
  it("names the batch id, member count, and ejected members on the main-moving merge commit", async () => {
    const savedMerge = process.env.BAY_MERGE_COMMAND
    const savedCheck = process.env.BAY_CHECK
    delete process.env.BAY_MERGE_COMMAND
    delete process.env.BAY_CHECK
    try {
      const repo = await makeRepo()
      await branch(repo, "task/a", { "a.ts": "a\n" })
      await branch(repo, "task/b", { dir: "file blocks directory\n" })
      await branch(repo, "task/c", { "dir/file.ts": "nested file\n" }) // file-blocks-directory merge conflict → ejected at build

      // NATIVE landing: no mergeCommand anywhere, so runMerge authors the
      // main-moving commit itself and must make it self-evidencing.
      const bay = pipe(
        createGitbay({ store: openStore(await tmpJournalPath()), clock: CLOCK, actor: ACTOR }),
        withQueue(),
        withBatchBuild({ mainRepo: repo, generatedGlobs: [] }),
        withMergeWorker({ mainRepo: repo }),
      )
      await bay.dispatch({ type: "enqueue", args: { target: "task/a", pr: "PR1" } })
      await bay.dispatch({ type: "enqueue", args: { target: "task/b", pr: "PR2" } })
      await bay.dispatch({ type: "enqueue", args: { target: "task/c", pr: "PR3" } })
      await bay.dispatch({ type: "batch-build" })

      const base = await must(["-C", repo, "rev-parse", "main"], repo)
      const candidate = await must(["-C", repo, "rev-parse", "bay/batch/PR4"], repo)
      await bay.dispatch({ type: "integrate", args: { pr: "PR4" } })

      const trailer = await must(
        ["-C", repo, "log", "-1", "--format=%(trailers:key=Bay-Gate,valueonly=true)", "main"],
        repo,
      )
      expect(trailer).toBe(`pr=PR4 target=${candidate} base=${base} batch=PR4 members=2 ejected=PR3 check=none`)
      // Verifiable from the graph alone: base is the merge's first parent,
      // the candidate its second.
      expect(await must(["-C", repo, "rev-parse", "main^1"], repo)).toBe(base)
      expect(await must(["-C", repo, "rev-parse", "main^2"], repo)).toBe(candidate)
    } finally {
      if (savedMerge !== undefined) process.env.BAY_MERGE_COMMAND = savedMerge
      if (savedCheck !== undefined) process.env.BAY_CHECK = savedCheck
    }
  })
})
