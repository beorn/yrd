/**
 * @failure A reader older than a frame already in the journal refuses the whole replay, so one newer writer anywhere in the fleet blocks every older reader on every verb.
 * @level l1
 * @consumer @yrd/core
 *
 * Measured 2026-08-17 with four live yrd source versions: `yrd bay in` failed
 * with "journal schema v3 exceeds this reader's compiled capability v2" and
 * `pr submit` refused from every tree. That string is this axis — the frame's
 * declared vocabulary — not the SQLite `user_version` axis that
 * `classifyJournalSchema` already made survivable.
 *
 * The asymmetry under test is the whole design, and on this axis it differs
 * from the SQLite one. A frame BEHIND the reader has always been readable —
 * that is what `SUPPORTED_VERSIONS` means. A frame AHEAD of the reader is what
 * used to refuse, and now degrades: the reader's own parse decides, so a frame
 * whose newer vocabulary this reader never asks for is read, and one whose
 * envelope this reader cannot satisfy still refuses, naming both versions.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CauseSchema,
  classifyJournalFrameVersion,
  Command,
  EventSchema,
  JOURNAL_READER_VERSION,
  journalFrameSkew,
  parseJournalFrame,
  type JournalFrameSkew,
} from "@yrd/core"
import { describe, expect, it } from "vitest"

const AHEAD = JOURNAL_READER_VERSION + 1

/** A frame envelope this reader fully understands, at whatever version is asked for. */
function frame(version?: number, extra: Record<string, unknown> = {}) {
  const command = Command.parse({ id: "00000000-0000-7000-8000-000000000001", op: "test.record" })
  return {
    cause: CauseSchema.parse({
      id: "00000000-0000-7000-8000-000000000002",
      commandId: command.id,
      op: command.op,
      commandHash: Command.hash(command),
    }),
    command,
    events: [
      EventSchema.parse({
        id: "00000000-0000-7000-8000-000000000003",
        name: "test/recorded",
        ts: "2026-08-30T12:00:00.000Z",
        data: { text: "hello" },
      }),
    ],
    ...(version === undefined ? {} : { compatibility: { version } }),
    ...extra,
  }
}

