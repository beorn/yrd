import * as z from "zod"
import { CauseSchema, Command, CommandSchema, EventSchema, JsonSchema } from "./domain.ts"
import { raiseFailure } from "./failure.ts"
import { freeze } from "./immutable.ts"

/** Journal versions this reader understands. The code is the capability
 * authority; repositories never pin reader commits in consumer config. */
export const SUPPORTED_VERSIONS = Object.freeze([1, 2, 3] as const)
export const JOURNAL_READER_VERSION = SUPPORTED_VERSIONS.at(-1) ?? 0

/**
 * How one journal frame's declared vocabulary version stands against the one
 * the reading process compiled against.
 *
 * This is the FRAME axis. The SQLite `user_version` axis is a different fact
 * with its own decision point, `classifyJournalSchema`, and the two must not be
 * confused: the incident of 2026-08-17 quoted this axis's message while the fix
 * that followed moved the other one, which is why the same spread could still
 * stop the fleet afterwards.
 *
 * The tolerated direction is the opposite of the SQLite axis's, and the reason
 * is that a frame is DATA, not structure. `frame-behind` — a frame older than
 * this reader — has always been readable, and saying so is the whole content of
 * `SUPPORTED_VERSIONS`. `reader-behind` — a frame newer than this reader — is
 * the direction that used to refuse outright, and refusing it is what an
 * ordinary version spread across the fleet's checkouts turns into a fleet-wide
 * stop: every verb replays the journal, every replay parses every frame, so ONE
 * frame from ONE newer writer refused `pr submit` from every tree at once.
 *
 * A declared version is therefore no longer the gate. It cannot be: it says
 * only that the writer knew more words, never that this read needed any of
 * them. What gates is this reader's own parse — see {@link parseJournalFrame} —
 * and the classification is what turns a parse this reader cannot satisfy into
 * a refusal that names the skew instead of a bare schema error.
 *
 * Converging the trees themselves is a separate job and deliberately not
 * attempted here: it belongs to `@i/10-yrd/git-super-one-layer` work package B.
 * This makes the spread survivable; it does not close it.
 */
export type JournalFrameSkew =
  | Readonly<{ kind: "same"; compiled: number; declared: number }>
  | Readonly<{ kind: "reader-behind"; compiled: number; declared: number }>
  | Readonly<{ kind: "frame-behind"; compiled: number; declared: number }>

/**
 * The one decision point for a `(compiled, declared)` pair on the frame axis.
 * Every site that weighs a frame vocabulary version against a capability routes
 * through here — frame parse, checkpoint parse, event-definition validation,
 * the writer's own version, and the journal's stored version floor — so no site
 * carries its own comparison and the tolerated direction cannot drift.
 *
 * A frame written before the compatibility stamp declares nothing, and reads as
 * version 0: `initialJournalVersionFloor` already folds an absent stamp to 0,
 * so this keeps one reading of an unstamped frame rather than adding a second.
 */
export function classifyJournalFrameVersion(compiled: number, declared: number | undefined): JournalFrameSkew {
  const version = declared ?? 0
  if (version === compiled) return { kind: "same", compiled, declared: version }
  if (version > compiled) return { kind: "reader-behind", compiled, declared: version }
  return { kind: "frame-behind", compiled, declared: version }
}

export const JournalCompatibilitySchema = z
  .object({
    version: z.number().int().min(1),
    /** Retired by the compiled-capability cutover. Existing immutable frames
     * still carry the pin, so validate and discard it while replaying them. */
    reader: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
      .optional(),
  })
  .strict()
  .transform(({ version }) => ({ version }))

export type JournalCompatibility = Readonly<z.infer<typeof JournalCompatibilitySchema>>

const JournalFrameSchema = z
  .object({
    cause: CauseSchema,
    command: CommandSchema,
    events: z.array(EventSchema),
    value: JsonSchema.optional(),
    compatibility: JournalCompatibilitySchema.optional(),
  })
  .strict()

export type JournalFrame = z.infer<typeof JournalFrameSchema>

export function journalFrameCompatibility(value: unknown): JournalCompatibility | undefined {
  if (typeof value !== "object" || value === null || !("compatibility" in value)) return undefined
  return JournalCompatibilitySchema.parse(value.compatibility)
}

