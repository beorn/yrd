/**
 * @failure A newer writer emits an event payload field that every pinned reader
 * refuses. `journalEvent(reader, schema)` binds a minimum reader version to the
 * event NAME only, so growing an existing event's payload leaves that number
 * untouched: the writer-side check passes, the row lands, and every reader
 * pinned below the new field strands on it — the reported specimen being one
 * `bay/opened` row carrying `by` against `actor`-pinned readers. The strand is
 * not recoverable by the reader, so the write is what has to refuse.
 * @level l1
 * @consumer @yrd/core
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  command,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  event,
  journalEvent,
  journalEventVocabulary,
} from "@yrd/core"

const OPENED = "bay/opened"

/** `actor` has been readable since v1; `by` is what this revision adds. */
const OpenedSchema = z.object({ actor: z.string(), by: z.string().optional() }).strict()

type OpenedArgs = Readonly<{ actor: string; by?: string }>

function openedDefinition() {
  const open = command({
    title: "Open a bay",
    params: OpenedSchema,
    apply: (_state: object, args: OpenedArgs) => ({ events: [event(OPENED, { ...args })] }),
  })
  return createYrdDef().extend({
    commands: { bay: { open } },
    events: { [OPENED]: journalEvent(1, OpenedSchema, { by: 2 }) },
  })
}

describe("journal field vocabulary", () => {
  it("refuses at the writer when an emitted field needs a newer reader than the writer declares", async () => {
    // Refusing here is the whole point: once the row is in the journal it is
    // already unreadable for every reader pinned below v2, and none of them can
    // recover from it.
    const journal = createMemoryJournal()
    await using app = await createYrd(openedDefinition(), { inject: { journal, compatibility: { version: 1 } } })

    await expect(app.dispatch(app.commands.bay.open, { actor: "dev/1", by: "dev/6" })).rejects.toMatchObject({
      failure: {
        kind: "configuration",
        code: "journal-field-version-skew",
        // Naming the field is what makes this actionable: a wide payload
        // otherwise leaves the author guessing which key their pin cannot carry.
        message: expect.stringContaining("'by'"),
      },
    })
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([])
  })

  it("names the event alongside the field it refused", async () => {
    const journal = createMemoryJournal()
    await using app = await createYrd(openedDefinition(), { inject: { journal, compatibility: { version: 1 } } })

    await expect(app.dispatch(app.commands.bay.open, { actor: "dev/1", by: "dev/6" })).rejects.toMatchObject({
      failure: { message: expect.stringContaining(OPENED) },
    })
  })

  it("still writes the vocabulary the declared version already carries", async () => {
    const journal = createMemoryJournal()
    await using app = await createYrd(openedDefinition(), { inject: { journal, compatibility: { version: 1 } } })

    await app.dispatch(app.commands.bay.open, { actor: "dev/1" })

    await expect(Array.fromAsync(journal.read())).resolves.toEqual([
      expect.objectContaining({ values: [expect.objectContaining({ compatibility: { version: 1 } })] }),
    ])
  })

  it("writes the newer field once the writer declares the version that carries it", async () => {
    const journal = createMemoryJournal()
    await using app = await createYrd(openedDefinition(), { inject: { journal, compatibility: { version: 2 } } })

    await app.dispatch(app.commands.bay.open, { actor: "dev/1", by: "dev/6" })

    await expect(Array.fromAsync(journal.read())).resolves.toEqual([
      expect.objectContaining({ values: [expect.objectContaining({ compatibility: { version: 2 } })] }),
    ])
  })

  it("publishes every field's required reader version so a package can pin its vocabulary", () => {
    // A snapshot of this map is the ratchet: a field added to a shipped event
    // changes it, so the field cannot land without declaring its version.
    expect(journalEventVocabulary({ [OPENED]: journalEvent(1, OpenedSchema, { by: 2 }) })).toEqual({
      [OPENED]: { reader: 1, fields: { actor: 1, by: 2 } },
    })
  })

  it("refuses a declared field the schema does not have", () => {
    expect(() => journalEvent(1, z.object({ actor: z.string() }).strict(), { by: 2 })).toThrowError(/'by'/u)
  })

  it("refuses a field version below its own event's minimum reader", () => {
    expect(() => journalEvent(2, OpenedSchema, { by: 1 })).toThrowError(/'by'/u)
  })

  it("leaves an event with nothing grandfathered at the unmarked default", () => {
    // The asterisk only means anything while it is rare, so an event that
    // carries none must publish the shape it published before the annotation
    // existed rather than an empty map that reads as a considered exemption.
    const vocabulary = journalEventVocabulary({ [OPENED]: journalEvent(1, OpenedSchema, { by: 2 }) })

    expect(vocabulary[OPENED]).not.toHaveProperty("grandfathered")
  })

  it("publishes a grandfathered field's introducing commit so the exception can be enumerated", () => {
    const vocabulary = journalEventVocabulary({
      [OPENED]: journalEvent(1, OpenedSchema, {}, { by: { introducedAt: "53f67709" } }),
    })

    expect(vocabulary).toEqual({
      [OPENED]: {
        reader: 1,
        fields: { actor: 1, by: 1 },
        grandfathered: { by: { introducedAt: "53f67709" } },
      },
    })
    // The point of the shape: an audit reaches every asterisk in the fleet
    // without knowing which events have one.
    expect(
      Object.entries(vocabulary).flatMap(([name, entry]) =>
        Object.keys(entry.grandfathered ?? {}).map((field) => `${name}.${field}`),
      ),
    ).toEqual([`${OPENED}.by`])
  })

  it("refuses grandfathering a field the schema does not have", () => {
    expect(() =>
      journalEvent(1, z.object({ actor: z.string() }).strict(), {}, { by: { introducedAt: "53f67709" } }),
    ).toThrowError(/'by'/u)
  })

  it("refuses grandfathering a field that also declares a newer reader", () => {
    // "v1 rows already carry it" and "no row below v2 carries it" cannot both
    // be true, and shipping the pair leaves a reader no answer at all.
    expect(() => journalEvent(1, OpenedSchema, { by: 2 }, { by: { introducedAt: "53f67709" } })).toThrowError(/'by'/u)
  })

  it("refuses a grandfather record that does not name a commit", () => {
    // Without the commit the record says only that an asterisk exists, which is
    // the state it was added to end.
    expect(() => journalEvent(1, OpenedSchema, {}, { by: { introducedAt: "the identity rename" } })).toThrowError(
      /'by'/u,
    )
  })
})
