import {
  command,
  event,
  journalEvent,
  raiseFailure,
  resolveSelector,
  type CommandTree,
  type DeepReadonly,
  type Event,
  type EventDraft,
  type YrdDef,
} from "@yrd/core"
import type { IssueRef } from "@yrd/issue"
import * as z from "zod"
import {
  IntentSubmitArgsSchema,
  IntentWithdrawArgsSchema,
  PIN_INTENT_SCHEMA,
  PIN_TOMBSTONE_SCHEMA,
  PinIntentEvaluationFactSchema,
  PinIntentIntegratedFactSchema,
  PinTombstoneArgsSchema,
  PinTombstoneSchema,
  PinIntentSchema,
  INTENT_ID_PREFIX,
  TERMINAL_INTENT_STATUSES,
  TOMBSTONE_ID_PREFIX,
  intentFingerprint,
  intentIdNumber,
  intentKey,
  recordFingerprint,
  tombstoneIdNumber,
  type HasIntents,
  type IntentSubmitArgs,
  type Intents,
  type IntentsState,
  type PinIntent,
  type PinTombstone,
  type PinTombstoneArgs,
} from "./types.ts"

const AdmittedSchema = PinIntentSchema.omit({ submittedAt: true, status: true }).strict()
const SupersededSchema = z.object({ intent: z.string(), by: z.string() }).strict()
const WithdrawnSchema = z.object({ intent: z.string(), reason: z.string().trim().min(1).optional() }).strict()
const TombstonedSchema = PinTombstoneSchema.omit({ recordedAt: true }).strict()

type IntentState = Readonly<{ intents: IntentsState }>
type IntentRuntimeState = DeepReadonly<IntentState>
export type IntentCommands = Readonly<{
  intent: Readonly<{
    submit: ReturnType<typeof buildSubmitCommand>
    tombstone: ReturnType<typeof buildTombstoneCommand>
    withdraw: ReturnType<typeof buildWithdrawCommand>
  }>
}>

const INITIAL_STATE: IntentsState = { records: {}, order: [], tombstoneRecords: {}, tombstoneOrder: [] }

/**
 * PinIntentV1 records: "advance component X to S for issue I", declared instead
 * of hand-authored as a gitlink carrier commit.
 *
 * Queue consumes open records in the same submission-time FIFO as code PRs.
 * Evaluation and every terminal disposition remain journal events projected
 * through this one record model; there is no side status store.
 */
export function withIntents() {
  const commands = createIntentCommands()

  return <State extends object, Commands extends CommandTree, Features extends object>(
    definition: YrdDef<State, Commands, Features>,
  ): YrdDef<State & IntentState, Commands & IntentCommands, Features & HasIntents> =>
    definition.extend({
      initialState: { intents: INITIAL_STATE },
      commands,
      events: {
        "intent/submitted": journalEvent(1, AdmittedSchema),
        "intent/superseded": journalEvent(1, SupersededSchema),
        "intent/withdrawn": journalEvent(1, WithdrawnSchema),
        "intent/pin-tombstoned": journalEvent(1, TombstonedSchema),
        "intent/integrated": journalEvent(1, PinIntentIntegratedFactSchema),
        "intent/evaluation-recorded": journalEvent(1, PinIntentEvaluationFactSchema),
      },
      projectionVersion: "intents-v2",
      project: projectIntents,
      create(yrd) {
        const state = (): IntentsState => (yrd.state() as unknown as IntentState).intents
        const intents: Intents = {
          async submit(args) {
            const parsed = IntentSubmitArgsSchema.parse(args)
            await yrd.dispatch(commands.intent.submit, parsed)
            const record = byIntentId(state(), parsed.intentId)
            if (record === undefined) {
              raiseFailure(
                "infrastructure",
                "intent-admission-lost",
                `yrd: intent '${parsed.intentId}' was not accepted`,
              )
            }
            return record
          },
          async tombstone(args) {
            const parsed = PinTombstoneArgsSchema.parse(args)
            await yrd.dispatch(commands.intent.tombstone, parsed)
            const record = byTombstoneId(state(), parsed.tombstoneId)
            if (record === undefined) {
              raiseFailure(
                "infrastructure",
                "intent-tombstone-lost",
                `yrd: pin tombstone '${parsed.tombstoneId}' was not recorded`,
              )
            }
            return record
          },
          async withdraw(intent, reason) {
            // Resolve before dispatch: the command applies against the stored
            // key, so a bare-number selector must become one here.
            const selected = bySelector(state(), intent)
            const id = selected?.id ?? intent
            await yrd.dispatch(commands.intent.withdraw, {
              intent: id,
              ...(reason === undefined ? {} : { reason }),
            })
            const record = state().records[id]
            if (record === undefined) {
              raiseFailure("infrastructure", "intent-withdrawal-lost", `yrd: intent '${intent}' was not closed`)
            }
            return record
          },
          get: (intent) => bySelector(state(), intent),
          live: (issue, component) => liveIntent(state(), issue, component),
          list: () => ordered(state()),
          queued: () => ordered(state()).filter((record) => !TERMINAL_INTENT_STATUSES.has(record.status)),
          tombstones: (component) =>
            orderedTombstones(state()).filter((record) => component === undefined || record.component === component),
        }
        return { intents } satisfies HasIntents
      },
    }) as YrdDef<State & IntentState, Commands & IntentCommands, Features & HasIntents>
}

