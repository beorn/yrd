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
import { describe, expect, it } from "vitest"
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

/** Run `log --json` and report what the journal handed the invocation. */
async function logInvocation(
  app: Awaited<ReturnType<typeof createCliApp>>,
  meter: ReturnType<typeof countingJournal>,
): Promise<number> {
  meter.reset()
  const output = outputIO()
  const code = await runYrdRaw(app, yrd("log", "--json"), output.io, { queueReadModel: stubReadModel(app) })
  expect(code, output.stderr()).toBe(0)
  return meter.framesRead()
}

describe("yrd log cold-replay cost", () => {
  it("reads the same number of frames however much history the journal holds", async () => {
    const meter = countingJournal()
    await using app = await createCliApp(meter.journal)

    await appendHistory(app, "early", 12)
    const smallCursor = (await app.journalSnapshot()).asOf.cursor
    const smallFrames = await logInvocation(app, meter)

    await appendHistory(app, "later", 12)
    const grownCursor = (await app.journalSnapshot()).asOf.cursor
    const grownFrames = await logInvocation(app, meter)

    // The fixture has to actually grow, or the invariant below proves nothing.
    expect(grownCursor).toBeGreaterThan(smallCursor)
    // ...and it has to outgrow the coverage probe's window, or an unbounded
    // read would look bounded here for the wrong reason.
    expect(smallCursor).toBeGreaterThan(8)

    expect(grownFrames).toBe(smallFrames)
    expect(smallFrames).toBeLessThan(smallCursor)
  })
})
