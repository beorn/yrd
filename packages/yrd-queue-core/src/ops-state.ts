/** The complete operational state carried by every queue ops event. */
import type { OverrideEntry } from "./override.ts"
import type { PauseRecord } from "./pause.ts"
import { changeName, parseChangeName } from "./refs.ts"

export type OpsState = Readonly<{
  pause?: PauseRecord
  overrides: readonly OverrideEntry[]
}>

const SELF = "self"

/** An event cannot contain its own oid, so new records use `self` on disk. */
export function encodeOps(state: OpsState): string {
  return JSON.stringify({
    version: 1,
    pause:
      state.pause === undefined
        ? null
        : {
            kind: state.pause.kind,
            sha: state.pause.sha,
            at: state.pause.at.toISOString(),
            reason: state.pause.reason,
            by: state.pause.by,
            cause: state.pause.cause,
            ...(state.pause.change === undefined ? {} : { change: changeName(state.pause.change) }),
            ...(state.pause.next === undefined ? {} : { next: state.pause.next }),
          },
    overrides: state.overrides.map((entry) => ({
      check: entry.check,
      state: entry.state,
      until: entry.until.toISOString(),
      by: entry.by,
      verified: entry.verified,
      reason: entry.reason,
      record: entry.record,
      setAt: entry.setAt.toISOString(),
      ...(entry.expiredAt === undefined ? {} : { expiredAt: entry.expiredAt.toISOString() }),
      ...(entry.remindedAt === undefined ? {} : { remindedAt: entry.remindedAt.toISOString() }),
    })),
  })
}

/** Parse one complete state; malformed or partial state never means "running". */
export function decodeOps(value: string, self: string, where: string): OpsState {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${where}: unreadable Ops: JSON`, { cause: error })
  }
  const object = (input: unknown, label: string): Record<string, unknown> => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`${where}: ${label} must be an object`)
    }
    return input as Record<string, unknown>
  }
  const text = (input: Record<string, unknown>, key: string): string => {
    const found = input[key]
    if (typeof found !== "string" || found.trim() === "") throw new Error(`${where}: Ops: needs ${key}`)
    return found
  }
  const time = (input: Record<string, unknown>, key: string): Date => {
    const raw = text(input, key)
    const found = new Date(raw)
    if (Number.isNaN(found.getTime()) || found.toISOString() !== raw) {
      throw new Error(`${where}: Ops: ${key} needs an ISO instant`)
    }
    return found
  }
  const root = object(parsed, "Ops:")
  if (root.version !== 1) throw new Error(`${where}: unknown Ops: version ${String(root.version)}`)
  if (!("pause" in root) || !Array.isArray(root.overrides)) {
    throw new Error(`${where}: Ops: needs explicit pause and overrides`)
  }
  let pause: PauseRecord | undefined
  if (root.pause !== null) {
    const raw = object(root.pause, "Ops: pause")
    if (raw.kind !== "paused") throw new Error(`${where}: Ops: only a standing pause belongs in the snapshot`)
    if (raw.cause !== "operator" && raw.cause !== "stuck" && raw.cause !== "maintenance") {
      throw new Error(`${where}: Ops: invalid pause cause`)
    }
    const change = raw.change === undefined ? undefined : parseChangeName(text(raw, "change"))
    if ((raw.cause === "stuck" && change === undefined) || (raw.cause !== "stuck" && raw.change !== undefined)) {
      throw new Error(`${where}: Ops: pause cause and change disagree`)
    }
    if (raw.next !== undefined && (raw.cause !== "stuck" || typeof raw.next !== "string")) {
      throw new Error(`${where}: Ops: invalid pause next`)
    }
    pause = {
      kind: raw.kind,
      sha: text(raw, "sha") === SELF ? self : text(raw, "sha"),
      at: time(raw, "at"),
      reason: text(raw, "reason"),
      by: text(raw, "by"),
      cause: raw.cause,
      ...(change === undefined ? {} : { change }),
      ...(raw.next === undefined ? {} : { next: raw.next as string }),
    }
  }
  const overrides = root.overrides.map((item, index): OverrideEntry => {
    const raw = object(item, `Ops: override ${index}`)
    if (raw.state !== "active" && raw.state !== "expired") {
      throw new Error(`${where}: Ops: override ${index} has invalid state`)
    }
    if (typeof raw.verified !== "boolean") throw new Error(`${where}: Ops: override ${index} needs verified boolean`)
    return {
      check: text(raw, "check"),
      state: raw.state,
      until: time(raw, "until"),
      by: text(raw, "by"),
      verified: raw.verified,
      reason: text(raw, "reason"),
      record: text(raw, "record") === SELF ? self : text(raw, "record"),
      setAt: time(raw, "setAt"),
      ...(raw.expiredAt === undefined ? {} : { expiredAt: time(raw, "expiredAt") }),
      ...(raw.remindedAt === undefined ? {} : { remindedAt: time(raw, "remindedAt") }),
    }
  })
  const names = overrides.map((entry) => entry.check)
  if (new Set(names).size !== names.length) throw new Error(`${where}: Ops: duplicate override check`)
  return { ...(pause === undefined ? {} : { pause }), overrides }
}

/** Sentinel for a pause or override established by the event being prepared. */
export const OPS_SELF = SELF
