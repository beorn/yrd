/**
 * @failure A queue run made around the queue in the garage is indistinguishable in its
 *          own log from one the service made, so nobody reading a log later can
 *          tell which rounds were the mechanic's.
 * @level   l3
 * @consumer the mechanic's garage ledger · anyone reading a queue run's JSONL
 *           log after writing the record
 *
 * Black box, on the M1 harness: a real repository, a fake check, one
 * `yrd queue run` — one round, around the queue, which is the round a garage is for. The
 * garage is written with plain git, because it is a ref and nothing of yrd's
 * has to exist for it to be true.
 */
import { readFile } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import {
  boundaryRepository,
  git,
  type QueueRunResult,
  queueRunOnce,
  removeTemporaryRoots,
  submitOneCommit,
} from "./fixture.ts"

afterEach(removeTemporaryRoots)

/** Put the repository in the garage, the way the ref says it. */
async function openGarage(repo: string, reason: string): Promise<void> {
  const tree = await git(repo, "mktree")
  const commit = await git(repo, "commit-tree", tree, "-m", `garage: ${reason}\n\nOpened-By: @cto\n`)
  await git(repo, "update-ref", "refs/yrd/garage", commit)
}

/** The queue run's own `run` record, from the log it named. */
async function runRecordOf(run: QueueRunResult): Promise<Readonly<Record<string, unknown>>> {
  const reported = (JSON.parse(run.stdout) as { log?: unknown }).log
  if (typeof reported !== "string" || reported === "") {
    throw new Error(`the queue run named no log\n${run.report}`)
  }
  const records = (await readFile(reported, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>)
  const record = records.find((candidate) => candidate["kind"] === "run")
  if (record === undefined) throw new Error(`the queue run's log has no run record\n${run.report}`)
  return record
}

describe("a queue run says whether it came from the garage", () => {
  it("carries the reason on its result and on its run record", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    await submitOneCommit(repo, "garage1")
    await openGarage(repo, "rebuilding the core")

    const run = await queueRunOnce(repo)

    expect(JSON.parse(run.stdout), run.report).toMatchObject({ garage: "rebuilding the core" })
    expect(await runRecordOf(run), run.report).toMatchObject({ kind: "run", garage: "rebuilding the core" })
  })

  it("carries no garage field when no garage is open", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    await submitOneCommit(repo, "garage2")

    const run = await queueRunOnce(repo)

    expect(JSON.parse(run.stdout) as Readonly<Record<string, unknown>>, run.report).not.toHaveProperty("garage")
    expect(await runRecordOf(run), run.report).not.toHaveProperty("garage")
  })
})