function createIntentCommands(): IntentCommands {
  return {
    intent: {
      submit: buildSubmitCommand(),
      tombstone: buildTombstoneCommand(),
      withdraw: buildWithdrawCommand(),
    },
  }
}

function buildSubmitCommand() {
  return command({
    title: "Submit a pin-advance intent",
    visibility: "public",
    params: IntentSubmitArgsSchema,
    apply(state: IntentRuntimeState, args: IntentSubmitArgs) {
      const existing = byIntentId(state.intents, args.intentId)
      if (existing !== undefined) {
        // Idempotent replay. A superseded record replays as itself and NEVER
        // re-opens its key: a retried submit cannot clobber a newer intent.
        if (recordFingerprint(existing) !== intentFingerprint(args)) {
          raiseFailure(
            "refusal",
            "intent-fingerprint-conflict",
            `yrd: intent '${args.intentId}' was already accepted as '${existing.id}' with different terms`,
          )
        }
        return { events: [] }
      }

      const events: EventDraft[] = []
      const id = nextIntentId(state.intents.records)
      // Supersession applies to the OPEN record only. A terminal record keeps
      // its disposition — a refusal and its remedy stay on the attention rail.
      const superseded = liveIntent(state.intents, args.issue, args.component)
      if (superseded !== undefined && superseded.submitter !== args.submitter && args.forceSupersede !== true) {
        raiseFailure(
          "refusal",
          "intent-supersede-consent-required",
          `yrd: live intent '${superseded.id}' belongs to '${superseded.submitter}'; close it or resubmit with --force`,
        )
      }
      if (superseded !== undefined) events.push(event("intent/superseded", { intent: superseded.id, by: id }))
      events.push(
        event("intent/submitted", {
          schema: PIN_INTENT_SCHEMA,
          id,
          intentId: args.intentId,
          issue: args.issue,
          component: args.component,
          ...(args.target === undefined ? {} : { target: args.target }),
          preconditions: {
            targetPublished: true,
            targetDescendsFromCurrentPin: true,
            ...(args.allowOffTrunk === true ? { allowOffTrunk: true } : {}),
            ...(args.expectedCurrentPin === undefined ? {} : { expectedCurrentPin: args.expectedCurrentPin }),
          },
          submitter: args.submitter,
          ...(superseded === undefined
            ? {}
            : {
                supersededIntent: superseded.id,
                supersedeConsent: superseded.submitter === args.submitter ? "same-submitter" : "forced",
              }),
        }),
      )
      return { events }
    },
  })
}

