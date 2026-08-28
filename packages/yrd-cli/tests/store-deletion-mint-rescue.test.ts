/**
 * @failure The store-deletion checkpoint migration destroys the change-record
 * set without folding its maximum PR number into the durable mint, so a
 * deployment that lost `pr-mint.json` restarts at PR1 and walks back over ids
 * the journal still remembers (22986).
 * @level l3
 * @consumer @yrd/cli host — the store-deletion checkpoint migration edge
 *   (`381cdb9e…` → current) in `packages/yrd-cli/src/host.ts`
 *
 * Why this needs its own fence, and why the fence has to sit on the MIGRATION
 * rather than on the mint: `mintChangeId(mint, records)` used to let a
 * surviving record set out-vote a lost mint file, and `@yrd/bay`'s own
 * `pr-mint` suite still proves that arm works. But the live call site
 * (`derived-member.ts` `mintChangeId(mint, {})`) passes an EMPTY record set —
 * S7 has no record store to vote with — and this migration is what deletes the
 * records for good. So the record-set maximum is knowable exactly once, on
 * this edge, and any test that stops at `mintChangeId` is fencing an argument
 * production never supplies.
 *
 * The scenario is the 22986 shape, not a hypothetical: `readHighWater` returns
 * 0 on ENOENT, so losing `pr-mint.json` while the journal survives — a
 * re-clone, a wiped state dir, a backup older than the mint — reads as "never
 * minted". Every fixture below therefore DELETES the mint file between the
 * predecessor boot and the migrating boot; a warm mint would pass with the
 * rescue removed and prove nothing.
 */
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { mintChangeId } from "@yrd/bay"
import { createDurablePrNumberMint, createJournal, createReadOnlyJournal } from "@yrd/persistence"
import { createProcess } from "@yrd/process"
import { createLogger } from "loggily"
import * as z from "zod"
import { CURRENT_JOURNAL_COMPATIBILITY, createDefaultYrdApp as createDefaultYrdAppRaw } from "../src/host.ts"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"

/** The identity the live deployment's checkpoint carries — the immediate
 * predecessor of the store deletion, and the one boot that still holds the
 * record set. Same constant as `RETIRED_CHANGE_STORE_CHECKPOINT_IDENTITY` in
 * `host.ts`; spelled here so a conscious identity bump has to update both. */
const RETIRED_CHANGE_STORE_IDENTITY = "381cdb9edee92b0988087ae0fab8bb365b59069224ef47dc6b881dbde735808c"
/** One hop earlier: the released identity every retained predecessor merges
 * on. Entering here proves the record set survives an intermediate edge and
 * still reaches the fold. */
const RETIRED_CHANGE_RECORD_IDENTITY = "36d85bbb8b59e8a3c6c327b8f14f643816d951cd003904ac0acbe0bbca150691"

const MINT_FILE = "pr-mint.json"
const silentLog = createLogger("test", [{ level: "silent" }])
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function createDefaultYrdApp(options: Parameters<typeof createDefaultYrdAppRaw>[0]) {
  return createDefaultYrdAppRaw({ ...options, log: options.log ?? silentLog })
}

function testJournal(dir: string) {
  return createJournal({
    dir,
    writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version,
    inject: { sqliteVersion: "3.53.0" },
  } as unknown as Parameters<typeof createJournal>[0])
}

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

async function repository(): Promise<{ repo: string; featureSha: string; secondSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-mint-rescue-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), 'checks: [{check: {run: "true"}}]\n')
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "switch", "-qc", "issue/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "-qm", `feature\n\nChange-Id: I${"cafe".repeat(10)}`)
  const featureSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  // A second branch so a fixture can admit TWO members and leave two different
  // ids in surviving state; the reuse arm would hand a re-submitted branch its
  // old id back instead of minting.
  await git(repo, "switch", "-qc", "issue/second")
  await writeFile(join(repo, "second.txt"), "second\n")
  await git(repo, "add", "second.txt")
  await git(repo, "commit", "-qm", `second\n\nChange-Id: I${"beef".repeat(10)}`)
  const secondSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return { repo, featureSha, secondSha }
}

const config: ResolvedYrdProjectConfig = {
  base: "main",
  batch: 1,
  steps: ["check", "merge"],
  requires: [],
  definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
  contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
}

/**
 * The change-record slice a pre-S7 checkpoint carried, keyed by the ids the
 * scenario needs. S7 deleted `bays.prs` from the state contract, so no live
 * code can write one any more; spelling the bytes is the only honest fixture,
 * and it pins what a DEPLOYED checkpoint holds rather than whatever today's
 * projector would emit.
 *
 * Key ORDER is load-bearing: the non-`PR` bay key and the malformed id sit
 * BEFORE the maximum, so a fold that aborted on an unparseable key instead of
 * skipping past it would never reach `PR41` and the fixture would catch it.
 */
