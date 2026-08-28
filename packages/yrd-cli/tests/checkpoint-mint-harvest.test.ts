/**
 * @failure The store-deletion migration discards the change records without first
 *          folding their highest PR number into the durable mint, so a deployment
 *          whose `pr-mint.json` is missing or behind re-issues ids that already
 *          name landed changes (22986) with the evidence deleted.
 * @level l3
 * @consumer @yrd/cli host
 */
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { createDurablePrNumberMint, createJournal } from "@yrd/persistence"
import { createProcess } from "@yrd/process"
import * as z from "zod"
import { CURRENT_JOURNAL_COMPATIBILITY, createDefaultYrdApp } from "../src/host.ts"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
// Package-private to @yrd/queue: the radix writer the Run projection stores
// through. Imported by source path rather than widening the package surface
// for a fixture, the same way other suites reach across packages here.
import { projectionLookupSet } from "../../yrd-queue/src/projection-lookup.ts"

/** The identity a deployment stores immediately BEFORE the change-record store
 * leaves the state contract — the edge under test. /hh's live journal held this
 * one at cursor 97714, so this is the crossing the fleet actually makes. */
const RETIRED_CHANGE_STORE_IDENTITY = "381cdb9edee92b0988087ae0fab8bb365b59069224ef47dc6b881dbde735808c"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function repository(): Promise<{ repo: string; featureSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-mint-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, "add", "README.md")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "switch", "-qc", "issue/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "-qm", `feature\n\nChange-Id: I${"cafe".repeat(10)}`)
  const featureSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return { repo, featureSha }
}

const config: ResolvedYrdProjectConfig = {
  base: "main",
  batch: 1,
  steps: ["check", "merge"],
  requires: [],
  definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
  contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
}

function testJournal(dir: string) {
  return createJournal({
    dir,
    writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version,
    inject: { sqliteVersion: "3.53.0" },
  } as unknown as Parameters<typeof createJournal>[0])
}

/** The change-record slice a pre-S7 checkpoint carried, keyed by the PR ids
 * whose numbers are the only thing the mint harvest reads. */
function legacyRecordStore(featureSha: string, ids: readonly string[]): Readonly<Record<string, unknown>> {
  return {
    prs: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          bay: "B1",
          name: "feature",
          branch: "issue/feature",
          base: "main",
          by: "test",
          state: "open",
          merged: false,
          revs: [{ n: 1, head: featureSha, submittedAt: "2026-08-25T00:00:00.000Z" }],
          checkRequests: [],
        },
      ]),
    ),
    receipts: {},
  }
}

/** A retained Run whose member snapshots name `ids`.
 *
 * These rows SURVIVE the store deletion — they are the delivery history the
 * deletion says replaces the record set — so they are a second, independent
 * home for a minted PR number, and on the live journal they outrank the
 * records. Built through the real radix writer so the fixture cannot drift
 * from the shape the projection actually stores. */
function retainedRunNaming(
  ids: readonly string[],
  featureSha: string,
  existing: unknown,
): Readonly<Record<string, unknown>> {
  return projectionLookupSet((existing ?? {}) as never, "R1", {
    id: "R1",
    base: "main",
    baseSha: featureSha,
    startedAt: "2026-08-26T00:00:00.000Z",
    prs: ids.map((id, index) => ({
      id,
      branch: `issue/retained-${String(index)}`,
      base: "main",
      revision: 1,
      headSha: featureSha,
    })),
  } as never) as unknown as Readonly<Record<string, unknown>>
}

/**
 * Stand a deployment up at the identity immediately before the store deletion,
 * carrying `ids` as its change records — the exact predecessor shape the live
 * journal held. Returns the repo and state dir, ready to boot across the edge.
 */
