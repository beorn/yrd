import * as z from "zod"
import { CauseSchema, Command, CommandSchema, EventSchema, JsonSchema } from "./domain.ts"
import { freeze } from "./immutable.ts"

const JournalFrameSchema = z
  .object({
    cause: CauseSchema,
    command: CommandSchema,
    events: z.array(EventSchema),
    value: JsonSchema.optional(),
  })
  .strict()

export type JournalFrame = z.infer<typeof JournalFrameSchema>

export function parseJournalFrame(value: unknown): JournalFrame {
  const frame = JournalFrameSchema.parse(value)
  Command.assertCause(frame.command, frame.cause)
  return freeze(frame) as JournalFrame
}