function buildTombstoneCommand() {
  return command({
    title: "Record a rolled-back component pin",
    visibility: "public",
    params: PinTombstoneArgsSchema,
    apply(state: IntentRuntimeState, args: PinTombstoneArgs) {
      const existing = byTombstoneId(state.intents, args.tombstoneId)
      if (existing !== undefined) {
        if (tombstoneFingerprint(existing) !== tombstoneFingerprint(args)) {
          raiseFailure(
            "refusal",
            "intent-tombstone-fingerprint-conflict",
            `yrd: pin tombstone '${args.tombstoneId}' already exists with different terms`,
          )
        }
        return { events: [] }
      }
      return {
        events: [
          event("intent/pin-tombstoned", {
            schema: PIN_TOMBSTONE_SCHEMA,
            id: nextTombstoneId(state.intents.tombstoneRecords),
            tombstoneId: args.tombstoneId,
            issue: args.issue,
            component: args.component,
            sha: args.sha,
            submitter: args.submitter,
            ...(args.reason === undefined ? {} : { reason: args.reason }),
          }),
        ],
      }
    },
  })
}

function buildWithdrawCommand() {
  return command({
    title: "Withdraw a pin-advance intent",
    visibility: "public",
    params: IntentWithdrawArgsSchema,
    apply(state: IntentRuntimeState, args: z.infer<typeof IntentWithdrawArgsSchema>) {
      const record = state.intents.records[args.intent]
      if (record === undefined) {
        raiseFailure("refusal", "intent-not-found", `yrd: no intent '${args.intent}'`)
      }
      if (TERMINAL_INTENT_STATUSES.has(record.status)) {
        raiseFailure(
          "refusal",
          "intent-terminal",
          `yrd: intent '${record.id}' is already ${record.status}; nothing to close`,
        )
      }
      return {
        events: [
          event("intent/withdrawn", {
            intent: record.id,
            ...(args.reason === undefined ? {} : { reason: args.reason }),
          }),
        ],
      }
    },
  })
}

