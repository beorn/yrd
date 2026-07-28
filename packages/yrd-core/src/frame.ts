import * as z from "zod"
import { CauseSchema, Command, CommandSchema, EventSchema, JsonSchema } from "./domain.ts"
import { raiseFailure } from "./failure.ts"
import { freeze } from "./immutable.ts"

export const JOURNAL_READER_VERSION = 2

export const JournalCompatibilitySchema = z
  .object({
    version: z.number().int().min(1),
    reader: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
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
      `yrd: journal schema v${compatibility.version} requires reader pin ${compatibility.reader}; this reader supports through v${JOURNAL_READER_VERSION}`,
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
