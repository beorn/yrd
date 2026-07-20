import { event, JsonSchema, type EventDraft, type JsonValue, type YrdDeliveryIdentity } from "@yrd/core"
import * as z from "zod"

const NameSchema = z.string().trim().min(1)

export const JobErrorSchema = z
  .object({
    code: NameSchema,
    message: z.string().min(1),
    evidence: JsonSchema.optional(),
  })
  .strict()
export type JobError = z.infer<typeof JobErrorSchema>

export const JobWaitingSchema = z
  .object({
    status: z.literal("waiting"),
    token: NameSchema,
    url: z.string().min(1).optional(),
    detail: z.string().optional(),
    artifacts: z.array(JsonSchema).optional(),
    checkpoint: JsonSchema.optional(),
  })
  .strict()
export type JobWaiting = z.infer<typeof JobWaitingSchema>

export const JobLaunchSchema = JobWaitingSchema.omit({ status: true, checkpoint: true })
export type JobLaunch = z.infer<typeof JobLaunchSchema>

export function parseJobLaunch(stdout: string): JobLaunch {
  for (const entry of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      return JobLaunchSchema.parse(JSON.parse(entry))
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
  throw new Error("waiting job launcher must print a JSON object containing token")
}

export type JobResult<Output extends JsonValue = JsonValue> =
  | Readonly<{ status: "completed"; conclusion: "success"; output: Output }>
  | Readonly<{ status: "completed"; conclusion: "failure"; error: JobError; output?: Output }>
  | JobWaiting

export type JobConclusion = "success" | "failure" | "cancelled" | "skipped" | "timed_out"
export type JobStatus = "queued" | "in_progress" | "waiting" | "completed"

export type ContextReq = Readonly<{
  scope: "job" | "run" | "session" | "shared"
  candidate: "none" | "ro" | "rw"
  capabilities?: readonly string[]
}>

/** Ephemeral runtime materialization. Only its identity is persisted on the
 * Job; paths and capabilities belong to the live Runner process. */
export type RuntimeContext = Readonly<{
  id: string
  request: ContextReq
  candidateRef?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}>

export type JobContext = Readonly<{
  id: string
  attempt: number
  runner: string
  context?: RuntimeContext
  /** Aborts when this execution loses ownership or its runtime closes. */
  signal: AbortSignal
  /** Select progress-gated lease renewal for an execution with observable work. */
  observeProgress?: () => void
  /** Record one observed unit of progress after progress-gated renewal is selected. */
  reportProgress?: () => void
}>

export type JobHandler<Input extends JsonValue, Output extends JsonValue> = (
  input: Input,
  context: JobContext,
) => JobResult<Output> | Promise<JobResult<Output>>

export type JobRequest<Input extends JsonValue = JsonValue> = Readonly<{
  definition: string
  revision: string
  input: Input
  key?: string
}>

/** An installed Job definition may project its typed domain input into the
 * shared lifecycle vocabulary. Generic Jobs never inspect opaque input. */
export type JobObservation = Readonly<{
  lifecycle?: string
  identity?: YrdDeliveryIdentity
  attributes?: Readonly<Record<string, unknown>>
}>

export const JobRequestSchema = z
  .object({
    definition: NameSchema,
    revision: NameSchema,
    input: JsonSchema,
    key: NameSchema.optional(),
  })
  .strict()

export type JobDef<Input extends JsonValue = JsonValue, Output extends JsonValue = JsonValue> = Readonly<{
  name: string
  title: string
  revision: string
  input: z.ZodType<Input>
  output: z.ZodType<Output>
  observe?(input: Input): JobObservation
  execute(input: Input, context: JobContext): Promise<JobResult<Output>>
  request(input: Input, options?: Readonly<{ key?: string }>): EventDraft<"job/requested", JobRequest<Input>>
}>

export type CreateJobDefOptions<Input extends JsonValue, Output extends JsonValue> = Readonly<{
  name: string
  title?: string
  revision: string
  input: z.ZodType<Input>
  output: z.ZodType<Output>
  observe?(input: Input): JobObservation
  execute: JobHandler<Input, Output>
}>

const JobDefMetadataSchema = z
  .object({
    name: NameSchema,
    title: z.string().trim().min(1).optional(),
    revision: NameSchema,
  })
  .strict()

const JobRequestOptionsSchema = z.object({ key: NameSchema.optional() }).strict()

export function createJobDef<Input extends JsonValue, Output extends JsonValue>(
  options: CreateJobDefOptions<Input, Output>,
): JobDef<Input, Output> {
  const metadata = JobDefMetadataSchema.parse({
    name: options.name,
    title: options.title,
    revision: options.revision,
  })
  const result = jobResultSchema(options.output)

  return Object.freeze({
    ...metadata,
    title: metadata.title ?? metadata.name,
    input: options.input,
    output: options.output,

    observe(input) {
      const parsedInput = options.input.parse(input)
      return Object.freeze(options.observe?.(parsedInput) ?? {})
    },

    async execute(input, context) {
      const parsedInput = options.input.parse(input)
      return result.parse(await options.execute(parsedInput, context)) as JobResult<Output>
    },

    request(input, requestOptions) {
      const parsedOptions = JobRequestOptionsSchema.parse(requestOptions ?? {})
      return event(
        "job/requested",
        JobRequestSchema.parse({
          definition: metadata.name,
          revision: metadata.revision,
          input: options.input.parse(input),
          ...parsedOptions,
        }),
      ) as EventDraft<"job/requested", JobRequest<Input>>
    },
  })
}

export function jobResultSchema<Output extends JsonValue>(output: z.ZodType<Output>) {
  return z.union([jobTerminalResultSchema(output), JobWaitingSchema])
}

export function jobTerminalResultSchema<Output extends JsonValue>(output: z.ZodType<Output>) {
  return z.discriminatedUnion("conclusion", [
    z.object({ status: z.literal("completed"), conclusion: z.literal("success"), output }).strict(),
    z
      .object({
        status: z.literal("completed"),
        conclusion: z.literal("failure"),
        error: JobErrorSchema,
        output: output.optional(),
      })
      .strict(),
  ])
}
