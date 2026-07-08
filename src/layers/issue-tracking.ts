import type { BayCommand, BayEvent, BayPlugin, BayRuntime, BayState, Effect, EffectHandler, Layer, PrId, TransitionResult, WorkitemId } from "../types.ts"
import { makeEvent } from "../core.ts"
import { createGitConfigSource } from "../config.ts"
import { repoScopedCleanEnv } from "../env.ts"
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
 *   bay.issues.on-merged    e.g.  gh issue close {name} --comment "merged as {sha} ({pr})"
 *   bay.issues.on-rejected  e.g.  gh issue comment {name} --body "PR {pr} rejected: {code} — {detail}"
 *   bay.issues.on-closed    e.g.  gh issue comment {name} --body "PR {pr} withdrawn"
 *
 * (The inbound half — `bay.issues.validate`, with `bay.tracker` as the
 * deprecated spelling — is a door check the HOST runs before dispatch, since
 * reducers are pure; see resolveValidateCommand below and bin's open/adopt.)
 *
 * The host dispatches `issues-notify` after a dispatch whose events contain a
 * terminal `pr/changed` (merged/rejected/closed) for a NAMED PR. The reducer
 * validates and emits the notify effect; the effect handler resolves the
 * command, substitutes, runs it, and returns ONE `issues/notified` event with
 * the exit code — success and failure are both journaled data. Only a broken
 * host (no `sh`) throws. An unconfigured state is a non-event: the handler
 * returns no events, journaling nothing (docs/events.md § event families).
 */

const LAYER = "issue-tracking"
const FX_NOTIFY_RUN = "issues.notify-run"

/** Terminal PR states the tracker can react to → their config keys. */
const NOTIFY_KEYS = {
  merged: "issues.on-merged",
  rejected: "issues.on-rejected",
  closed: "issues.on-closed",
} as const

export type NotifiableState = keyof typeof NOTIFY_KEYS

export function notifyKeyFor(to: string): string | undefined {
  return (NOTIFY_KEYS as Record<string, string>)[to]
}

export type IssueTrackingOptions = {
  /** cwd for resolving `bay.issues.*` from git config; also the spawn cwd for
   *  the notify command. The CLI host passes the mainline repo. */
  mainRepo?: string
}

// ---------- pure template rendering (exported for tests) ----------

const SUBSTITUTIONS = ["name", "pr", "sha", "code", "detail"] as const

/** Render a notify template. Loud contract: a `{key}` the template references
 *  but the event cannot supply is a configuration mismatch, not an empty
 *  string — e.g. `{sha}` in on-rejected (rejections have no landed sha).
 *  Unknown `{word}` tokens pass through untouched (they may be the command's
 *  own syntax, e.g. a jq filter). */
export function renderIssueCommand(template: string, subs: Partial<Record<(typeof SUBSTITUTIONS)[number], string>>): string {
  let out = template
  for (const key of SUBSTITUTIONS) {
    const token = `{${key}}`
    if (!out.includes(token)) continue
    const value = subs[key]
    if (value === undefined) {
      throw new Error(
        `bay: issues: template references ${token} but this event carries no ${key} — ` +
          `fix the command for this state (git config bay.${NOTIFY_KEYS.merged.split(".")[0]}.…) or drop the token`,
      )
    }
    out = out.replaceAll(token, value)
  }
  return out
}

/** The inbound validate command: `bay.issues.validate`, falling back to the
 *  deprecated `bay.tracker` spelling. ""/"none" mean unset (explicit off). */
export async function resolveValidateCommand(configCwd: string): Promise<string | undefined> {
  const source = createGitConfigSource(configCwd)
  const modern = await source.get("issues.validate")
  const value = modern !== undefined && modern.trim() !== "" ? modern : await source.get("tracker")
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
    const command = renderIssueCommand(template, {
      name: d.name,
      pr: d.pr,
      sha: d.sha,
      code: d.code,
      detail: d.detail,
    })
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: configCwd,
      stdout: "pipe",
      stderr: "pipe",
      env: repoScopedCleanEnv(),
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const said = tail(err !== "" ? err : out, 500)
    return [
      makeEvent(
        bay,
        "issues/notified",
        {
          pr: d.pr,
          name: d.name,
          on: d.to,
          command,
          code,
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
