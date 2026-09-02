/**
 * @failure A run merged and the process died before its members' `pr/integrated`
 *          write landed, so the records stayed open forever and every recovery
 *          pass walked past them: `queue:recover succeeded … runs: []`. Live on
 *          2026-09-02 — PR3216 rev 1 merged in run #3766 at 06:36 (b2e0dc9a),
 *          the resident restarted at 06:39, and `queue status` was still
 *          printing `○ ready … (change 'PR3216' checks are queued)` two hours
 *          later. PR2462 and PR2145 had been stranded the same way since
 *          2026-08-28. Nothing walked from a finished run back to the records it
 *          should have closed; recovery now does, idempotently.
 * @level l2
 * @consumer @yrd/queue queue (recoverableIntegrationStamps, recover)
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import {
  type BayWorkspace,
  changeDeliveryState,
  createBayJobDefs,
  volatilePrNumberMint,
  withBays,
} from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, type Journal, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withMerge, withQueue, withStep } from "@yrd/queue"
import type { IntegrationProof } from "../src/model.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const RUNTIME = { runner: "local", leaseMs: 60_000, now: () => Date.parse("2026-01-01T00:00:00.000Z") }

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

async function createApp(
  journal: Journal<unknown> = createMemoryJournal(),
  log?: ReturnType<typeof createLogger>,
  id: () => string = ids(),
) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<{ checked: boolean }> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: z.object({ checked: z.boolean() }).strict() },
  )
  const merge = withMerge(
    (): JobResult<IntegrationProof> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    runnerAlive: () => undefined,
  })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal,
      id,
      clock: () => "2026-01-01T00:00:00.000Z",
      log: log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

type Fact = Readonly<{ name: string }>
type Frame = Readonly<{ events?: readonly Fact[] }>

async function values(journal: Journal<unknown>): Promise<unknown[]> {
  const collected: unknown[] = []
  for await (const page of journal.read()) collected.push(...page.values)
  return collected
}

/**
 * The restart split, reproduced exactly: keep every fact the run wrote, drop the
 * terminal facts that stamp its MEMBER RECORDS. What replays is a completed,
 * merged run whose member is still `submitted` — the live PR3216 shape.
 */
async function withoutMemberStamps(journal: Journal<unknown>): Promise<Journal<unknown>> {
  const kept = (await values(journal)).map((value) => {
    const frame = value as Frame
    if (frame.events === undefined) return value
    return {
      ...frame,
      events: frame.events.filter((event) => event.name !== "pr/integrated" && event.name !== "branch/unsubmitted"),
    }
  })
  return createMemoryJournal(kept)
}

async function seedUnstampedMerge(log?: ReturnType<typeof createLogger>) {
  const journal = createMemoryJournal()
  {
    await using app = await createApp(journal)
    await app.bays.submit({ branch: "issue/landed-but-open", headSha: HEAD, base: "main", baseSha: BASE })
    // The receiver's own projection of the refs/for push. The merge retires it
    // through `branch/unsubmitted` — one of the two facts the restart lost —
    // so it stands in the replayed journal exactly as it does live.
    await app.bays.recordBranchSubmit({ branch: "issue/landed-but-open", sha: HEAD, base: "main" })
    const [run] = await app.queue.run({ prs: ["PR1"] }, RUNTIME)
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("integrated")
  }
  // A fresh command-id run: the replayed journal already holds the first
  // app's ids, and a reused id is a different-command collision.
  return createApp(await withoutMemberStamps(journal), log, ids(0x1000))
}

function stampLogs(events: readonly LogEvent[]) {
  return events.filter(
    (event): event is Extract<LogEvent, { kind: "log" }> =>
      event.kind === "log" && event.props?.action === "recover-integration-stamp",
  )
}

describe("recovery converges a merged run whose member records never got stamped (L2)", () => {
  it("re-applies the integration stamp and says so in one line", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await seedUnstampedMerge(log)

    // Precondition — the exact live lie: the run merged, the record says otherwise.
    expect(app.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "success" })
    expect(app.queue.get("R1")?.integration).toMatchObject({ commit: MERGED, baseSha: BASE })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")

    await app.queue.recover({ recoveryTime: "2026-01-01T00:05:00.000Z", reason: "restart" })

    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("integrated")
    expect(app.state().bays.prs.PR1?.integration).toMatchObject({ commit: MERGED, baseSha: BASE })

    const [line, ...extra] = stampLogs(events)
    expect(extra).toEqual([])
    expect(line?.message).toBe(
      `recovered the integration stamp for PR1 rev 1 from run R1 (merged ${MERGED.slice(0, 8)} at 2026-01-01T00:00:00.000Z)`,
    )
    expect(line?.props).toMatchObject({
      reason: "unstamped-merge",
      run: "R1",
      pr: "PR1",
      revision: 1,
      commit: MERGED,
      baseSha: BASE,
    })
    log.end()
  })

  it("retires the stale submit fact the open record was still holding", async () => {
    await using app = await seedUnstampedMerge()
    expect(app.state().bays.submits["issue/landed-but-open"]).toBeDefined()

    await app.queue.recover({ recoveryTime: "2026-01-01T00:05:00.000Z", reason: "restart" })

    // The submit fact is what feeds every `[unrecorded-submit]` surface; a
    // landing that never stamped its record left it standing forever.
    expect(app.state().bays.submits["issue/landed-but-open"]).toBeUndefined()
  })

  it("emits nothing on a second pass, and nothing at all when no stamp is missing", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await seedUnstampedMerge(log)

    await app.queue.recover({ recoveryTime: "2026-01-01T00:05:00.000Z", reason: "first" })
    expect(stampLogs(events)).toHaveLength(1)

    await app.queue.recover({ recoveryTime: "2026-01-01T00:06:00.000Z", reason: "second" })
    expect(stampLogs(events), "a stamped record must not be re-stamped").toHaveLength(1)
    log.end()
  })

  it("leaves an ordinary merged journal untouched — no stamp, no line", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp(createMemoryJournal(), log)
    await app.bays.submit({ branch: "issue/ordinary", headSha: HEAD, base: "main", baseSha: BASE })
    await app.queue.run({ prs: ["PR1"] }, RUNTIME)

    await app.queue.recover({ recoveryTime: "2026-01-01T00:05:00.000Z", reason: "restart" })

    expect(stampLogs(events)).toEqual([])
    log.end()
  })
})