async function deploymentAtRetiredStoreIdentity(
  ids: readonly string[],
  options: Readonly<{ identity?: string; runSnapshotIds?: readonly string[] }> = {},
): Promise<{ repo: string; stateDir: string; mintPath: string }> {
  const identity = options.identity ?? RETIRED_CHANGE_STORE_IDENTITY
  const { repo, featureSha } = await repository()
  const stateDir = join(repo, ".git", "yrd")
  await using runtimeProcess = createProcess({ cwd: repo })

  const predecessor = await createDefaultYrdApp({
    repo,
    stateDir,
    baysRoot: join(repo, ".bays"),
    journal: testJournal(stateDir),
    process: runtimeProcess,
    config,
  })
  await predecessor.bays.recordBranchSubmit({ branch: "issue/feature", sha: featureSha, base: "main" })
  await predecessor.close()

  using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
  const row = database
    .query<{ checkpoint_json: string }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton = 1")
    .get()
  if (row === null) throw new Error("expected a predecessor projection checkpoint")
  const checkpointValue = z
    .object({ value: z.object({ state: z.record(z.string(), z.unknown()) }).passthrough() })
    .passthrough()
    .parse(JSON.parse(row.checkpoint_json))
  const queues = z.record(z.string(), z.unknown()).parse(checkpointValue.value.state["queues"])
  const retained = JSON.stringify({
    ...checkpointValue,
    value: {
      ...checkpointValue.value,
      state: {
        ...checkpointValue.value.state,
        bays: {
          ...z.record(z.string(), z.unknown()).parse(checkpointValue.value.state["bays"]),
          ...legacyRecordStore(featureSha, ids),
        },
        queues: {
          ...queues,
          ...(options.runSnapshotIds === undefined
            ? {}
            : { records: retainedRunNaming(options.runSnapshotIds, featureSha, queues["records"]) }),
        },
      },
    },
    identity,
  })
  database
    .query("UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1")
    .run(identity, retained, createHash("sha256").update(retained).digest("hex"))
  database.close()

  return { repo, stateDir, mintPath: join(stateDir, "pr-mint.json") }
}

/** Boot across the store-deletion edge and return the runtime bays slice. */
async function bootAcrossTheDeletion(repo: string, stateDir: string): Promise<Record<string, unknown>> {
  await using runtimeProcess = createProcess({ cwd: repo })
  await using restored = await createDefaultYrdApp({
    repo,
    stateDir,
    baysRoot: join(repo, ".bays"),
    journal: testJournal(stateDir),
    process: runtimeProcess,
    config,
  })
  return restored.state().bays as unknown as Record<string, unknown>
}