function projectIntents(state: DeepReadonly<IntentState>, applied: Event): IntentState {
  if (applied.name === "intent/submitted") {
    const admitted = AdmittedSchema.parse(applied.data)
    if (state.intents.records[admitted.id] !== undefined) {
      throw new Error(`yrd: duplicate intent '${admitted.id}'`)
    }
    const record = PinIntentSchema.parse({ ...admitted, submittedAt: applied.ts, status: "open" })
    return {
      intents: {
        records: { ...(state.intents.records as Record<string, PinIntent>), [record.id]: record },
        order: [...state.intents.order, record.id],
        tombstoneRecords: { ...(state.intents.tombstoneRecords as Record<string, PinTombstone>) },
        tombstoneOrder: [...state.intents.tombstoneOrder],
      },
    }
  }
  if (applied.name === "intent/superseded") {
    const superseded = SupersededSchema.parse(applied.data)
    const record = state.intents.records[superseded.intent]
    if (record === undefined || TERMINAL_INTENT_STATUSES.has(record.status)) return state as IntentState
    return replaceIntent(state, { ...(record as PinIntent), status: "superseded", supersededBy: superseded.by })
  }
  if (applied.name === "intent/withdrawn") {
    const withdrawn = WithdrawnSchema.parse(applied.data)
    const record = state.intents.records[withdrawn.intent]
    if (record === undefined || TERMINAL_INTENT_STATUSES.has(record.status)) return state as IntentState
    return replaceIntent(state, {
      ...(record as PinIntent),
      status: "withdrawn",
      disposition: {
        code: "intent-withdrawn",
        at: applied.ts,
        ...(withdrawn.reason === undefined ? {} : { reason: withdrawn.reason }),
      },
    })
  }
  if (applied.name === "intent/pin-tombstoned") {
    const tombstoned = TombstonedSchema.parse(applied.data)
    if (state.intents.tombstoneRecords[tombstoned.id] !== undefined) {
      throw new Error(`yrd: duplicate pin tombstone '${tombstoned.id}'`)
    }
    const record = PinTombstoneSchema.parse({ ...tombstoned, recordedAt: applied.ts })
    return {
      intents: {
        records: { ...(state.intents.records as Record<string, PinIntent>) },
        order: [...state.intents.order],
        tombstoneRecords: {
          ...(state.intents.tombstoneRecords as Record<string, PinTombstone>),
          [record.id]: record,
        },
        tombstoneOrder: [...state.intents.tombstoneOrder, record.id],
      },
    }
  }
  if (applied.name === "intent/integrated") {
    const integrated = PinIntentIntegratedFactSchema.parse(applied.data)
    const record = state.intents.records[integrated.intent]
    if (record === undefined) throw new Error(`yrd: integration names missing intent '${integrated.intent}'`)
    if (TERMINAL_INTENT_STATUSES.has(record.status)) {
      throw new Error(`yrd: integration names terminal intent '${record.id}' (${record.status})`)
    }
    if (
      integrated.authored.intentId !== record.intentId ||
      integrated.authored.issue.source !== record.issue.source ||
      integrated.authored.issue.id !== record.issue.id ||
      integrated.authored.component !== record.component ||
      integrated.authored.target !== record.target
    ) {
      throw new Error(`yrd: integration lineage does not match authored intent '${record.id}'`)
    }
    if (record.target !== undefined && integrated.evaluated.target !== record.target) {
      throw new Error(`yrd: integration evaluated a different target for authored intent '${record.id}'`)
    }
    const { intent: _intent, ...integration } = integrated
    return replaceIntent(state, {
      ...(record as PinIntent),
      status: "integrated",
      disposition: { code: "intent-integrated", at: applied.ts },
      integration,
    })
  }
  if (applied.name === "intent/evaluation-recorded") {
    const evaluation = PinIntentEvaluationFactSchema.parse(applied.data)
    const record = state.intents.records[evaluation.intent]
    if (record === undefined) throw new Error(`yrd: evaluation names missing intent '${evaluation.intent}'`)
    if (TERMINAL_INTENT_STATUSES.has(record.status)) {
      if (JSON.stringify(record.evaluation) === JSON.stringify(evaluation)) return state as IntentState
      throw new Error(`yrd: evaluation names terminal intent '${record.id}' (${record.status})`)
    }
    if (
      evaluation.outcome !== "refused" &&
      record.target !== undefined &&
      evaluation.evaluated.target !== record.target
    ) {
      throw new Error(`yrd: evaluation target does not match authored intent '${record.id}'`)
    }
    const status = evaluation.outcome === "advance" ? "open" : evaluation.outcome
    let disposition: PinIntent["disposition"]
    if (evaluation.outcome === "noop") {
      disposition = { code: "intent-noop", at: applied.ts }
    } else if (evaluation.outcome === "refused") {
      disposition = { code: evaluation.refusal.code, at: applied.ts, reason: evaluation.refusal.message }
    }
    return replaceIntent(state, {
      ...(record as PinIntent),
      status,
      evaluation,
      ...(disposition === undefined ? {} : { disposition }),
    })
  }
  return state as IntentState
}

function replaceIntent(state: DeepReadonly<IntentState>, record: PinIntent): IntentState {
  return {
    intents: {
      records: { ...(state.intents.records as Record<string, PinIntent>), [record.id]: PinIntentSchema.parse(record) },
      order: [...state.intents.order],
      tombstoneRecords: { ...(state.intents.tombstoneRecords as Record<string, PinTombstone>) },
      tombstoneOrder: [...state.intents.tombstoneOrder],
    },
  }
}

function orderedTombstones(state: IntentsState): readonly PinTombstone[] {
  return state.tombstoneOrder.flatMap((id) => {
    const record = state.tombstoneRecords[id]
    return record === undefined ? [] : [record]
  })
}

