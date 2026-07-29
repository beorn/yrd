import * as z from "zod"
import { CauseSchema, Command, CommandSchema, EventSchema, JsonSchema } from "./domain.ts"
import { raiseFailure } from "./failure.ts"
import { freeze } from "./immutable.ts"

/** Journal versions this reader understands. The code is the capability
 * authority; repositories never pin reader commits in consumer config. */
export const SUPPORTED_VERSIONS = Object.freeze([1, 2] as const)
export const JOURNAL_READER_VERSION = SUPPORTED_VERSIONS.at(-1) ?? 0

export const JournalCompatibilitySchema = z
  .object({
    version: z.number().int().min(1),
  })
  .strict()

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

export function assertJournalReaderCompatibility(value: unknown): JournalCompatibility | undefined {
  const compatibility = journalFrameCompatibility(value)
  if (compatibility !== undefined && compatibility.version > JOURNAL_READER_VERSION) {
    raiseFailure(
      "refusal",
      "journal-version-skew",
      `yrd: journal schema v${compatibility.version} exceeds this reader's compiled capability v${JOURNAL_READER_VERSION}`,
    )
  }
  return compatibility
}

export function parseJournalFrame(value: unknown): JournalFrame {
  assertJournalReaderCompatibility(value)
  const frame = JournalFrameSchema.parse(value)
  Command.assertCause(frame.command, frame.cause)
  return freeze(frame) as JournalFrame
}
