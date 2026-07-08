import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createBay,
  createJsonlJournal,
  pipe,
  queuedPrs,
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

async function buildBatchBay(repo: string, path?: string): Promise<BayRuntime> {
  const journalPath = path ?? (await tmpJournalPath())
  return pipe(
    createBay({ store: openStore(journalPath), clock: CLOCK, actor: ACTOR }),
    withQueue(),
    withBatchBuild({ mainRepo: repo, generatedGlobs: [] }),
    withMergeWorker({
      mainRepo: repo,
      mergeCommand: `git -c user.name=t -c user.email=t@e merge --no-ff -q {target}`,
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
  return events.filter((e) => e.type === type)
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

    expect(eventsOf(events, "batch.composed")).toHaveLength(1)
    expect(eventsOf(events, "batch.built")).toHaveLength(1)
    expect(eventsOf(events, "batch.member.ejected")).toEqual([])

    const state = await bay.state()
    expect(stateOf(state, "PR1")).toBe("merging")
    expect(stateOf(state, "PR2")).toBe("merging")
    expect(stateOf(state, "PR3")).toBe("queued")
    expect(queuedPrs(state).map((pr) => pr.id)).toEqual(["PR4", "PR3"])

    const candidate = queueTarget(state, "PR4")
    expect(candidate).toBe("bay/batch/PR4")
    const subjects = await must(["-C", repo, "log", "--first-parent", "--format=%s", `main..${candidate}`], repo)
    expect(subjects.split("\n")).toEqual(["bay: batch PR4 member PR2", "bay: batch PR4 member PR1"])

    await bay.dispatch({ type: "drain" })
    const drained = await bay.state()
    expect(stateOf(drained, "PR4")).toBe("merged")
    expect(stateOf(drained, "PR1")).toBe("merged")
    expect(stateOf(drained, "PR2")).toBe("merged")
    expect(queuedPrs(drained).map((pr) => pr.id)).toEqual(["PR3"])
  })

  it("ejects a build-conflict member with a teaching detail and rebuilds the candidate without it", async () => {
    const repo = await makeRepo()
    await branch(repo, "task/file", { "dir": "file blocks directory\n" })
    await branch(repo, "task/nested", { "dir/file.ts": "nested file\n" })

    const bay = await buildBatchBay(repo)
    await bay.dispatch({ type: "enqueue", args: { target: "task/file", pr: "PR1" } })
    await bay.dispatch({ type: "enqueue", args: { target: "task/nested", pr: "PR2" } })

    const { events } = await bay.dispatch({ type: "batch-build" })

    const ejected = eventsOf(events, "batch.member.ejected")
    expect(ejected).toHaveLength(1)
    expect(ejected[0]!.data).toMatchObject({ batch: "PR3", pr: "PR2", target: "task/nested" })
    expect(String(ejected[0]!.data!.detail)).toContain("ejected from batch PR3")
    expect(String(ejected[0]!.data!.detail)).toContain("Fix and retry: git bay retry PR2")

    const state = await bay.state()
    expect(stateOf(state, "PR1")).toBe("merging")
    expect(stateOf(state, "PR2")).toBe("rejected")
    expect(queuedPrs(state).map((pr) => pr.id)).toEqual(["PR3"])

    const candidate = queueTarget(state, "PR3")
    const subjects = await must(["-C", repo, "log", "--first-parent", "--format=%s", `main..${candidate}`], repo)
    expect(subjects.split("\n")).toEqual(["bay: batch PR3 member PR1"])
  })
})
