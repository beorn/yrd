/**
 * @failure Every event on a `withIntents()` app's journal is validated by `canonicalEvent`
 * (@yrd/core `app.ts`) BEFORE `project` ever runs, and that validation throws uncaught when
 * a persisted `intent/submitted` or `intent/pin-tombstoned` record does not match today's
 * schema and no `replayEvents` entry accepts it — crashing the WHOLE app's replay over one
 * intent record, not just this feature's. This is the PR1128 class named in
 * @i/10-merge-queue/intent-deletion-radius.md G5 for the two persisted kinds
 * (`yrd.intent.pin-advance.v1`, `yrd.intent.pin-tombstone.v1`): "yrdpin#384/#385 wrote more
 * today", so a live journal genuinely holds records this schema must keep being able to read.
 * @level l3 (journal-backed plugin over an in-memory journal, replay from cold)
 * @consumer @i/10-merge-queue/intent-deletion-radius (shaset step (d), phase 1)
 */
import { createLogger } from "loggily"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type Journal } from "@yrd/core"
import { withIssues } from "@yrd/issue"
import { describe, expect, it } from "vitest"
import { withIntents } from "../src/index.ts"

const SILVERY = "components/alpha"
const TARGET = "a".repeat(40)

function uuid(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`
}

async function createApp(journal: ReturnType<typeof createMemoryJournal> = createMemoryJournal()) {
  const definition = pipe(
    createYrdDef(),
    withIssues({
      sources: [{ id: "km", resolve: (ref) => (ref.id.startsWith("@") ? { ref, title: "Bump" } : undefined) }],
    }),
    withIntents(),
  )
  return createYrd(definition, {
    inject: { journal, clock: () => "2026-08-18T12:00:00.000Z", log: createLogger("test", [{ level: "silent" }]) },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

async function submit(app: App, intentId: string, component = SILVERY) {
  const issue = await app.issues.resolve(app.issues.ref("@yrd/core/shaset-d-tolerant-reader"))
  return app.intents.submit({
    intentId,
    issue: issue.ref,
    component,
    submitter: "@dev/8",
    target: TARGET,
  })
}

type Fact = Readonly<{ id?: string; name: string; data?: Readonly<Record<string, unknown>> }>
type Frame = Readonly<{ events?: readonly Fact[] }>

/** Every frame the journal holds, in order — the same read `journal.read()` exposes to
 * `fold`, laid flat for surgery. */
async function frames(journal: Journal<unknown>): Promise<unknown[]> {
  const collected: unknown[] = []
  for await (const page of journal.read()) collected.push(...page.values)
  return collected
}

/**
 * Corrupt the `intent/submitted` event that admitted `intentId`, leaving every other event
 * (including any OTHER intent) untouched. `mutate` receives the event's `data` exactly as
 * `admitIntent` wrote it and returns the shape a hypothetical differently-versioned writer
 * would have produced instead — this is standing in for schema drift, not simulating a bug
 * in THIS package's own writer, which stays strict and untouched.
 */
async function corruptSubmittedEvent(
  journal: Journal<unknown>,
  intentId: string,
  mutate: (data: Readonly<Record<string, unknown>>) => unknown,
): Promise<Journal<unknown>> {
  const all = await frames(journal)
  let touched = 0
  const rewritten = all.map((value) => {
    const frame = value as Frame
    if (frame.events === undefined) return value
    return {
      ...frame,
      events: frame.events.map((fact) => {
        if (fact.name !== "intent/submitted" || fact.data?.intentId !== intentId) return fact
        touched += 1
        return { ...fact, data: mutate(fact.data) }
      }),
    }
  })
  // Fail loud rather than silently no-op: an assertion below would otherwise pass vacuously.
  if (touched !== 1) throw new Error(`expected to corrupt exactly one 'intent/submitted' event for '${intentId}'; touched ${touched}`)
  return createMemoryJournal(rewritten)
}

describe("a persisted intent record this schema cannot read", () => {
  it("does not crash replay: the app boots, and the record is quarantined instead of thrown", async () => {
    const journal = createMemoryJournal()
    {
      await using seed = await createApp(journal)
      await submit(seed, uuid(1))
      await submit(seed, uuid(2))
    }
    // A hypothetical newer writer's shape: `component` renamed, so this schema's `component`
    // field is simply absent — exactly the "record this schema cannot read" case, not a
    // fabricated JSON syntax error.
    const corrupted = await corruptSubmittedEvent(journal, uuid(2), (data) => {
      const { component: _component, ...rest } = data
      return { ...rest, componentPath: SILVERY }
    })

    // The defining assertion: creating a FRESH app folds the whole journal from cold, and
    // that fold must not throw — this is the replay path `canonicalEvent` guards, one layer
    // above anything `projectIntents` itself can catch.
    await using app = await createApp(corrupted)

    // The readable record survived: one bad row does not veto the population.
    expect(app.intents.list().map((record) => record.intentId)).toEqual([uuid(1)])
  })

  it("reports the quarantined record with what, where and why", async () => {
    const journal = createMemoryJournal()
    {
      await using seed = await createApp(journal)
      await submit(seed, uuid(1))
    }
    const corrupted = await corruptSubmittedEvent(journal, uuid(1), (data) => {
      const { component: _component, ...rest } = data
      return rest
    })

    await using app = await createApp(corrupted)

    const unreadable = app.intents.unreadable()
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]).toMatchObject({ name: "intent/submitted" })
    // WHERE: a stable journal-event id, not a description the reader invented.
    expect(typeof unreadable[0]?.id).toBe("string")
    expect(unreadable[0]?.id.length).toBeGreaterThan(0)
    // WHY: the schema's own refusal, not a generic "could not read" — this is what makes the
    // report actionable rather than a bare "0 intents" that hides what was excluded.
    expect(unreadable[0]?.reason).toMatch(/component/iu)
  })

  it("is not a duplicate of an empty list: 'no intents' and 'one intent, unreadable' are distinguishable", async () => {
    const journal = createMemoryJournal()
    {
      await using seed = await createApp(journal)
      await submit(seed, uuid(1))
    }
    const corrupted = await corruptSubmittedEvent(journal, uuid(1), (data) => {
      const { component: _component, ...rest } = data
      return rest
    })
    await using app = await createApp(corrupted)

    expect(app.intents.list()).toEqual([])
    expect(app.intents.unreadable()).toHaveLength(1)
  })

  it("keeps the WRITE path strict: submitting a fresh intent is unaffected by replay tolerance", async () => {
    // The append path never consults `replayEvents` — `canonicalEvent` only falls back to it
    // when `source === "replay"`. A fresh, in-process submission is validated by the full
    // `.strict()` schema exactly as before; tolerance is a READ-time property only.
    await using app = await createApp()
    const record = await submit(app, uuid(1))
    expect(record.intentId).toBe(uuid(1))
    expect(app.intents.unreadable()).toEqual([])
  })
})
