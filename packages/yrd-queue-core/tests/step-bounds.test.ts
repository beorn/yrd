/**
 * Every step the queue times is a watchdog contract: the service's runner maps each `step` row's name through
 * STEP_BOUNDS_MS and throws on one it does not know — "runner step derive has no declared detection bound" stopped
 * the line on 2026-10-02 17:19 PDT when the compose gained `derive` without a bound (27176).
 *
 * @failure A new timed step lands without a detection bound and the live service exits on its first row.
 * @level l1
 * @consumer the queue service's runner watchdog (yrd-cli queue-core-commands) over event-run's and verifying's timed steps
 * @testonly none
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STEP_BOUNDS_MS, STEP_STATES } from "../src/check.ts"

const SRC = join(import.meta.dirname, "..", "src")

function timedNames(file: string, pattern: RegExp): string[] {
  const text = readFileSync(join(SRC, file), "utf8")
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1] as string))].sort()
}

describe("timed steps are bounded (27176)", () => {
  it("every step verifyCandidate or the event run can time has a detection bound and a state", () => {
    const named = [
      ...timedNames("verifying.ts", /\btimed\("([a-zA-Z-]+)"/gu),
      ...timedNames("event-run.ts", /timedStep\(log, \{[^}]*?\bname: "([a-zA-Z-]+)"/gu),
    ]
    expect(named.length).toBeGreaterThan(5)
    for (const name of named) {
      expect(Object.hasOwn(STEP_BOUNDS_MS, name), `${name} needs a STEP_BOUNDS_MS entry`).toBe(true)
      expect(Object.hasOwn(STEP_STATES, name), `${name} needs a STEP_STATES entry`).toBe(true)
    }
  })

  it("the compose's derive steps are provisioning, bounded like the compose", () => {
    expect(STEP_BOUNDS_MS.derive).toBe(STEP_BOUNDS_MS.compose)
    expect(STEP_BOUNDS_MS["derive-again"]).toBe(STEP_BOUNDS_MS.compose)
    expect(STEP_STATES.derive).toBe("provisioning")
    expect(STEP_STATES["derive-again"]).toBe("provisioning")
  })
})
