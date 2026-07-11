import { createHash } from "node:crypto"
import canonicalize from "canonicalize"
import * as z from "zod"
import { freeze } from "./immutable.ts"

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>

export const JsonSchema: z.ZodType<JsonValue> = z.json()
const UUIDv7Schema = z.uuidv7()

export const CommandInputSchema = z
  .object({
    id: UUIDv7Schema.optional(),
    op: z.string().min(1),
    args: JsonSchema.optional(),
  })
  .strict()
export type CommandInput<Args extends JsonValue | undefined = JsonValue | undefined> = Readonly<
  [Args] extends [undefined] ? { id?: string; op: string } : { id?: string; op: string; args?: Args }
>

export const CommandSchema = CommandInputSchema.extend({ id: UUIDv7Schema }).strict()
export type Command<Args extends JsonValue | undefined = JsonValue | undefined> = Readonly<
  [Args] extends [undefined] ? { id: string; op: string } : { id: string; op: string; args?: Args }
>

export const CauseSchema = z
  .object({
    id: UUIDv7Schema,
    commandId: UUIDv7Schema,
    op: z.string().min(1),
    commandHash: z.string().regex(/^[0-9a-f]{64}$/),
    key: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
    spanId: z.string().min(1).optional(),
  })
  .strict()
export type Cause = z.infer<typeof CauseSchema>

export const EventSchema = z
  .object({
    id: UUIDv7Schema,
    name: z.string().min(1),
    ts: z.iso.datetime({ offset: true }),
    data: JsonSchema,
  })
  .strict()
export type Event = z.infer<typeof EventSchema>

export type EventDraft<Name extends string = string, Data extends JsonValue = JsonValue> = Readonly<{
  name: Name
  data: Data
}>

export type CommandResult = Readonly<{
  command: Command
  events: readonly Event[]
  value?: JsonValue
}>

export const Command = Object.freeze({
  parse(value: unknown) {
    return freeze(CommandSchema.parse(value)) as Command
  },
  hash(value: CommandInput) {
    const command = CommandInputSchema.parse(value)
    const intent = command.args === undefined ? { op: command.op } : { op: command.op, args: command.args }
    const encoded = canonicalize(intent)
    if (encoded === undefined) throw new TypeError("yrd: command must be canonical JSON data")
    return createHash("sha256").update(encoded).digest("hex")
  },
  assertCause(command: Command, cause: Cause): void {
    if (cause.commandId !== command.id || cause.op !== command.op) {
      throw new Error("yrd: command cause does not match its command")
    }
    if (cause.commandHash !== Command.hash(command)) {
      throw new Error("yrd: command hash does not match its command")
    }
  },
})

export function event<Name extends string, Data extends JsonValue>(name: Name, data: Data): EventDraft<Name, Data> {
  if (name.length === 0) throw new TypeError("yrd: event name must not be empty")
  return freeze({ name, data: JsonSchema.parse(data) as Data }) as EventDraft<Name, Data>
}