/**
 * A lenient read of a frame-shaped value's declared compatibility version. It
 * never throws: an object whose `compatibility.version` is a positive integer
 * reads that version; everything else — an absent stamp, a non-object
 * compatibility, a non-integer or non-positive version, an unrecognized key
 * sitting beside an otherwise well-formed version — reads as undefined,
 * exactly like an absent stamp (`classifyJournalFrameVersion` folds that to
 * declared version 0).
 *
 * This is deliberately looser than {@link JournalCompatibilitySchema}: the
 * declared version is only ever the EXPLANATION for a parse this reader
 * cannot satisfy, never itself a trigger for one — see the doc comment on
 * {@link parseJournalFrame}. Any other shape defect, including an
 * unrecognized key, is left for each caller's own strict schema to reject, so
 * it is classified there instead of raised here as a bare `ZodError` ahead of
 * that decision.
 *
 * Exported so every site that needs a version out of a not-yet-validated
 * compatibility object reads it through this one derive-at-read path, rather
 * than each growing its own lenient reader. {@link journalFrameSkew} is the
 * skew-classifying consumer; `initialJournalVersionFloor` (yrd-persistence)
 * is a non-classifying one — a raw legacy row's floor contribution, never a
 * reason by itself to refuse the row.
 */
export function declaredJournalFrameVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("compatibility" in value)) return undefined
  const compatibility = (value as { compatibility: unknown }).compatibility
  if (typeof compatibility !== "object" || compatibility === null) return undefined
  const version = (compatibility as { version?: unknown }).version
  return typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : undefined
}

/** How one frame value's own declaration stands against this reader. Reads
 * leniently — see {@link declaredJournalFrameVersion} — so a defect in the
 * compatibility object's own shape is classified by the strict frame schema
 * in {@link parseJournalFrame}, never thrown here ahead of that decision. */
export function journalFrameSkew(value: unknown): JournalFrameSkew {
  return classifyJournalFrameVersion(JOURNAL_READER_VERSION, declaredJournalFrameVersion(value))
}

/**
 * The refusal a reader owes when it genuinely cannot use a frame newer than
 * itself: both versions, what it choked on, and the one move that fixes it.
 *
 * `detail` is the reader's own reason, so the message says which word it did
 * not know rather than leaving the operator to guess which of a version's many
 * additions was the one in the way.
 */
export function raiseJournalFrameSkew(skew: JournalFrameSkew, detail: string): never {
  raiseFailure(
    "refusal",
    "journal-version-skew",
    `yrd: journal schema v${skew.declared} exceeds this reader's compiled capability v${skew.compiled} ` +
      `and this frame needs the difference (${detail}). ` +
      `Update this checkout to a build that reads v${skew.declared}, then retry.`,
  )
}

/**
 * Parse one journal frame, degrading across an ordinary version spread.
 *
 * A frame newer than this reader is read whenever this reader's own vocabulary
 * still covers it — the realistic shape of a version bump is a new event name
 * or a new payload field, and both survive this envelope untouched, with the
 * unknown names quarantined downstream by `canonicalEvent` and surfaced by
 * `unknownEventNames()`. Only a frame this reader cannot satisfy refuses, and
 * then the version is the EXPLANATION for the failed parse, never the trigger:
 * a frame malformed at this reader's own version still fails as the schema
 * error it is, because blaming the skew for it would send the operator to
 * upgrade a checkout that was never the problem.
 *
 * Degrading quietly here is not a quiet error: nothing was dropped. The read
 * that DOES lose something — an event whose name this reader has never heard —
 * is reported by `unknownEventNames()` and logged once by replay, and the read
 * that cannot proceed refuses above. What is left is a frame this reader
 * understood completely, which has nothing to announce.
 */
export function parseJournalFrame(value: unknown): JournalFrame {
  const skew = journalFrameSkew(value)
  const parsed = JournalFrameSchema.safeParse(value)
  if (!parsed.success) {
    if (skew.kind === "reader-behind") {
      raiseJournalFrameSkew(skew, parsed.error.issues.map((issue) => issue.message).join("; "))
    }
    throw parsed.error
  }
  Command.assertCause(parsed.data.command, parsed.data.cause)
  return freeze(parsed.data) as JournalFrame
}