function legacyRecordStore(featureSha: string): Readonly<Record<string, unknown>> {
  const record = (id: string) => ({
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
  })
  return {
    prs: {
      PR1: record("PR1"),
      // A bay id, not a change id: the fold's regex must decline it silently.
      B12: record("B12"),
      // Malformed, and deliberately ahead of the maximum in iteration order.
      PRxyz: record("PRxyz"),
      PR41: record("PR41"),
      PR7: record("PR7"),
    },
    receipts: {},
  }
}

/** Highest id `legacyRecordStore` holds. Every future id must clear it. */
const RECORD_SET_MAX = 41
/** An id a SURVIVING container names, deliberately above `RECORD_SET_MAX`:
 * the live journal's `queues.candidates` sits 3 ids above `bays.prs`. */
const SURVIVING_ID = 44

const CheckpointRowSchema = z
  .object({ value: z.object({ state: z.record(z.string(), z.unknown()) }).loose() })
  .loose()

/** Re-stamp the stored checkpoint at `identity`, injecting the retired record
 * container, exactly as a deployed predecessor's row holds it. */
function seedPredecessorCheckpoint(stateDir: string, identity: string, featureSha: string): void {
  using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
  const stored = database
    .query<{ checkpoint_json: string }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton = 1")
    .get()
  if (stored === null) throw new Error("expected a predecessor projection checkpoint to re-stamp")
  const parsed = CheckpointRowSchema.parse(JSON.parse(stored.checkpoint_json))
  const bays = z.record(z.string(), z.unknown()).parse(parsed.value.state["bays"])
  const seeded = JSON.stringify({
    ...parsed,
    value: {
      ...parsed.value,
      state: { ...parsed.value.state, bays: { ...bays, ...legacyRecordStore(featureSha) } },
    },
    identity,
  })
  database
    .query(
      "UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1",
    )
    .run(identity, seeded, createHash("sha256").update(seeded).digest("hex"))
  database.close()
}

/**
 * The durable high-water as the mint itself would read it, ENOENT included: a
 * missing file is 0, exactly as `readHighWater` reports it.
 *
 * Tolerating the absence here is deliberate. Letting the read THROW would make
 * every regression report `ENOENT ...pr-mint.json` — true, but it names the
 * symptom one step before the harm. Reading 0 lets the assertions below fail
 * on the fact that actually costs something: the next id collides with an id
 * the journal still remembers.
 */
