/**
 * @failure  Every round re-read each ended change one record at a time: with-notify's repair pass cost one
 *           `log -1` and one `log --first-parent` per change, 847 to 1,152 pairs a round on the garage, 4 to
 *           10 s of silence in the compose window (@i/10-yrd/25303 f1, receipt f/01-measure.log). The queue
 *           read already held every change's tip; its one record log now reads each whole chain and primes
 *           the readers.
 * @level    l2 (a real remote, real submits and real records, read by the real queue read)
 * @consumer every per-change record reader in a round (with-notify's resend and told, endings, withdraw)
 */

import childProcess from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
  appendRecord,
  changeRef,
  gitIn,
  readQueue,
  readRecord,
  readRecords,
  selectionFor,
  submit,
  tipOf,
  type Git,
} from "../src/index.ts"
import { primeLegacyHistory } from "../src/legacy-records.ts"
import type { CommitMeta } from "gitomic"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

type Fixture = Readonly<{
  git: Git
  target: string
  branchHeads: readonly string[]
  /** Per change: the failed record's sha and the sent record on top of it. */
  chains: readonly Readonly<{ branch: string; head: string; failed: string; sent: string }>[]
}>

/** Three submitted changes, each extended to opened → failed → sent and pushed, as a round leaves them. */
async function queueWithChains(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-record-prime-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "declare the queue"])
  await git(["commit", "--quiet", "--allow-empty", "-m", "the target moves on"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const chains: { branch: string; head: string; failed: string; sent: string }[] = []
  for (const name of ["task/one", "task/two", "task/three"]) {
    await git(["checkout", "--quiet", "-b", name, "main"])
    writeFileSync(join(work, `${name.replace("/", "-")}.txt`), `${name}\n`)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", name])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    await git(["push", "--quiet", "origin", `${head}:refs/heads/${name}`])
    await submit(git, "origin", { branch: name, submitter: "@dev/1", target: { branch: "main", remote: "origin" } })
    const change = { branch: name, head }
    // Gitomic's remote publication leaves application refs local only after an explicit fetch.
    const ref = changeRef("main", change)
    await git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `${ref}:${ref}`])
    const failed = await appendRecord(git, "main", {
      change,
      kind: "failed",
      subject: `${name} failed`,
      trailers: [["Reason", "conflict"]],
    })
    const sent = await appendRecord(git, "main", {
      change,
      kind: "sent",
      subject: `${name} told`,
      trailers: [
        ["For", failed],
        ["To", "submitter"],
        ["Delivery", "sent"],
        ["State", "failed"],
      ],
    })
    chains.push({ branch: name, head, failed, sent })
  }
  await git(["push", "--quiet", "origin", "refs/yrd/main/*:refs/yrd/main/*"])
  return { git, target, branchHeads: chains.map(({ head }) => head), chains }
}

/** A Git that records every invocation through the queue's existing runner. */
function counting(git: Git): Readonly<{ git: Git; calls: string[][] }> {
  const calls: string[][] = []
  const counted: Git = Object.assign(
    async (args: readonly string[], input?: string) => {
      calls.push([...args])
      return git(args, input)
    },
    { selection: selectionFor(git) },
  )
  return { git: counted, calls }
}

