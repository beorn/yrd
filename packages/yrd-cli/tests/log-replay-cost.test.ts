/**
 * @failure One `yrd log` invocation decodes every frame the journal holds, so the command's cost grows with the journal's age rather than with the rows it prints — the cold-replay defect `@yrd/core/21012-monorepo/21566-journal-sqlite-container-swap` closed once already and that regrew as the journal did.
 * @level l2
 * @consumer @yrd/cli
 *
 * WHY FRAMES AND NOT MILLISECONDS. The prior fix for this defect had no
 * regression pin at all, which is why journal growth silently re-created it and
 * the bead came back `#undead`. A wall-clock assertion would be the obvious pin
 * and the wrong one: this repo's tests run alongside dozens of live agents, so a
 * millisecond budget either flakes under load or is set so loose it stops
 * catching anything. Frames decoded per invocation is the same quantity without
 * the load sensitivity — it is what actually grew (11,878 frames in 2026-07,
 * 42,011 today) and what the fix bounds.
 *
 * WHAT THE ASSERTION IS. Not "under N frames" — a constant is a number someone
 * has to keep true. The invariant is that the count does NOT move when the
 * journal does: measure one `log` invocation, append more history, measure
 * again, and require the same count. At the base this file was written against,
 * both counts equalled their journal's whole size, so growing the journal grew
 * the read; that is exactly the shape this refuses.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { queueLegacyCoverage } from "../src/run.ts"
import { createMemoryJournal, type Journal } from "@yrd/core"
import { appendHistory, createCliApp, outputIO, stubReadModel, yrd } from "./support/log-app.ts"
import { runYrd as runYrdRaw } from "@yrd/cli"

/** A memory journal that counts the frames its reads hand back, so a test can
 * ask what one CLI invocation cost the journal rather than what it cost the
 * clock. Counting at `read` covers every consumer — projection fold, coverage
 * probe, history scan — because they all come through this one method. */
function countingJournal() {
  const inner = createMemoryJournal<unknown>()
  let frames = 0
  const journal: Journal<unknown> = {
    async *read(after, before) {
      for await (const batch of inner.read(after, before)) {
        frames += batch.values.length
        yield batch
      }
    },
    append: (value, expectedCursor) => inner.append(value, expectedCursor),
  }
  return { journal, framesRead: () => frames, reset: () => void (frames = 0) }
}

/** Run one CLI invocation and report what the journal handed it. */
async function invocation(
  app: Awaited<ReturnType<typeof createCliApp>>,
  meter: ReturnType<typeof countingJournal>,
  ...args: string[]
): Promise<number> {
  meter.reset()
  const output = outputIO()
  const code = await runYrdRaw(app, yrd(...args), output.io, { queueReadModel: stubReadModel(app) })
  expect(code, output.stderr()).toBe(0)
  return meter.framesRead()
}

describe.each([
  { command: "log", args: ["log", "--json"] },
  // `queue list` is the shape the user actually runs and the one `yrd watch`
  // is built out of — `watch` IS `queue list --watch`. It reached the same
  // journal from a different chain than `log` did, so pinning `log` alone left
  // the reported command unpinned.
  { command: "queue list", args: ["queue", "list", "--json"] },
])("yrd $command cold-replay cost", ({ args }) => {
  it("reads the same number of frames however much history the journal holds", async () => {
    const meter = countingJournal()
    await using app = await createCliApp(meter.journal)

    await appendHistory(app, "early", 12)
    const smallCursor = (await app.journalSnapshot()).asOf.cursor
    const smallFrames = await invocation(app, meter, ...args)

    await appendHistory(app, "later", 12)
    const grownCursor = (await app.journalSnapshot()).asOf.cursor
    const grownFrames = await invocation(app, meter, ...args)

    // The fixture has to actually grow, or the invariant below proves nothing.
    expect(grownCursor).toBeGreaterThan(smallCursor)
    // ...and it has to outgrow the coverage probe's window, or an unbounded
    // read would look bounded here for the wrong reason.
    expect(smallCursor).toBeGreaterThan(8)

    expect(grownFrames).toBe(smallFrames)
    expect(smallFrames).toBeLessThan(smallCursor)
  })
})

/**
 * The other half of `yrd log`'s cost, and the one frames-decoded cannot see.
 *
 * The coverage probe's timestamp came from `app.retentionDiagnostics()`, which
 * eagerly runs the journal's full-frame fact audit through direct SQLite reads
 * — never through `journal.read()`, so the counting journal above is blind to
 * it. Measured 2026-09-01 on the live 92,616-frame hh journal: 1.70 GB resident
 * and 6.5-7.7 s with the event loop blocked, per call.
 *
 * And every repository past the legacy migration discarded the result: with no
 * `events.jsonl` and no `bay/journal.jsonl` the probe returns `undefined` and
 * never reads the string it was handed. `yrd log -L 200 --json` measured 10.8 s
 * and 3.52 GB peak before this, 4.2 s and 1.21 GB after, printing byte-identical
 * output — so the assertion below is not about speed, it is that the expensive
 * value is never ASKED FOR on the path that throws it away.
 */
describe("yrd log coverage probe", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "yrd-log-coverage-"))
    execFileSync("git", ["init", "-q", "-b", "main", root])
    roots.push(root)
    return root
  }

  it("never asks for the timestamp when no legacy journal exists", async () => {
    const root = repo()
    let asked = 0
    const coverage = await queueLegacyCoverage(root, async () => {
      asked += 1
      return "2026-09-01T00:00:00.000Z"
    })

    expect(coverage).toBeUndefined()
    // The whole fix: not "it was fast" but "it was never called". A thunk that
    // runs and is discarded reads identically in the output and costs 1.7 GB.
    expect(asked).toBe(0)
  })

  it("still asks, exactly once, when a legacy journal is really there", async () => {
    const root = repo()
    const gitDir = join(root, ".git", "yrd")
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, "events.jsonl"), '{"a":1}\n{"a":2}\n')
    let asked = 0
    const coverage = await queueLegacyCoverage(root, async () => {
      asked += 1
      return "2026-09-01T00:00:00.000Z"
    })

    // The negative control that makes the zero above evidence rather than a
    // thunk nothing would ever have called.
    expect(asked).toBe(1)
    expect(coverage?.since).toBe("2026-09-01T00:00:00.000Z")
    expect(coverage?.legacy[0]?.frames).toBe(2)
  })
})