describe("journal frame vocabulary skew", () => {
  it("classifies a compiled/declared pair once, for every frame parse to consult", () => {
    expect(classifyJournalFrameVersion(3, 3)).toEqual({ kind: "same", compiled: 3, declared: 3 })
    expect(classifyJournalFrameVersion(3, 4)).toEqual({ kind: "reader-behind", compiled: 3, declared: 4 })
    expect(classifyJournalFrameVersion(3, 9)).toEqual({ kind: "reader-behind", compiled: 3, declared: 9 })
    expect(classifyJournalFrameVersion(3, 2)).toEqual({ kind: "frame-behind", compiled: 3, declared: 2 })
    // A frame from before the compatibility stamp declares nothing, and the
    // journal already reads that as version 0 (`initialJournalVersionFloor`).
    expect(classifyJournalFrameVersion(3, undefined)).toEqual({ kind: "frame-behind", compiled: 3, declared: 0 })
  })

  it("types the classification so a consumer must handle every direction", () => {
    const describeSkew = (skew: JournalFrameSkew): string => {
      switch (skew.kind) {
        case "same":
          return "same"
        case "reader-behind":
          return `behind by ${skew.declared - skew.compiled}`
        case "frame-behind":
          return `ahead by ${skew.compiled - skew.declared}`
      }
    }
    expect(describeSkew(classifyJournalFrameVersion(3, 5))).toBe("behind by 2")
    expect(describeSkew(classifyJournalFrameVersion(3, 1))).toBe("ahead by 2")
  })

  it("reads a frame's own declaration through that one decision point", () => {
    expect(journalFrameSkew(frame(AHEAD))).toEqual({
      kind: "reader-behind",
      compiled: JOURNAL_READER_VERSION,
      declared: AHEAD,
    })
    expect(journalFrameSkew(frame(JOURNAL_READER_VERSION)).kind).toBe("same")
    expect(journalFrameSkew(frame()).kind).toBe("frame-behind")
  })

  it("degrades to a non-blocking state for a frame ahead of this reader that it can still read", () => {
    const value = frame(AHEAD)

    expect(journalFrameSkew(value).kind).toBe("reader-behind")
    const parsed = parseJournalFrame(value)
    expect(parsed.compatibility).toEqual({ version: AHEAD })
    expect(parsed.events).toMatchObject([{ name: "test/recorded", data: { text: "hello" } }])
  })

  it("still reads frames behind this reader, and unstamped ones", () => {
    expect(parseJournalFrame(frame(1)).compatibility).toEqual({ version: 1 })
    expect(parseJournalFrame(frame()).compatibility).toBeUndefined()
  })

  it("refuses a frame ahead of this reader whose envelope it cannot satisfy, naming both versions and the remedy", () => {
    const value = frame(AHEAD, { provenance: { writer: "a newer build" } })

    expect(() => parseJournalFrame(value)).toThrow(
      new RegExp(`v${AHEAD}.*compiled capability v${JOURNAL_READER_VERSION}.*provenance.*update this checkout`, "isu"),
    )
    try {
      parseJournalFrame(value)
      expect.unreachable("a frame this reader cannot use must refuse")
    } catch (error) {
      expect(error).toMatchObject({ failure: { kind: "refusal", code: "journal-version-skew" } })
    }
  })

  it("does not blame the version for a frame that is broken at this reader's own version", () => {
    const value = frame(JOURNAL_READER_VERSION, { provenance: {} })

    expect(() => parseJournalFrame(value)).toThrow()
    try {
      parseJournalFrame(value)
      expect.unreachable("a malformed frame must still fail")
    } catch (error) {
      expect(error).not.toMatchObject({ failure: { code: "journal-version-skew" } })
    }
  })

  it("classifies a compatibility object's own shape growth as skew, not a raw ZodError, and names the unrecognized key", () => {
    // Regression for the residue of frame-vocabulary-skew-degrades: a compatibility
    // object with an extra key beside `version` (e.g. written by a newer yrd) used
    // to die as a raw ZodError out of `journalFrameSkew`, before classification ever
    // ran. Existing tests never cover this because `frame()` only ever produces a
    // well-formed `{ version }` compatibility object.
    const value = { ...frame(), compatibility: { version: AHEAD, requires: ["some-capability"] } }

    expect(journalFrameSkew(value)).toEqual({
      kind: "reader-behind",
      compiled: JOURNAL_READER_VERSION,
      declared: AHEAD,
    })
    expect(() => parseJournalFrame(value)).toThrow(
      new RegExp(`v${AHEAD}.*compiled capability v${JOURNAL_READER_VERSION}.*requires.*update this checkout`, "isu"),
    )
    try {
      parseJournalFrame(value)
      expect.unreachable("a compatibility object this reader cannot read must refuse, not throw a raw ZodError")
    } catch (error) {
      expect(error).toMatchObject({ failure: { kind: "refusal", code: "journal-version-skew" } })
    }
  })

  it("does not blame skew for an unrecognized compatibility key at this reader's own version", () => {
    // Companion to the case above: the same shape defect at (or below) this
    // reader's own compiled version is an ordinary malformed frame, not a fleet
    // version spread, so it must not be sent through the skew refusal — that
    // would send the operator to upgrade a checkout that was never the problem.
    const value = { ...frame(), compatibility: { version: JOURNAL_READER_VERSION, requires: ["some-capability"] } }

    expect(journalFrameSkew(value).kind).toBe("same")
    expect(() => parseJournalFrame(value)).toThrow()
    try {
      parseJournalFrame(value)
      expect.unreachable("a malformed compatibility object must still fail")
    } catch (error) {
      expect(error).not.toMatchObject({ failure: { code: "journal-version-skew" } })
    }
  })

  it("keeps no site branching on the compiled/declared pair outside the classifier", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const packagesRoot = join(here, "..", "..")
    const classifier = join(packagesRoot, "yrd-core", "src", "frame.ts")

    const sources: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          if (entry === "node_modules" || entry === "dist" || entry === "tests") continue
          walk(path)
        } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
          sources.push(path)
        }
      }
    }
    walk(packagesRoot)
    expect(sources).toContain(classifier)

    // The pair is (this reader's compiled capability, a frame's declared
    // version). `journal_version_floor` against a frame's requirement is a
    // different pair — the journal's own coordination bound, not this reader's
    // vocabulary — and is deliberately not covered here.
    const branches =
      /(?:[<>]=?\s*(?:JOURNAL_READER_VERSION|compatibility\.version)|(?:JOURNAL_READER_VERSION|compatibility\.version)\s*[<>]=?)/u
    const offenders = sources
      .filter((path) => path !== classifier)
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            branches.test(line) ? [`${relative(packagesRoot, path)}:${index + 1}: ${line.trim()}`] : [],
          ),
      )

    expect(offenders).toEqual([])
  })
})