describe("the queue read's Gitomic history primes every per-change reader (25303 f1)", () => {
  it("answers N changes' record reads with no process after the one history batch", async () => {
    const fixture = await queueWithChains()
    const { git, calls } = counting(fixture.git)
    const spawn = vi.spyOn(childProcess, "spawn")

    const read = await readQueue(git, "origin", "main", fixture.target)
    const historyReads = spawn.mock.calls.filter(([, args]) => (args as string[]).includes("rev-list"))
    expect(historyReads).toHaveLength(1)
    expect(historyReads[0]?.[1]).toContain("--first-parent")

    calls.length = 0
    spawn.mockClear()
    for (const { failed, sent } of fixture.chains) {
      await readRecord(git, sent)
      await readRecord(git, failed)
      await readRecords(git, sent)
      await readRecords(git, `${failed}..${sent}`)
    }
    expect(read.changes).toHaveLength(3)
    expect(calls).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it("answers exactly as the unprimed readers do, record for record", async () => {
    const fixture = await queueWithChains()
    const { git } = counting(fixture.git)
    await readQueue(git, "origin", "main", fixture.target)
    // A different Git instance holds no prime: it reads the way every reader did before.
    const unprimed: Git = Object.assign((args: readonly string[], input?: string) => fixture.git(args, input), {
      selection: selectionFor(fixture.git),
    })

    for (const { failed, sent } of fixture.chains) {
      expect(await readRecord(git, sent)).toEqual(await readRecord(unprimed, sent))
      expect(await readRecord(git, failed)).toEqual(await readRecord(unprimed, failed))
      const whole = await readRecords(git, sent)
      expect(whole.map(({ kind }) => kind)).toEqual(["opened", "failed", "sent"])
      expect(whole).toEqual(await readRecords(unprimed, sent))
      expect(await readRecords(git, `${failed}..${sent}`)).toEqual(await readRecords(unprimed, `${failed}..${sent}`))
    }
  })

  it("keeps the queue read's own tip records exactly as the tip-only read gave them", async () => {
    const fixture = await queueWithChains()
    const read = await readQueue(fixture.git, "origin", "main", fixture.target)
    const unprimed: Git = Object.assign((args: readonly string[], input?: string) => fixture.git(args, input), {
      selection: selectionFor(fixture.git),
    })

    const tips = read.changes.map((entry) => tipOf(entry.change))
    expect(tips.map(({ sha }) => sha).sort()).toEqual(fixture.chains.map(({ sent }) => sent).sort())
    for (const tip of tips) expect(tip).toEqual(await readRecord(unprimed, tip.sha))
  })

  it("batches only captured record tips, never the target or a change head", async () => {
    const fixture = await queueWithChains()
    const { git } = counting(fixture.git)
    const spawn = vi.spyOn(childProcess, "spawn")
    await readQueue(git, "origin", "main", fixture.target)

    const histories = spawn.mock.calls
      .filter(([, args]) => (args as string[]).includes("rev-list"))
      .map(([, args]) => args as string[])
    expect(histories).toHaveLength(1)
    expect(histories[0]).toEqual(expect.arrayContaining(fixture.chains.map(({ sent }) => sent)))
    expect(histories[0]).not.toContain(fixture.target)
    for (const head of fixture.branchHeads) expect(histories[0]).not.toContain(head)
  })

  it("reads a record written after the prime through Gitomic and names the miss", async () => {
    const fixture = await queueWithChains()
    const { git, calls } = counting(fixture.git)
    await readQueue(git, "origin", "main", fixture.target)
    const first = fixture.chains[0]
    if (first === undefined) throw new Error("fixture has no chain")
    const later = await appendRecord(fixture.git, "main", {
      change: { branch: first.branch, head: first.head },
      kind: "sent",
      subject: "told again",
      trailers: [
        ["For", first.failed],
        ["To", "submitter"],
        ["Delivery", "sent"],
        ["State", "failed"],
      ],
    })
    vi.stubEnv("DEBUG", "yrd*")
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)

    calls.length = 0
    const record = await readRecord(git, later)

    expect(record.sha).toBe(later)
    expect(calls).toEqual([["rev-parse", "--absolute-git-dir"]])
    expect(stderr).toHaveBeenCalledWith(`DEBUG yrd:queue:records record cache miss: readRecord ${later}`)
  })

  it("warns with the numbers when one prime passes ten times the garage's measured size", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const row = (index: number) => ({ oid: index.toString(16).padStart(40, "0"), message: "x\n" }) as CommitMeta
    const history = Array.from({ length: 75_001 }, (_, index) => row(index + 1))
    const git: Git = async () => ""

    primeLegacyHistory(git, history)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("read 75001 commits"))
  })
})