describe("store-deletion migration: PR-number mint harvest", { timeout: 30_000 }, () => {
  it("lifts a behind mint to the highest record number before deleting the records", async () => {
    const { repo, stateDir, mintPath } = await deploymentAtRetiredStoreIdentity(["PR1", "PR7", "PR2144", "PR31"])
    // A mint that is REAL but behind the records — the ordinary case after any
    // window in which ids were minted by an older writer, or restored from a
    // backup taken before the newest ids were issued.
    await writeFile(mintPath, JSON.stringify({ v: 1, prHighWater: 5 }))

    const bays = await bootAcrossTheDeletion(repo, stateDir)

    // The records are gone — this is the same edge, not a separate one.
    expect(bays).not.toHaveProperty("prs")
    expect(bays).not.toHaveProperty("receipts")
    // ...and the number they carried survived them.
    expect(createDurablePrNumberMint({ dir: stateDir }).highWater()).toBe(2144)
    expect(JSON.parse(await readFile(mintPath, "utf8"))).toEqual({ v: 1, prHighWater: 2144 })
  })

  it("resurrects a LOST pr-mint.json from the records it is about to delete (22986)", async () => {
    const { repo, stateDir, mintPath } = await deploymentAtRetiredStoreIdentity(["PR1", "PR812", "PR2144"])
    // The 22986 shape exactly: the journal survived, the mint file did not — a
    // re-clone, a wiped state dir, a backup older than the mint. `highWater()`
    // reads 0 on ENOENT, so without the harvest the next id minted is PR1,
    // walking back over ids the history still names.
    rmSync(mintPath, { force: true })
    expect(existsSync(mintPath)).toBe(false)

    const bays = await bootAcrossTheDeletion(repo, stateDir)

    expect(bays).not.toHaveProperty("prs")
    expect(existsSync(mintPath)).toBe(true)
    expect(createDurablePrNumberMint({ dir: stateDir }).highWater()).toBe(2144)
  })

  it("never moves the mint backwards when it already outranks every record", async () => {
    const { repo, stateDir, mintPath } = await deploymentAtRetiredStoreIdentity(["PR1", "PR7", "PR2144"])
    // `PrNumberMint.commit` REFUSES a backwards move by throwing, and a throw
    // inside a migrate callback is a `checkpoint-migration-failed` boot refusal.
    // So the harvest's `>` guard is load-bearing: without it this deployment
    // could not start at all.
    await writeFile(mintPath, JSON.stringify({ v: 1, prHighWater: 9000 }))

    const bays = await bootAcrossTheDeletion(repo, stateDir)

    expect(bays).not.toHaveProperty("prs")
    expect(createDurablePrNumberMint({ dir: stateDir }).highWater()).toBe(9000)
  })

  it("still harvests when the records arrive over a MULTI-HOP path", async () => {
    // The harvest sits on the LAST edge. A deployment two hops back reaches it
    // through `36d85bbb -> 381cdb9e -> current`, so the records have to survive
    // the intermediate callback to be readable when the harvest runs. If an
    // earlier edge ever starts pruning `bays.prs`, the write is silently lost
    // and the mint stays behind — this is the test that would catch it.
    const retiredChangeRecordIdentity = "36d85bbb8b59e8a3c6c327b8f14f643816d951cd003904ac0acbe0bbca150691"
    const { repo, stateDir, mintPath } = await deploymentAtRetiredStoreIdentity(["PR1", "PR2144"], {
      identity: retiredChangeRecordIdentity,
    })
    await writeFile(mintPath, JSON.stringify({ v: 1, prHighWater: 5 }))

    const bays = await bootAcrossTheDeletion(repo, stateDir)

    expect(bays).not.toHaveProperty("prs")
    expect(createDurablePrNumberMint({ dir: stateDir }).highWater()).toBe(2144)
  })

  // KNOWN RED — names a real defect, measured on /hh's own journal, not invented.
  //
  // The harvest reads `bays.prs` alone, but the record set is NOT the only place
  // the journal names a PR id: retained Run member snapshots name them too, and
  // they OUTRANK the records. Measured 2026-08-28 on the production journal
  // (cursor 97714): record-set max PR2144, run-snapshot max PR2148, with PR2145
  // and PR2148 present in run history and absent from the record set. So an
  // ENOENT restore lifts the mint to 2144 and the very next id minted is PR2145
  // — an id the history already names. That is 22986 reproduced through the
  // mitigation built to prevent it.
  //
  // The fix is a union, not a bigger number: harvest max(bays.prs, retained
  // snapshots, admissionRefusals). The snapshot half needs no "last chance" —
  // those rows SURVIVE the deletion, so it can equally be a standing startup
  // invariant instead of a one-shot migration step.
  it("lifts the mint above every id the journal names, not just the records", async () => {
    const { repo, stateDir, mintPath } = await deploymentAtRetiredStoreIdentity(["PR1", "PR2144"], {
      runSnapshotIds: ["PR2148"],
    })
    await writeFile(mintPath, JSON.stringify({ v: 1, prHighWater: 5 }))

    const bays = await bootAcrossTheDeletion(repo, stateDir)

    expect(bays).not.toHaveProperty("prs")
    // 2148 is named by a retained Run; minting 2145..2148 again re-issues it.
    expect(createDurablePrNumberMint({ dir: stateDir }).highWater()).toBeGreaterThanOrEqual(2148)
  })

  it("crosses the edge when the predecessor carries no record container at all", async () => {
    const { repo, stateDir, mintPath } = await deploymentAtRetiredStoreIdentity([])
    await writeFile(mintPath, JSON.stringify({ v: 1, prHighWater: 42 }))

    const bays = await bootAcrossTheDeletion(repo, stateDir)

    expect(bays).not.toHaveProperty("prs")
    expect(createDurablePrNumberMint({ dir: stateDir }).highWater()).toBe(42)
  })
})
