import { readFile, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { DeprovisionVia, RejectionCode } from "./types.ts"

/**
 * journal.jsonl v1 → v2, one-shot (spec § event schema v2, "the journal
 * migration"). v1 rows are the pre-v0.3 dotted event names — `{v, ts, actor,
 * type, pr?, lease?, data?}`. v2 rows are the slash-namespaced families —
 * `{id, ts, name, cause, data}` (docs/events.md). There is no dual-read shim:
 * a v1 journal must be migrated before any v0.3 code reads it, and this file
 * is the only place that still knows the v1 shape.
 *
 * Renames (docs/events.md § event families):
 *   bay.initialized      → gitbay/initialized
 *   audit.completed       → gitbay/audited
 *   lease.opened          → bay/opened            (+ worktree/provisioned's sibling data)
 *   lease.pinged          → bay/refreshed
 *   lease.ended           → bay/closed            (endReason → via)
 *   workspace.provisioned → worktree/provisioned
 *   workspace.retired     → worktree/deprovisioned (via inherited from the lease's last bay/closed)
 *   pr.opened             → pr/opened             (via inferred: "push" iff a lease pre-minted this PR)
 *   pr.state-changed       → pr/changed            (rejected rows get a code inferred from `detail`)
 *   queue.reordered        → queue/reordered       (payload 1:1)
 *   batch.composed         → batch/composed        (payload 1:1; the 20955-20957 batch dialect)
 *   batch.built            → batch/built           (payload 1:1)
 *   batch.bisect.checked   → batch/bisect-checked  (payload 1:1)
 *   batch.member.ejected   → batch/member-ejected  (payload 1:1)
 * Dropped (non-events; docs/events.md § event families: "an empty integrate
 * run, a prune that removed nothing" are deliberately never journaled):
 *   queue.empty, gc.clean, batch.empty
 * Absorbed, not replayed (adopt.recorded added no field pr/opened doesn't
 * already carry once `via` exists):
 *   adopt.recorded
 *
 * PR state vocabulary (docs/model.md — the pre-v0.3 AND v0.3-through-v0.6
 * journals share the SAME three renamed names, so one pass covers both;
 * this is effectively v1→v3 for `pr/changed`'s `from`/`to`, even though the
 * envelope shape itself is still v2):
 *   open      → pushed
 *   queued    → submitted
 *   abandoned → closed
 * `checking`/`merging`/`merged`/`rejected` are unchanged; `checked` is a
 * BRAND NEW resting state no v1/v2 journal ever produced, so no migrated row
 * ever needs to become it — see renamePrState().
 */

type LegacyEvent = {
  v?: number
  ts: string
  actor?: string
  type: string
  pr?: string
  lease?: string
  data?: Record<string, unknown>
}

type MigratedEvent = {
  id: string
  ts: string
  name: string
  cause: { commandId: string }
  data: Record<string, unknown>
}

/** Best-effort classification of a v1 `pr.state-changed` rejection's free-text
 *  `detail` into a v0.3 RejectionCode — the v1 journal never recorded a code,
 *  so this is inference, not replay. Matches the exact message shapes emitted
 *  by receive.ts / merge-worker.ts (both pre- and post-v0.3, since the wording
 *  itself did not change, only the addition of a `code` alongside it). A
 *  detail that matches nothing recognizable still migrates — RejectionCode
 *  doesn't have a formal "unknown" member, so this falls back to the closest
 *  generic bucket (merge-command-failed, the bare "exit N[: tail]" shape)
 *  rather than inventing a new code or throwing on legitimately old data. */
function classifyRejectionDetail(detail: string | undefined): RejectionCode {
  const d = detail ?? ""
  if (/^check '.*' failed/.test(d)) return "check-failed"
  if (/mainline working tree at .* is dirty/.test(d)) return "dirty-mainline"
  if (/^merge of .* onto .* failed/.test(d)) return "merge-conflict"
  if (/does not resolve in .* — cannot verify a landing/.test(d)) return "unresolvable-target"
  if (/lying-merge guard/.test(d)) return "lying-merge"
  return "merge-command-failed"
}

/** open/queued/abandoned (the pre-model.md PR state vocabulary) → their
 *  current names; every other state string round-trips unchanged. Applied to
 *  every `pr.state-changed` row's `from`/`to` — a straight rename, not a
 *  re-derivation, so a migrated journal never carries a state name the
 *  current PrState union doesn't have. */
function renamePrState(state: string): string {
  if (state === "open") return "pushed"
  if (state === "queued") return "submitted"
  if (state === "abandoned") return "closed"
  return state
}

/** endReason (v1, on the lease record) → via (v2, on bay/closed and
 *  worktree/deprovisioned). "close" is the default for "abandoned" — v1 never
 *  distinguished a plain close from a --withdraw (the flag didn't exist yet),
 *  so a migrated abandoned lease reads as an ordinary close. */
function endReasonToVia(endReason: unknown): DeprovisionVia {
  if (endReason === "expired") return "gc"
  if (endReason === "merged") return "merged"
  return "close"
}

/**
 * Migrate one v1 journal in place: reads `<dir>/journal.jsonl`, backs the
 * original up alongside as `journal.v1.jsonl` (never overwritten — a second
 * run against an already-migrated dir is refused, not silently re-run), and
 * writes the migrated v2 rows back to `journal.jsonl`. Non-events are
 * dropped; every other row is renamed and reshaped 1:1 (no fan-out, no
 * merging of rows) using a small amount of running state (which worktree a
 * lease holds, which PRs a lease pre-minted, each lease's last `via`) needed
 * to fill in fields v1 didn't carry on every row.
 */
export async function migrateJournal(dir: string): Promise<{ migrated: number; dropped: number }> {
  const journalPath = join(dir, "journal.jsonl")
  const backupPath = join(dir, "journal.v1.jsonl")
  if (!existsSync(journalPath)) {
    throw new Error(`bay: migrate: no journal at ${journalPath} — nothing to migrate`)
  }
  if (existsSync(backupPath)) {
    throw new Error(
      `bay: migrate: ${backupPath} already exists — this journal looks already migrated (or a previous ` +
        `migration was interrupted after the backup but before the rewrite); refusing to overwrite the backup`,
    )
  }

  const raw = await readFile(journalPath, "utf8")
  const lines = raw.split("\n").filter((l) => l.trim() !== "")

  // Running state, populated in journal order (spec: migration is a forward
  // pass, never a second replay pass) — exactly what a v1 fold would have
  // known at each row, which is all a 1:1 per-row reshape is allowed to use.
  const worktreeByLease = new Map<string, string>() // lease id -> "wtN"
  const prMintedByLease = new Set<string>() // PR ids pre-minted by a lease.opened
  const lastViaByLease = new Map<string, DeprovisionVia>() // lease id -> its last bay/closed via

  const out: MigratedEvent[] = []
  let dropped = 0
  let seq = 0
  const nextId = (): string => {
    seq++
    return `legacy-${seq}`
  }
  // v1 rows carry no cause at all; every migrated row gets the SAME synthetic
  // marker cause rather than inventing per-row correlation history has none of.
  const cause = { commandId: "legacy-migration" }

  for (const line of lines) {
    const event = JSON.parse(line) as LegacyEvent
    const d = event.data ?? {}

    switch (event.type) {
      case "bay.initialized": {
        out.push({ id: nextId(), ts: event.ts, name: "gitbay/initialized", cause, data: d })
        break
      }
      case "audit.completed": {
        out.push({ id: nextId(), ts: event.ts, name: "gitbay/audited", cause, data: d })
        break
      }
      case "lease.opened": {
        const lease = d.lease as string
        const n = d.bay as number
        const worktree = `wt${n}`
        worktreeByLease.set(lease, worktree)
        const changeId = d.changeId as string
        prMintedByLease.add(changeId)
        out.push({
          id: nextId(),
          ts: event.ts,
          name: "bay/opened",
          cause,
          data: {
            bay: lease,
            worktree,
            workName: d.workitem ?? null,
            pr: changeId,
            branch: d.branch,
            recycled: false,
            actor: event.actor ?? "bay",
          },
        })
        break
      }
      case "workspace.provisioned": {
        const lease = d.lease as string
        out.push({
          id: nextId(),
          ts: event.ts,
          name: "worktree/provisioned",
          cause,
          data: {
            bay: lease,
            worktree: worktreeByLease.get(lease) ?? "",
            path: d.path,
            ...(d.baseSha !== undefined ? { baseSha: d.baseSha } : {}),
            ...(d.headSha !== undefined ? { headSha: d.headSha } : {}),
            ...(d.upstream !== undefined ? { upstream: d.upstream } : {}),
          },
        })
        break
      }
      case "lease.pinged": {
        out.push({ id: nextId(), ts: event.ts, name: "bay/refreshed", cause, data: { bay: d.lease } })
        break
      }
      case "lease.ended": {
        const lease = d.lease as string
        const via = endReasonToVia(d.endReason)
        lastViaByLease.set(lease, via)
        out.push({ id: nextId(), ts: event.ts, name: "bay/closed", cause, data: { bay: lease, via } })
        break
      }
      case "workspace.retired": {
        const lease = d.lease as string
        out.push({
          id: nextId(),
          ts: event.ts,
          name: "worktree/deprovisioned",
          cause,
          data: {
            worktree: worktreeByLease.get(lease) ?? "",
            via: lastViaByLease.get(lease) ?? "close",
            bay: lease,
            ...(d.abandonedRef !== undefined ? { abandonedRef: d.abandonedRef } : {}),
          },
        })
        break
      }
      case "pr.opened": {
        const pr = d.pr as string
        const via = prMintedByLease.has(pr) ? "push" : "submit"
        // v1 never had an `open`-then-submit split (§6 addendum, v0.3-later) —
        // every v1 PR was born directly into `queued`. queued: true preserves
        // that semantics exactly on migration.
        out.push({
          id: nextId(),
          ts: event.ts,
          name: "pr/opened",
          cause,
          data: { pr, target: d.target, workName: d.name ?? null, via, queued: true },
        })
        break
      }
      case "pr.state-changed": {
        const from = renamePrState(d.from as string)
        const to = renamePrState(d.to as string)
        const data: Record<string, unknown> = { pr: d.pr, from, to }
        if (d.revision !== undefined) data.revision = d.revision
        if (to === "rejected") data.code = classifyRejectionDetail(d.detail as string | undefined)
        if (d.detail !== undefined) data.detail = d.detail
        out.push({ id: nextId(), ts: event.ts, name: "pr/changed", cause, data })
        break
      }
      case "queue.reordered": {
        out.push({ id: nextId(), ts: event.ts, name: "queue/reordered", cause, data: d })
        break
      }
      // The 20955-20957 batch dialect (pre-v0.3 journals from repos that ran
      // batch integration) — payloads carry over 1:1; only the names move to
      // the slash grammar.
      case "batch.composed": {
        out.push({ id: nextId(), ts: event.ts, name: "batch/composed", cause, data: d })
        break
      }
      case "batch.built": {
        out.push({ id: nextId(), ts: event.ts, name: "batch/built", cause, data: d })
        break
      }
      case "batch.bisect.checked": {
        out.push({ id: nextId(), ts: event.ts, name: "batch/bisect-checked", cause, data: d })
        break
      }
      case "batch.member.ejected": {
        out.push({ id: nextId(), ts: event.ts, name: "batch/member-ejected", cause, data: d })
        break
      }
      case "adopt.recorded":
      case "queue.empty":
      case "gc.clean":
      case "batch.empty":
        dropped++
        break
      default:
        throw new Error(
          `bay: migrate: unrecognized v1 event type '${event.type}' — this migration only knows the ` +
            `pre-v0.3 vocabulary; a name outside it means this journal is not what it looks like`,
        )
    }
  }

  await rename(journalPath, backupPath)
  const body = out.map((e) => JSON.stringify(e)).join("\n") + (out.length > 0 ? "\n" : "")
  await writeFile(journalPath, body, "utf8")

  return { migrated: out.length, dropped }
}
