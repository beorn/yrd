/**
 * @failure  Pin advances enter the queue as authored gitlink carriers, so the
 *           record that says "advance component X to S for issue I" only exists
 *           as a hand-built commit. Without a durable PinIntentV1 record the
 *           supersede-by-(issue, component) key, the idempotent replay, and the
 *           "terminal records hold no queue position" invariant have nowhere to
 *           live. These assertions pin the record lifecycle itself.
 * @level    l3 (journal-backed plugin over an in-memory journal)
 * @consumer @yrd/core/21679-integration-model-v2/22668-admit-intents
 */
import { command, createMemoryJournal, createYrd, createYrdDef, event, failureFact, pipe } from "@yrd/core"
import { withIssues } from "@yrd/issue"
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { PIN_INTENT_SCHEMA, PinIntentIntegratedFactSchema, withIntents } from "../src/index.ts"

const SILVERY = "components/alpha"
const FLEXILY = "components/beta"
const TARGET = "a".repeat(40)
const OTHER_TARGET = "b".repeat(40)
const CURRENT_PIN = "c".repeat(40)
const ROOT_BASE = "d".repeat(40)
const LANDING = "e".repeat(40)
const LANDING_TREE = "f".repeat(40)

function uuid(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`
}

/**
 * Refusals are asserted by TYPED CODE, never by message text. A refusal whose
 * wording changes must keep its code; a refusal whose code changes is a
 * contract break the message can hide.
 */
async function refusalCode(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work
  } catch (error) {
    return failureFact(error)?.code
  }
  return undefined
}

async function createApp(journal: ReturnType<typeof createMemoryJournal> = createMemoryJournal()) {
  const integrate = command({
    title: "Emit an intent landing fixture",
    params: PinIntentIntegratedFactSchema,
    apply: (_state, args) => ({ events: [event("intent/integrated", args)] }),
  })
  const definition = pipe(
    createYrdDef(),
    withIssues({
      sources: [{ id: "km", resolve: (ref) => (ref.id.startsWith("@") ? { ref, title: "Bump" } : undefined) }],
    }),
    withIntents(),
  ).extend({ commands: { fixture: { integrate } } })
  return createYrd(definition, {
    inject: { journal, clock: () => "2026-07-31T12:00:00.000Z", log: createLogger("test", [{ level: "silent" }]) },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

async function submit(
  app: App,
  options: {
    intentId: string
    component?: string
    target?: string
    issue?: string
    expectPin?: string
    submitter?: string
    forceSupersede?: boolean
  },
) {
  const issue = await app.issues.resolve(app.issues.ref(options.issue ?? "@yrd/core/22668-admit-intents"))
  return app.intents.submit({
    intentId: options.intentId,
    issue: issue.ref,
    component: options.component ?? SILVERY,
    submitter: options.submitter ?? "@dev/8",
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.expectPin === undefined ? {} : { expectedCurrentPin: options.expectPin }),
    ...(options.forceSupersede === undefined ? {} : { forceSupersede: options.forceSupersede }),
  })
}

describe("PinIntentV1 journal records (22668 phase 1)", () => {
  it("admits an intent as an open record with a human counter id", async () => {
    await using app = await createApp()
    const record = await submit(app, { intentId: uuid(1), target: TARGET })

    expect(record.id).toBe("I1")
    expect(record.schema).toBe(PIN_INTENT_SCHEMA)
    expect(record.intentId).toBe(uuid(1))
    expect(record.component).toBe(SILVERY)
    expect(record.target).toBe(TARGET)
    expect(record.issue).toEqual({ source: "km", id: "@yrd/core/22668-admit-intents" })
    expect(record.submitter).toBe("@dev/8")
    expect(record.submittedAt).toBe("2026-07-31T12:00:00.000Z")
    expect(record.status).toBe("open")
    expect(record.preconditions.targetPublished).toBe(true)
    expect(record.preconditions.targetDescendsFromCurrentPin).toBe(true)
  })

  it("admits an intent with NO target — the lockfile-authority bridge", async () => {
    await using app = await createApp()
    const record = await submit(app, { intentId: uuid(1) })

    expect(record.target).toBeUndefined()
    expect(record.status).toBe("open")
  })

  it("records expectedCurrentPin when the submitter supplies the CAS guard", async () => {
    await using app = await createApp()
    const record = await submit(app, { intentId: uuid(1), target: TARGET, expectPin: CURRENT_PIN })

    expect(record.preconditions.expectedCurrentPin).toBe(CURRENT_PIN)
  })

  it("replays an identical intentId instead of minting a second record", async () => {
    await using app = await createApp()
    const first = await submit(app, { intentId: uuid(1), target: TARGET })
    const replay = await submit(app, { intentId: uuid(1), target: TARGET })

    expect(replay.id).toBe(first.id)
    expect(app.intents.list()).toHaveLength(1)
  })

  it("refuses a replayed intentId whose fingerprint changed", async () => {
    await using app = await createApp()
    await submit(app, { intentId: uuid(1), target: TARGET })

    expect(await refusalCode(submit(app, { intentId: uuid(1), target: OTHER_TARGET }))).toBe(
      "intent-fingerprint-conflict",
    )
  })

  it("supersedes the open record for the same (issue, component) key", async () => {
    await using app = await createApp()
    const first = await submit(app, { intentId: uuid(1), target: TARGET })
    const second = await submit(app, { intentId: uuid(2), target: OTHER_TARGET })

    expect(second.id).toBe("I2")
    expect(app.intents.get(first.id)?.status).toBe("superseded")
    expect(app.intents.get(first.id)?.supersededBy).toBe(second.id)
    expect(app.intents.get(second.id)?.status).toBe("open")
    expect(app.intents.live(first.issue, SILVERY)?.id).toBe(second.id)
  })

  it("requires explicit consent before another submitter supersedes a live intent", async () => {
    await using app = await createApp()
    const first = await submit(app, { intentId: uuid(1), target: TARGET, submitter: "@dev/1" })

    expect(await refusalCode(submit(app, { intentId: uuid(2), target: OTHER_TARGET, submitter: "@dev/2" }))).toBe(
      "intent-supersede-consent-required",
    )
    expect(app.intents.get(first.id)?.status).toBe("open")

    const replacement = await submit(app, {
      intentId: uuid(2),
      target: OTHER_TARGET,
      submitter: "@dev/2",
      forceSupersede: true,
    })
    expect(replacement.supersedeConsent).toBe("forced")
    expect(replacement.supersededIntent).toBe(first.id)
    expect(app.intents.get(first.id)?.status).toBe("superseded")
  })

  it("keys supersession by component, so a sibling component stays open", async () => {
    await using app = await createApp()
    const first = await submit(app, { intentId: uuid(1), component: SILVERY, target: TARGET })
    const second = await submit(app, { intentId: uuid(2), component: FLEXILY, target: TARGET })

    expect(app.intents.get(first.id)?.status).toBe("open")
    expect(app.intents.get(second.id)?.status).toBe("open")
  })

  it("keys supersession by issue, so another issue's intent stays open", async () => {
    await using app = await createApp()
    const first = await submit(app, { intentId: uuid(1), target: TARGET })
    const second = await submit(app, { intentId: uuid(2), issue: "@yrd/core/22666-linear", target: TARGET })

    expect(app.intents.get(first.id)?.status).toBe("open")
    expect(app.intents.get(second.id)?.status).toBe("open")
  })

  it("NEVER supersedes a terminal record — a withdrawn intent stays withdrawn", async () => {
    await using app = await createApp()
    const first = await submit(app, { intentId: uuid(1), target: TARGET })
    await app.intents.withdraw(first.id, "superseded by hand")
    const second = await submit(app, { intentId: uuid(2), target: OTHER_TARGET })

    expect(app.intents.get(first.id)?.status).toBe("withdrawn")
    expect(app.intents.get(first.id)?.supersededBy).toBeUndefined()
    expect(app.intents.get(second.id)?.status).toBe("open")
  })

  it("replaying a superseded intentId returns the superseded record AND the live id", async () => {
    await using app = await createApp()
    const first = await submit(app, { intentId: uuid(1), target: TARGET })
    const second = await submit(app, { intentId: uuid(2), target: OTHER_TARGET })
    const replay = await submit(app, { intentId: uuid(1), target: TARGET })

    expect(replay.id).toBe(first.id)
    expect(replay.status).toBe("superseded")
    expect(replay.supersededBy).toBe(second.id)
    expect(app.intents.get(second.id)?.status).toBe("open")
  })

  it("withdraw is terminal and refuses a second withdrawal", async () => {
    await using app = await createApp()
    const record = await submit(app, { intentId: uuid(1), target: TARGET })
    const withdrawn = await app.intents.withdraw(record.id, "no longer needed")

    expect(withdrawn.status).toBe("withdrawn")
    expect(withdrawn.disposition?.code).toBe("intent-withdrawn")
    expect(withdrawn.disposition?.reason).toBe("no longer needed")
    expect(await refusalCode(app.intents.withdraw(record.id, "again"))).toBe("intent-terminal")
  })

  it("refuses withdrawing an unknown intent", async () => {
    await using app = await createApp()
    expect(await refusalCode(app.intents.withdraw("I9", "nope"))).toBe("intent-not-found")
  })

  it("terminal records hold NO queue position (design 6.1 invariant 1)", async () => {
    await using app = await createApp()
    const first = await submit(app, { intentId: uuid(1), component: SILVERY, target: TARGET })
    const second = await submit(app, { intentId: uuid(2), component: FLEXILY, target: TARGET })
    await app.intents.withdraw(first.id, "dropped")

    expect(app.intents.queued().map((intent) => intent.id)).toEqual([second.id])
    expect(app.intents.list()).toHaveLength(2)
  })

  it("journals the complete authored-to-landed lineage and releases the queue position", async () => {
    const journal = createMemoryJournal()
    {
      await using app = await createApp(journal)
      const record = await submit(app, { intentId: uuid(1), target: TARGET })

      await app.dispatch(app.commands.fixture.integrate, {
        intent: record.id,
        authored: {
          intentId: record.intentId,
          issue: record.issue,
          component: record.component,
          target: TARGET,
        },
        evaluated: { priorPin: CURRENT_PIN, target: TARGET },
        landing: {
          candidate: "C7",
          run: "R11",
          baseSha: ROOT_BASE,
          commit: LANDING,
          treeSha: LANDING_TREE,
          componentPin: TARGET,
        },
      })

      expect(app.intents.get(record.id)).toMatchObject({
        status: "integrated",
        disposition: { code: "intent-integrated", at: "2026-07-31T12:00:00.000Z" },
        integration: {
          authored: { intentId: uuid(1), issue: record.issue, component: SILVERY, target: TARGET },
          evaluated: { priorPin: CURRENT_PIN, target: TARGET },
          landing: {
            candidate: "C7",
            run: "R11",
            baseSha: ROOT_BASE,
            commit: LANDING,
            treeSha: LANDING_TREE,
            componentPin: TARGET,
          },
        },
      })
      expect(app.intents.queued()).toEqual([])
    }

    await using replayed = await createApp(journal)
    expect(replayed.intents.get("I1")?.integration?.landing.commit).toBe(LANDING)
    expect(replayed.intents.queued()).toEqual([])
  })

  it("keeps queued intents in submission FIFO order", async () => {
    await using app = await createApp()
    await submit(app, { intentId: uuid(1), component: SILVERY, target: TARGET })
    await submit(app, { intentId: uuid(2), component: FLEXILY, target: TARGET })
    await submit(app, { intentId: uuid(3), component: "components/gamma", target: TARGET })

    expect(app.intents.queued().map((intent) => intent.component)).toEqual([SILVERY, FLEXILY, "components/gamma"])
  })

  it("refuses an unresolvable issue rather than recording an anonymous pin move", async () => {
    await using app = await createApp()
    expect(await refusalCode(app.issues.resolve(app.issues.ref("22668-no-sigil")))).toBe("issue-not-found")
  })

  it("refuses a component path that is not root-relative", async () => {
    await using app = await createApp()
    await expect(submit(app, { intentId: uuid(1), component: "../escape", target: TARGET })).rejects.toThrow()
    await expect(submit(app, { intentId: uuid(2), component: "/abs/path", target: TARGET })).rejects.toThrow()
    await expect(submit(app, { intentId: uuid(3), component: "", target: TARGET })).rejects.toThrow()
  })

  it("refuses a target that is not a full 40-hex commit sha", async () => {
    await using app = await createApp()
    await expect(submit(app, { intentId: uuid(1), target: "abc1234" })).rejects.toThrow()
  })

  it("refuses an intent with no resolvable submitter identity (3.1 submitter binding)", async () => {
    await using app = await createApp()
    await expect(submit(app, { intentId: uuid(1), target: TARGET, submitter: "  " })).rejects.toThrow()
  })

  it("rebuilds the whole lifecycle from the journal alone", async () => {
    const journal = createMemoryJournal()
    {
      await using app = await createApp(journal)
      const first = await submit(app, { intentId: uuid(1), component: SILVERY, target: TARGET })
      await submit(app, { intentId: uuid(2), component: FLEXILY, target: TARGET })
      await submit(app, { intentId: uuid(3), component: FLEXILY, target: OTHER_TARGET })
      await app.intents.withdraw(first.id, "replaced by hand")
    }
    await using replayed = await createApp(journal)

    expect(replayed.intents.list().map((intent) => [intent.id, intent.status])).toEqual([
      ["I1", "withdrawn"],
      ["I2", "superseded"],
      ["I3", "open"],
    ])
    expect(replayed.intents.queued().map((intent) => intent.id)).toEqual(["I3"])
    expect(replayed.intents.get("I2")?.supersededBy).toBe("I3")
  })

  it("journals and replays the pin tombstone that invalidates stale desired state", async () => {
    const journal = createMemoryJournal()
    {
      await using app = await createApp(journal)
      const issue = await app.issues.resolve(app.issues.ref("@yrd/rollback/bad-pin"))

      const tombstone = await app.intents.tombstone({
        tombstoneId: uuid(9),
        issue: issue.ref,
        component: SILVERY,
        sha: TARGET,
        submitter: "@operator",
        reason: "rolled back after a production regression",
      })

      expect(tombstone).toMatchObject({
        id: "T1",
        component: SILVERY,
        sha: TARGET,
        submitter: "@operator",
        reason: "rolled back after a production regression",
      })
    }

    await using replayed = await createApp(journal)
    expect(replayed.intents.tombstones(SILVERY)).toMatchObject([{ id: "T1", sha: TARGET }])
  })
})
