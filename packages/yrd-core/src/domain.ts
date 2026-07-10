import { createHash } from "node:crypto"
import canonicalize from "canonicalize"
import * as z from "zod"
import { freeze } from "./immutable.ts"

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>

export const JsonSchema: z.ZodType<JsonValue> = z.json()

export const OperationSchema = z
  .object({
    op: z.string().min(1),
    args: JsonSchema.optional(),
  })
  .strict()
export type Operation<Args extends JsonValue | undefined = JsonValue | undefined> = Readonly<
  [Args] extends [undefined] ? { op: string } : { op: string; args?: Args }
>

export const CauseSchema = z
  .object({
    commandId: z.string().min(1),
    op: z.string().min(1),
    operationHash: z.string().regex(/^[0-9a-f]{64}$/),
    traceId: z.string().min(1).optional(),
    spanId: z.string().min(1).optional(),
  })
  .strict()
export type Cause = z.infer<typeof CauseSchema>

export const EventSchema = z
  .object({
    id: z.string().min(1),
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

export const FrameSchema = z
  .object({
    cause: CauseSchema,
    events: z.array(EventSchema),
  })
  .strict()
export type Frame = z.infer<typeof FrameSchema>

export const Operation = Object.freeze({
  parse(value: unknown) {
    return freeze(OperationSchema.parse(value)) as Operation
  },
  hash(value: Operation) {
    const encoded = canonicalize(value)
    if (encoded === undefined) throw new TypeError("yrd: operation must be canonical JSON data")
    return createHash("sha256").update(encoded).digest("hex")
  },
})

export const Frame = Object.freeze({
  parse(value: unknown) {
    return freeze(FrameSchema.parse(value)) as Frame
  },
})

export function event<Name extends string, Data extends JsonValue>(name: Name, data: Data): EventDraft<Name, Data> {
  if (name.length === 0) throw new TypeError("yrd: event name must not be empty")
  return freeze({ name, data: JsonSchema.parse(data) as Data }) as EventDraft<Name, Data>
}
