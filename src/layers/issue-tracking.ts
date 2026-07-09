import type {
  BayCommand,
  BayEvent,
  BayPlugin,
  BayRuntime,
  BayState,
  Effect,
  EffectHandler,
  Layer,
  PrId,
  TransitionResult,
  WorkitemId,
} from "../types.ts"
import { makeEvent } from "../core.ts"
import { runConfiguredCommand } from "../command.ts"
import { createGitConfigSource } from "../config.ts"
import { tail } from "./pipeline.ts"

/**
 * withIssueTracking — the outbound half of docs/layers/issue-tracking.md:
 * react to PR lifecycle by running the configured command for the state the
 * PR reached, and JOURNAL the outcome — a failed close shows up in the
 * journal/stats instead of vanishing. Policy stays in the commands (what a
 * "close" means is the tracker's business, never bay's).
 *
 * Config (git config, `bay.` section — resolution order everywhere: inline >
 * BAY_* env > git config bay.* > unset):
 *
 *   bay.issue.on-merged    e.g. gh issue close "$YRD_TASK" --comment "merged as $YRD_SHA ($YRD_PR)"
 *   bay.issue.on-rejected  e.g. gh issue comment "$YRD_TASK" --body "PR $YRD_PR rejected: $YRD_CODE"
 *   bay.issue.on-closed    e.g. gh issue comment "$YRD_TASK" --body "PR $YRD_PR withdrawn"
 *
 * (The inbound half — `bay.issue` — is a door check the HOST runs before
 * dispatch, since reducers are pure; see resolveValidateCommand below and
 * bin's open/adopt.)
 *
 * The host dispatches `issues-notify` after a dispatch whose events contain a
 * terminal `pr/changed` (merged/rejected/closed) for a NAMED PR. The reducer
 * validates and emits the notify effect; the effect handler resolves the
 * static command, supplies event data through YRD_* variables, and returns ONE `issues/notified` event with
 * the exit code — success and failure are both journaled data. Only a broken
 * host (no `sh`) throws. An unconfigured state is a non-event: the handler
 * returns no events, journaling nothing (docs/events.md § event families).
 */

const LAYER = "issue-tracking"
const FX_NOTIFY_RUN = "issues.notify-run"

/** Terminal PR states the tracker can react to → their config keys. */
const NOTIFY_KEYS = {
  merged: "issue.on-merged",
  rejected: "issue.on-rejected",
  closed: "issue.on-closed",
} as const

export type NotifiableState = keyof typeof NOTIFY_KEYS

export function notifyKeyFor(to: string): string | undefined {
  return (NOTIFY_KEYS as Record<string, string>)[to]
}

export type IssueTrackingOptions = {
  /** cwd for resolving `bay.issue.*` from git config; also the spawn cwd for
   *  the notify command. The CLI host passes the mainline repo. */
  mainRepo?: string
}

/** The inbound validate command: `bay.issue`. ""/"none" mean unset
 *  (explicit off). */
export async function resolveValidateCommand(configCwd: string): Promise<string | undefined> {
  const source = createGitConfigSource(configCwd)
  const value = await source.get("issue")
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" || trimmed === "none" ? undefined : trimmed
}

// ---------- reducer ----------

function reduceNotify(bay: BayRuntime, state: BayState, command: BayCommand): TransitionResult {
  const args = command.args ?? {}
  const pr = args.pr
  if (typeof pr !== "string" || pr.trim() === "") {
    throw new Error("bay: issues-notify: 'pr' is required")
  }
  const to = args.to
  if (typeof to !== "string" || notifyKeyFor(to) === undefined) {
    throw new Error(
      `bay: issues-notify: 'to' must be one of ${Object.keys(NOTIFY_KEYS).join(", ")} — got '${String(to)}'`,
    )
  }
  const name = args.name
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`bay: issues-notify: 'name' (the PR's workitem) is required — an unnamed PR has no issue to notify`)
  }
  const effect: Effect = {
    type: FX_NOTIFY_RUN,
    data: { pr, to, name, sha: args.sha, code: args.code, detail: args.detail },
  }
  return { state, events: [], effects: [effect] }
}

// ---------- effect handler (the I/O) ----------

function makeNotifyRunHandler(opts: IssueTrackingOptions): EffectHandler {
  return async (effect: Effect, bay: BayRuntime): Promise<BayEvent[]> => {
    const d = effect.data as {
      pr: PrId
      to: NotifiableState
      name: WorkitemId
      sha?: string
      code?: string
      detail?: string
    }
    const configCwd = opts.mainRepo ?? process.cwd()
    const source = createGitConfigSource(configCwd)
    const template = await source.get(NOTIFY_KEYS[d.to])
    if (template === undefined || template.trim() === "" || template.trim() === "none") {
      return [] // unconfigured state: a non-event — nothing ran, nothing to record
    }
    const result = await runConfiguredCommand({
      command: template,
      cwd: configCwd,
      purpose: `issue ${d.to}`,
      variables: {
        YRD_TASK: d.name,
        YRD_PR: d.pr,
        YRD_SHA: d.sha,
        YRD_CODE: d.code,
        YRD_DETAIL: d.detail,
      },
    })
    const said = tail(result.stderr !== "" ? result.stderr : result.stdout, 500)
    return [
      makeEvent(
        bay,
        "issues/notified",
        {
          pr: d.pr,
          name: d.name,
          on: d.to,
          command: template,
          code: result.exitCode,
          ...(said !== "" ? { detail: said } : {}),
        },
        effect.cause!,
      ),
    ]
  }
}

// ---------- the plugin ----------

/** No apply — `issues/notified` is an audit-trail event no fold consumes; the
 *  journal (and stats readers) are its consumers. */
export function withIssueTracking(opts: IssueTrackingOptions = {}): BayPlugin {
  return (bay) => {
    const layer: Layer = {
      name: LAYER,
      reduce(state, command, next) {
        if (command.type === "issues-notify") return reduceNotify(bay, state, command)
        return next(state, command)
      },
      effects: {
        [FX_NOTIFY_RUN]: makeNotifyRunHandler(opts),
      },
    }
    return bay.use(layer)
  }
}