async function readMintHighWater(stateDir: string): Promise<number> {
  let raw: string
  try {
    raw = await readFile(join(stateDir, MINT_FILE), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return 0
  }
  return z.object({ v: z.literal(1), prHighWater: z.number() }).parse(JSON.parse(raw)).prHighWater
}

/**
 * Boot a host, submit a branch, run it once — enough to produce a real
 * projection checkpoint — then close and hand back the state dir.
 */
async function bootPredecessor(repo: string, featureSha: string): Promise<string> {
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
  await predecessor.queue.run({ steps: ["check"] }, { runner: "test", leaseMs: 60_000 })
  await predecessor.close()
  return stateDir
}

/**
 * Admit `branch` through a real boot so its minted id lands where production
 * puts it. The probe that designed this fixture confirmed one run writes the id
 * into `jobs.byId.*`, `queues.candidates.*`, `queues.records.*` and
 * `queues.authority.*` — the same containers the live checkpoint carries it in.
 */
async function admitBranch(repo: string, stateDir: string, branch: string, sha: string): Promise<void> {
  await using runtimeProcess = createProcess({ cwd: repo })
  const app = await createDefaultYrdApp({
    repo,
    stateDir,
    baysRoot: join(repo, ".bays"),
    journal: testJournal(stateDir),
    process: runtimeProcess,
    config,
  })
  await app.bays.recordBranchSubmit({ branch, sha, base: "main" })
  await app.queue.run({ steps: ["check"] }, { runner: "test", leaseMs: 60_000 })
  await app.close()
}

async function bootAcrossMigration(repo: string, stateDir: string): Promise<void> {
  await using runtimeProcess = createProcess({ cwd: repo })
  const restored = await createDefaultYrdApp({
    repo,
    stateDir,
    baysRoot: join(repo, ".bays"),
    journal: testJournal(stateDir),
    process: runtimeProcess,
    config,
  })
  // The container is gone from runtime state: this boot really did cross the
  // deletion, so the mint assertions below are about the post-deletion world.
  expect(restored.state().bays).not.toHaveProperty("prs")
  expect(restored.state().bays).not.toHaveProperty("receipts")
  await restored.close()
}

// Each fixture boots a real host two or three times over a real SQLite journal;
// the heaviest measured 4.4s idle and blew Vitest's 5s default once under load.
// `host.test.ts` declares 20s for the same class of fixture — this one carries
// more boots per test, so it takes more headroom.
describe("store-deletion migration rescues the PR-number mint", { timeout: 30_000 }, () => {
  it("folds the record-set maximum into a LOST mint, so no future id collides with history", async () => {
    const { repo, featureSha } = await repository()
    const stateDir = await bootPredecessor(repo, featureSha)
    seedPredecessorCheckpoint(stateDir, RETIRED_CHANGE_STORE_IDENTITY, featureSha)

    // THE 22986 LOSS. Without this the predecessor's own warm mint would carry
    // the sequence and the fixture would pass with the rescue deleted.
    await rm(join(stateDir, MINT_FILE), { force: true })
    expect(createDurablePrNumberMint({ dir: stateDir }).highWater()).toBe(0)

    await bootAcrossMigration(repo, stateDir)

    // 1. The durable mint is at least as high as the records it replaced.
    //    Soft, so a regression reports BOTH halves of the damage in one run:
    //    the mint that was never raised, and the id that collides because of it.
    expect.soft(await readMintHighWater(stateDir)).toBeGreaterThanOrEqual(RECORD_SET_MAX)

    // 2. The next id clears every id the record set held. `{}` is the exact
    //    argument the live call site passes (`derived-member.ts`
    //    `mintChangeId(mint, {})`) — there is no record set left to out-vote a
    //    low mint, which is precisely why the fold above had to happen.
    const next = mintChangeId(createDurablePrNumberMint({ dir: stateDir }), {})
    expect.soft(next).toBe(`PR${String(RECORD_SET_MAX + 1)}`)
    const minted = Number(/^PR(\d+)$/u.exec(next)?.[1] ?? Number.NaN)
    expect(minted).toBeGreaterThan(RECORD_SET_MAX)
  })

  it("still sees the record set when the checkpoint enters a hop earlier", async () => {
    // A retained deployment does not enter at the store-deletion edge; it
    // arrives through `36d85bbb → 381cdb9e` first. That edge spreads the
    // stored state wholesale and rewrites only `queues`, so `bays.prs` reaches
    // the fold today — but nothing in the edge SAYS so, and the fold is the
    // last reader of a container three separate callbacks are free to drop.
    // This fixture is what makes that pass-through a checked property.
    const { repo, featureSha } = await repository()
    const stateDir = await bootPredecessor(repo, featureSha)
    seedPredecessorCheckpoint(stateDir, RETIRED_CHANGE_RECORD_IDENTITY, featureSha)
    await rm(join(stateDir, MINT_FILE), { force: true })

    await bootAcrossMigration(repo, stateDir)

    expect.soft(await readMintHighWater(stateDir)).toBeGreaterThanOrEqual(RECORD_SET_MAX)
    expect(mintChangeId(createDurablePrNumberMint({ dir: stateDir }), {})).toBe(`PR${String(RECORD_SET_MAX + 1)}`)
  })

  it("survives the migration running again: a repeat fold never moves the mint backwards", async () => {
    // `migrate` is not transactional with the checkpoint save, and a boot that
    // cannot save (a read-only journal has `checkpoint.inspect` but no
    // `checkpoint.save`) leaves the predecessor row in place — so the edge runs
    // again on the next boot, and again after that. A fold that committed
    // unconditionally would throw on the second pass, because
    // `PrNumberMint.commit` refuses to move its high-water backwards.
    const { repo, featureSha } = await repository()
    const stateDir = await bootPredecessor(repo, featureSha)
    seedPredecessorCheckpoint(stateDir, RETIRED_CHANGE_STORE_IDENTITY, featureSha)
    await rm(join(stateDir, MINT_FILE), { force: true })

    await bootAcrossMigration(repo, stateDir)
    const afterFirst = await readMintHighWater(stateDir)
    // Anchor the repeat on a mint that was actually rescued; without this the
    // case degenerates to "0 stayed 0", which passes with the fold deleted.
    expect.soft(afterFirst).toBeGreaterThanOrEqual(RECORD_SET_MAX)

    // Re-stamp the predecessor row and cross the same edge a second time, with
    // the mint now already ABOVE every record the fold will read.
    seedPredecessorCheckpoint(stateDir, RETIRED_CHANGE_STORE_IDENTITY, featureSha)
    await bootAcrossMigration(repo, stateDir)

    expect(await readMintHighWater(stateDir)).toBe(afterFirst)
  })

  /**
   * The union defect, measured on the live journal before it was written.
   *
   * Read-only copy of `/hh/dev/.git/yrd/journal.sqlite`, 2026-08-28 00:09 PDT,
   * checkpoint cursor 97912 at identity `381cdb9e…` — the store-deletion
   * predecessor, so this is the state the fleet actually crosses on:
   *
   *   bays.prs        (DESTROYED by the edge)   max PR2149   2140 records
   *   queues.records  (Run snapshots, survives)  max PR2148
   *   queues.candidates            (survives)   max PR2152
   *   jobs.byId.*                  (survives)   max PR2152
   *   queues.admissionRefusals     (survives)   no ids at all (0 rows)
   *   live pr-mint.json high-water              PR2152
   *
   * So harvesting the record set alone establishes PR2149 and re-issues PR2150,
   * PR2151 and PR2152 — ids the surviving state still names. The mint's own
   * asymmetry ruling is what makes that unrecoverable: a skipped number costs
   * nothing, a recycled one poisons every citation of it.
   *
   * This fixture is that shape in miniature: the record set stops at PR41 while
   * a surviving container names PR44.
   */
  it("clears every id the SURVIVING state names, not just the destroyed record set", async () => {
    const { repo, featureSha, secondSha } = await repository()
    const stateDir = await bootPredecessor(repo, featureSha)

    // Advance the mint, then admit a second branch so a genuinely minted id
    // above the record-set max lands in the surviving containers. Injecting one
    // by hand would prove only that the scanner reads JSON; this proves it
    // reads what the queue actually writes.
    createDurablePrNumberMint({ dir: stateDir }).commit(SURVIVING_ID - 1)
    await admitBranch(repo, stateDir, "issue/second", secondSha)
    expect(await readMintHighWater(stateDir)).toBe(SURVIVING_ID)

    seedPredecessorCheckpoint(stateDir, RETIRED_CHANGE_STORE_IDENTITY, featureSha)
    await rm(join(stateDir, MINT_FILE), { force: true })

    await bootAcrossMigration(repo, stateDir)

    // The floor must clear the SURVIVING maximum, not the record-set maximum.
    expect.soft(await readMintHighWater(stateDir)).toBeGreaterThanOrEqual(SURVIVING_ID)
    expect(mintChangeId(createDurablePrNumberMint({ dir: stateDir }), {})).toBe(`PR${String(SURVIVING_ID + 1)}`)
  })

  it("does not fire when the mint is already ahead: the floor only ever raises", async () => {
    // The negative control for the invariant itself. A floor that ASSIGNED
    // rather than maxed would drag a healthy mint down to the state's maximum
    // and re-issue everything above it — the same defect from the other side,
    // and one no fixture that starts from a lost mint can see.
    const { repo, featureSha } = await repository()
    const stateDir = await bootPredecessor(repo, featureSha)
    seedPredecessorCheckpoint(stateDir, RETIRED_CHANGE_STORE_IDENTITY, featureSha)

    const ahead = 5000
    createDurablePrNumberMint({ dir: stateDir }).commit(ahead)

    await bootAcrossMigration(repo, stateDir)

    expect(await readMintHighWater(stateDir)).toBe(ahead)
    expect(mintChangeId(createDurablePrNumberMint({ dir: stateDir }), {})).toBe(`PR${String(ahead + 1)}`)
  })

  it("re-establishes the floor with NO migration in play, and never from a viewer", async () => {
    // The standing half on its own terms. The checkpoint here sits at the
    // CURRENT identity, so no migration edge fires at all — which is the whole
    // point: the loss this defends against is not tied to crossing an identity
    // boundary, and an edge that fires once cannot cover it.
    const { repo, featureSha } = await repository()
    const stateDir = await bootPredecessor(repo, featureSha)
    const minted = await readMintHighWater(stateDir)
    expect(minted).toBeGreaterThan(0)

    await rm(join(stateDir, MINT_FILE), { force: true })

    // A viewer boot must leave the state dir alone. It cannot mint, so a floor
    // established here protects nothing, and writing one would make read-only
    // commands mutate state — and refuse to boot on a state dir they cannot
    // write.
    await using viewerProcess = createProcess({ cwd: repo })
    const viewer = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: createReadOnlyJournal({ dir: stateDir }) as unknown as ReturnType<typeof testJournal>,
      process: viewerProcess,
      config,
    })
    await viewer.close()
    expect(await readMintHighWater(stateDir)).toBe(0)

    // The active runtime, over the very same state, restores the floor.
    await using activeProcess = createProcess({ cwd: repo })
    const active = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: activeProcess,
      config,
    })
    await active.close()
    expect(await readMintHighWater(stateDir)).toBe(minted)
  })
})
