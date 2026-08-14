/**
 * @failure  An intent whose landing fails deterministically is retried at the
 *           head of the intent lane forever, blocking every intent behind it
 *           including other components'. The parking predicate that stops this
 *           is only as good as its fingerprint: key it on a list of
 *           known-deterministic error codes and it catches the specimen you
 *           wrote it for and misses the next one; key it on the rendered
 *           failure message and it never fires at all, because the message
 *           carries the run id and the attempt's scratch path.
 * @level    l1 (pure policy over synthesized attempt records)
 * @consumer @yrd/core/lane-head-spins-on-dead-intent
 */
import { describe, expect, it } from "vitest"
import {
  INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS,
  intentAttemptFingerprint,
  intentParkVerdict,
  renderRemedyStep,
  type IntentAttemptFailure,
} from "../src/index.ts"

const COMPONENT = "vendor/tribe"
const TARGET = "a".repeat(40)
const OTHER_TARGET = "b".repeat(40)
const PRIOR_PIN = "c".repeat(40)

const INTENT = { id: "yrdpin#177", issue: { source: "km", id: "@yrd/core/some-advance" } } as const

function failure(overrides: Partial<IntentAttemptFailure> = {}): IntentAttemptFailure {
  return {
    code: "carrier-drops-landed",
    step: "merge",
    component: COMPONENT,
    target: TARGET,
    priorPin: PRIOR_PIN,
    reason: "the merged pin does not contain the planned component target",
    at: "2026-08-14T22:00:00.000Z",
    ...overrides,
  }
}

function repeat(count: number, template: IntentAttemptFailure): IntentAttemptFailure[] {
  // Each attempt renders its own sentence, as the real ones do: a fresh run id
  // and a fresh scratch directory every pass. If the fingerprint ever starts
  // reading `reason`, this is the test that goes red.
  return Array.from({ length: count }, (_unused, index) => ({
    ...template,
    reason: `${template.reason} (run R${2247 + index}, scratch .git/yrd/scratch/yrd-queue-${index}xKq)`,
    at: new Date(Date.parse(template.at) + index * 60_000).toISOString(),
  }))
}

describe("dead-intent parking", () => {
  it("parks on a refusal code no implementer would have enumerated", () => {
    // Not `carrier-drops-landed`, not a diverged pin, not any code in this
    // repository today. The predicate has never heard of it and parks anyway,
    // because what it reads is the repetition, not the vocabulary.
    const novel = failure({ code: "quantum-oracle-desynchronized", step: "attest" })

    const park = intentParkVerdict(INTENT, repeat(INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS, novel))

    expect(park).toMatchObject({
      attempts: INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS,
      failure: { code: "quantum-oracle-desynchronized" },
      fingerprint: expect.stringMatching(/^quantum-oracle-desynchronized:[0-9a-f]{16}$/u),
      // The page rail refuses a finding without these two, so the verdict has
      // to carry the block span, not just its length.
      since: "2026-08-14T22:00:00.000Z",
      blockedMs: (INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS - 1) * 60_000,
    })
  })

  it("holds the lane until the threshold, then parks", () => {
    const attempts = repeat(INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS, failure())

    expect(intentParkVerdict(INTENT, [])).toBeUndefined()
    expect(intentParkVerdict(INTENT, attempts.slice(0, INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS - 1))).toBeUndefined()
    expect(intentParkVerdict(INTENT, attempts)?.attempts).toBe(INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS)
  })

  it("keeps retrying when consecutive attempts carry DIFFERENT fingerprints", () => {
    // A flaky remote, a lost lease, a base that moved under the attempt: each
    // produces its own fingerprint, and retrying can still change the answer.
    const mixed = [
      failure({ code: "source-publish", step: "merge" }),
      failure({ code: "carrier-drops-landed", step: "merge" }),
      failure({ code: "job-lost", step: undefined }),
    ]

    expect(intentParkVerdict(INTENT, mixed)).toBeUndefined()

    // The same code against a DIFFERENT target is a different question too, so
    // it resets the count rather than counting toward the same park.
    const retargeted = [
      failure({ target: OTHER_TARGET }),
      failure({ target: TARGET }),
      failure({ target: OTHER_TARGET }),
    ]
    expect(intentParkVerdict(INTENT, retargeted)).toBeUndefined()
  })

  it("counts only the TRAILING identical run, so an old failure cannot pad the count", () => {
    const attempts = [
      ...repeat(2, failure()),
      failure({ code: "source-publish" }),
      ...repeat(INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS - 1, failure()),
    ]

    expect(intentParkVerdict(INTENT, attempts)).toBeUndefined()
    expect(intentParkVerdict(INTENT, [...attempts, failure()])?.attempts).toBe(INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS)
  })

  it("fingerprints the cause tuple and ignores the rendered sentence", () => {
    const first = failure({ reason: "failed in run R2247 under scratch yrd-queue-8BbPQW" })
    const second = failure({ reason: "failed in run R2248 under scratch yrd-queue-TlDgln" })

    expect(intentAttemptFingerprint(first)).toBe(intentAttemptFingerprint(second))
    // Nor the clock: every attempt has a distinct `at` by construction, so a
    // fingerprint that read it would never repeat and would park nothing.
    expect(intentAttemptFingerprint(failure())).toBe(
      intentAttemptFingerprint(failure({ at: "2027-01-01T00:00:00.000Z" })),
    )
    expect(intentAttemptFingerprint(failure())).not.toBe(intentAttemptFingerprint(failure({ step: "check" })))
    expect(intentAttemptFingerprint(failure())).not.toBe(intentAttemptFingerprint(failure({ priorPin: TARGET })))
    expect(intentAttemptFingerprint(failure())).not.toBe(
      intentAttemptFingerprint(failure({ component: "vendor/yrd" })),
    )
  })

  it("carries a remedy that names the fix and is runnable as printed", () => {
    const park = intentParkVerdict(INTENT, repeat(INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS, failure()))
    if (park === undefined) throw new Error("expected a park verdict")

    expect(park.remedy.map(renderRemedyStep)).toEqual([
      // Quoted, because an unquoted `#` is zsh's repeat operator under
      // extendedglob and the line has to survive being pasted into a shell.
      "yrd intent show 'yrdpin#177'",
      `yrd intent submit --component ${COMPONENT} --issue @yrd/core/some-advance`,
    ])
    expect(park.remedySummary).toContain("carrier-drops-landed")
    expect(park.remedySummary).toContain(COMPONENT)
    expect(park.remedySummary).toContain(PRIOR_PIN)
    // No remedy may tell its reader to hand-push a component ref or force
    // anything; the banned-actions guard scans src, and this pins the one
    // remedy this policy generates.
    expect(park.remedySummary).not.toMatch(/force|push|reset --hard|cherry-pick/u)
  })
})
