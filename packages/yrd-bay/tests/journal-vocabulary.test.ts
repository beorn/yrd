/**
 * @failure A field added to a shipped bay event merges without declaring which
 * reader version can read it, so a newer writer emits a key every pinned reader
 * refuses — one row then strands the whole fleet, and no reader can recover.
 * This snapshot is the ratchet: growing a payload changes it, and the change
 * cannot be accepted without saying what reads the new field.
 * @level l2
 * @consumer @yrd/bay
 */
import { describe, expect, it } from "vitest"
import { createYrdDef, journalEventVocabulary, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createBayJobDefs, withBays, type BayWorkspace } from "../src/plugin.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)

function workspaceAdapter(): BayWorkspace {
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

describe("bay journal vocabulary", () => {
  it("pins every bay event's fields to the reader version that can read them", () => {
    const bayJobs = createBayJobDefs(workspaceAdapter())
    const definition = pipe(createYrdDef(), withJobs({ definitions: [bayJobs] }), withBays({ jobs: bayJobs }))

    expect(journalEventVocabulary(definition.events)).toMatchSnapshot()
  })

  it("names every field that sits at its event's version for a reason other than its own age", () => {
    // `bay/opened.by` is the one field older than field-versioning itself, so
    // v1 rows in the field already carry it. Every other field is at its
    // version because that version introduced it, and a second entry here means
    // someone declared an exception that has to be argued rather than inherited.
    const bayJobs = createBayJobDefs(workspaceAdapter())
    const definition = pipe(createYrdDef(), withJobs({ definitions: [bayJobs] }), withBays({ jobs: bayJobs }))

    const asterisks = Object.entries(journalEventVocabulary(definition.events)).flatMap(([name, entry]) =>
      Object.entries(entry.grandfathered ?? {}).map(([field, mark]) => [`${name}.${field}`, mark.introducedAt]),
    )

    expect(asterisks).toEqual([["bay/opened.by", "53f67709"]])
  })

  it("gives every field a version no lower than its own event's", () => {
    const bayJobs = createBayJobDefs(workspaceAdapter())
    const definition = pipe(createYrdDef(), withJobs({ definitions: [bayJobs] }), withBays({ jobs: bayJobs }))

    for (const [name, entry] of Object.entries(journalEventVocabulary(definition.events))) {
      for (const [field, version] of Object.entries(entry.fields)) {
        expect({ name, field, version }).toMatchObject({ version: expect.any(Number) })
        expect(version).toBeGreaterThanOrEqual(entry.reader)
      }
    }
  })
})
