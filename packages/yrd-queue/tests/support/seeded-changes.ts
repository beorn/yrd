/**
 * Journal-seeding builders for REPLAYED record history (S7 branch-is-change,
 * @i/10 22991). The bay record verbs (`bays.submit` per-id, `requestChecks`,
 * `closePr`, `ready`, `recut`, …) are deleted — no live command writes `pr/*`
 * events any more — but every `pr/*` reducer stays live for replay, so a
 * fixture materializes any record state by booting its app over a memory
 * journal that holds the exact events those verbs used to write, or by
 * appending one more frame mid-test (`appendSeedFrame`) and folding it in with
 * `app.refresh()`.
 *
 * Event shapes follow packages/yrd-bay/tests/require-live-pr.test.ts (the
 * house pattern): the modern `pr/pushed` arm requires changeId + submitter
 * together; `pr/submitted` replays through the legacy revision schema.
 */
import { Command, type Journal } from "@yrd/core"

export const SEED_AT = "2026-01-01T00:00:00.000Z"
export const SEED_BASE_SHA = "a".repeat(40)

/** Monotone uuid-shaped ids. Share ONE instance between the seeds and the
 * app's `inject.id` so live dispatches never collide with seeded ids. */
export function seedIds(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

export type SeedEvent = Readonly<{ id: string; name: string; ts: string; data: Readonly<Record<string, unknown>> }>

/** One raw journal event row — the escape hatch for shapes `ChangeSeed` does
 * not model (pr/needs-author, pr/admission-recorded, pr/recut, …). The data
 * must satisfy the event's registered schema; replay fails loud otherwise. */
export function changeEvent(
  nextId: () => string,
  name: string,
  data: Readonly<Record<string, unknown>>,
  at = SEED_AT,
): SeedEvent {
  return { id: nextId(), name, ts: at, data }
}

export type ChangeSeed = Readonly<{
  pr: string
  branch: string
  headSha: string
  /** Base BRANCH name (pr/pushed `base`), default "main". */
  base?: string
  baseSha?: string
  revision?: number
  /** Stable Change-Id (`I` + 40 hex); defaults to `I${headSha}`. */
  changeId?: string
  submitter?: string
  /** Append `pr/submitted` (the old record submit / ready state); default true. */
  submitted?: boolean
  /** Append `pr/checks-requested` (the old `bays.requestChecks`); default false. */
  checksRequested?: boolean
  /** Terminal fact to land the record in, if any. */
  terminal?:
    | Readonly<{ kind: "withdrawn"; reason?: string }>
    | Readonly<{ kind: "integrated"; commit: string; run?: string; landingSha?: string; baseSha?: string }>
}>

/** The event rows one record's seeded lifecycle replays to. */
export function changeSeedEvents(nextId: () => string, seeds: readonly ChangeSeed[], at = SEED_AT): SeedEvent[] {
  return seeds.flatMap((seed) => {
    const revision = seed.revision ?? 1
    const baseSha = seed.baseSha ?? SEED_BASE_SHA
    const events: SeedEvent[] = [
      changeEvent(
        nextId,
        "pr/pushed",
        {
          pr: seed.pr,
          branch: seed.branch,
          base: seed.base ?? "main",
          headSha: seed.headSha,
          baseSha,
          revision,
          changeId: seed.changeId ?? `I${seed.headSha.slice(0, 40)}`,
          submitter: seed.submitter ?? "fixture",
        },
        at,
      ),
    ]
    if (seed.submitted !== false) {
      events.push(changeEvent(nextId, "pr/submitted", { pr: seed.pr, revision, headSha: seed.headSha }, at))
    }
    if (seed.checksRequested === true) {
      events.push(
        changeEvent(nextId, "pr/checks-requested", { pr: seed.pr, revision, headSha: seed.headSha, baseSha }, at),
      )
    }
    if (seed.terminal?.kind === "withdrawn") {
      events.push(
        changeEvent(
          nextId,
          "pr/withdrawn",
          {
            pr: seed.pr,
            revision,
            headSha: seed.headSha,
            ...(seed.terminal.reason === undefined ? {} : { reason: seed.terminal.reason }),
          },
          at,
        ),
      )
    }
    if (seed.terminal?.kind === "integrated") {
      events.push(
        changeEvent(
          nextId,
          "pr/integrated",
          {
            pr: seed.pr,
            revision,
            headSha: seed.headSha,
            run: seed.terminal.run ?? `R-${seed.pr}`,
            commit: seed.terminal.commit,
            landingSha: seed.terminal.landingSha ?? seed.terminal.commit,
            baseSha: seed.terminal.baseSha ?? baseSha,
          },
          at,
        ),
      )
    }
    return events
  })
}

export type SeedFrame = Readonly<{
  command: Readonly<{ id: string; op: string }>
  cause: Readonly<{ id: string; commandId: string; op: string; commandHash: string }>
  events: readonly SeedEvent[]
}>

/** Wrap seed events in one journal frame under a synthetic fixture command. */
export function seedFrame(nextId: () => string, events: readonly SeedEvent[]): SeedFrame {
  const command = { id: nextId(), op: "fixture.seed" }
  return {
    command,
    cause: { id: nextId(), commandId: command.id, op: command.op, commandHash: Command.hash(command) },
    events,
  }
}

/** Append one seed frame at the journal's live end — the mid-test half of the
 * pattern. The caller folds it into the app with `await app.refresh()`. Fails
 * loud on a lost race; a seeding fixture has no concurrent writer to lose to. */
export async function appendSeedFrame(journal: Journal<unknown>, frame: SeedFrame): Promise<void> {
  let cursor = 0
  for await (const batch of journal.read(0)) cursor = batch.cursor
  const result = await journal.append(frame, cursor)
  if (!result.appended) {
    throw new Error(`seeded-changes: journal append lost a race at cursor ${cursor} (now ${result.cursor})`)
  }
}