function ordered(state: IntentsState): readonly PinIntent[] {
  return state.order.flatMap((id) => {
    const record = state.records[id]
    return record === undefined ? [] : [record]
  })
}

/**
 * Resolve operator input to a record.
 *
 * The stored key always resolves. A bare number resolves too — the verb
 * disambiguates (`yrd intent show 162`), and it spares the operator a `#`:
 * under zsh's `extendedglob`, an unquoted `#` is the pattern repeat operator,
 * so `yrdpin#162` is read as a glob, matches no file, and dies as
 * "no matches found" before the command runs at all. Both forms carry the bare
 * number as an alias, so if a `yrdpin#<n>` and an `I<n>` ever shared a number
 * the core selector refuses as ambiguous rather than picking one — the counter
 * is what prevents that pair from being minted.
 */
function bySelector(state: DeepReadonly<IntentsState> | IntentsState, selector: string): PinIntent | undefined {
  return resolveSelector(
    selector,
    Object.values(state.records).map((record) => {
      const number = intentIdNumber((record as PinIntent).id)
      return {
        canonical: (record as PinIntent).id,
        aliases: number === undefined ? [] : [String(number)],
        value: record as PinIntent,
      }
    }),
    { kind: "intent" },
  )
}

function byIntentId(state: DeepReadonly<IntentsState> | IntentsState, intentId: string): PinIntent | undefined {
  for (const record of Object.values(state.records)) {
    if (record.intentId === intentId) return record as PinIntent
  }
  return undefined
}

function byTombstoneId(
  state: DeepReadonly<IntentsState> | IntentsState,
  tombstoneId: string,
): PinTombstone | undefined {
  for (const record of Object.values(state.tombstoneRecords)) {
    if (record.tombstoneId === tombstoneId) return record as PinTombstone
  }
  return undefined
}

function liveIntent(
  state: DeepReadonly<IntentsState> | IntentsState,
  issue: IssueRef,
  component: string,
): PinIntent | undefined {
  const key = intentKey(issue, component)
  for (const id of state.order) {
    const record = state.records[id]
    if (record === undefined || TERMINAL_INTENT_STATUSES.has(record.status)) continue
    if (intentKey(record.issue as IssueRef, record.component) === key) return record as PinIntent
  }
  return undefined
}

/**
 * The next record id, always minted `yrdpin#<n>`.
 *
 * The scan reads BOTH id forms, permanently. Records minted before the rename
 * hold the low numbers under `I<n>` keys, so a counter blind to them would find
 * an empty set, restart at 1, and mint `yrdpin#1` alongside a live `I1` — two
 * records wearing one number on the same screen. There is no point at which the
 * old form stops mattering: as long as a journal holds an `I<n>` record, that
 * number is taken.
 */
function nextIntentId(records: DeepReadonly<Record<string, PinIntent>> | Record<string, PinIntent>): string {
  const values = Object.keys(records).flatMap((id) => {
    const value = intentIdNumber(id)
    return value === undefined ? [] : [value]
  })
  return `${INTENT_ID_PREFIX}${Math.max(0, ...values) + 1}`
}

function nextTombstoneId(records: DeepReadonly<Record<string, PinTombstone>> | Record<string, PinTombstone>): string {
  const values = Object.keys(records).flatMap((id) => {
    const value = tombstoneIdNumber(id)
    return value === undefined ? [] : [value]
  })
  return `${TOMBSTONE_ID_PREFIX}${Math.max(0, ...values) + 1}`
}

function tombstoneFingerprint(
  input: Pick<PinTombstone, "issue" | "component" | "sha" | "submitter" | "reason"> | PinTombstoneArgs,
): string {
  return JSON.stringify([
    input.issue.source,
    input.issue.id,
    input.component,
    input.sha,
    input.submitter,
    input.reason ?? null,
  ])
}
