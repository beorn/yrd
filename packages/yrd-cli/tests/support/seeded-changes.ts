/**
 * S7 (branch-is-change, @i/10 22991): the change-record store is GONE, so the
 * `pr/*` frames a seed writes are pure HISTORY — every `pr/*` reducer is a bare
 * `return state`, and replaying them projects nothing. They stay because a
 * journal carrying them must still parse (the events/replayEvents registries
 * are the acceptance authority), and because a fixture's intent is easiest to
 * read in the vocabulary the delivery actually used.
 *
 * What a seed PROJECTS is the branch/submitted fact: a live seed (revisions
 * ending submitted, no terminal) stands as `bays.submits[branch]`, which since
 * S7 is the whole of a branch's delivery. A terminal seed writes no submit fact
 * — an integrated, withdrawn, rejected or canceled delivery has no standing
 * submit ref — so such a seed is history only, and a test that needs its
 * identity back must resolve it the way production does, through a retained run
 * member.
 */
import { Command } from "@yrd/core"

export type SeededTerminal =
  | Readonly<{ kind: "integrated"; commit: string; run?: string; baseSha?: string }>
  | Readonly<{ kind: "rejected"; run?: string; step?: string; detail?: string }>
  | Readonly<{ kind: "withdrawn"; reason?: string }>
  | Readonly<{ kind: "canceled"; by?: string; reason?: string; run?: string }>

export type SeededRev = Readonly<{
  headSha: string
  baseSha?: string
  /** default: submitted (pushed + submitted); "pushed" stops at the push. */
  delivery?: "pushed" | "submitted"
  /** append a pr/checks-requested fact for this revision */
  checksRequested?: boolean | Readonly<{ baseSha?: string }>
}>

export type ChangeSeed = Readonly<{
  pr: string
  branch: string
  base?: string
  issue?: string
  name?: string
  bay?: string
  props?: Readonly<Record<string, string>>
  submitter?: string
  /** Revisions in order; revision numbers are 1-based positions. */
  revs: readonly SeededRev[]
  terminal?: SeededTerminal
}>

type SeededEvent = Readonly<{ id: string; name: string; ts: string; data: Record<string, unknown> }>

/** Seed ids live in their own uuid lane (`…-7000-9000-…`) so they can never
 * collide with the `…-7000-8000-…` sequence test apps inject for runtime ids. */
function seedIds(): () => string {
  let value = 0
  return () => `00000000-0000-7000-9000-${(++value).toString(16).padStart(12, "0")}`
}

/** One journal entry holding every seeded change, ready for
 * `createMemoryJournal([entry])`. Replay materializes the records exactly as
 * the retired verbs would have left them. */
export function seededChangesEntry(
  seeds: readonly ChangeSeed[],
  options: Readonly<{ at?: string }> = {},
): Readonly<{
  command: Readonly<{ id: string; op: string }>
  cause: Readonly<{ id: string; commandId: string; op: string; commandHash: string }>
  events: readonly SeededEvent[]
}> {
  const at = options.at ?? "2026-07-09T11:59:00.000Z"
  const nextId = seedIds()
  const command = { id: nextId(), op: "fixture.seed" }
  const events: SeededEvent[] = []
  for (const seed of seeds) {
    const base = seed.base ?? "main"
    const submitter = seed.submitter ?? "fixture"
    let lastHead = ""
    let lastRevision = 0
    seed.revs.forEach((rev, index) => {
      const revision = index + 1
      lastHead = rev.headSha
      lastRevision = revision
      events.push({
        id: nextId(),
        name: "pr/pushed",
        ts: at,
        data: {
          pr: seed.pr,
          branch: seed.branch,
          base,
          headSha: rev.headSha,
          revision,
          // The stable Change-Id (shape `I` + 40 hex) is only shape-validated.
          changeId: `I${rev.headSha.slice(0, 40)}`,
          submitter,
          ...(rev.baseSha === undefined ? {} : { baseSha: rev.baseSha }),
          ...(seed.issue === undefined ? {} : { issue: seed.issue }),
          ...(seed.name === undefined ? {} : { name: seed.name }),
          ...(seed.bay === undefined ? {} : { bay: seed.bay }),
          ...(seed.props === undefined ? {} : { props: seed.props }),
        },
      })
      if ((rev.delivery ?? "submitted") === "submitted") {
        events.push({
          id: nextId(),
          name: "pr/submitted",
          ts: at,
          data: { pr: seed.pr, revision, headSha: rev.headSha },
        })
      }
      if (rev.checksRequested !== undefined && rev.checksRequested !== false) {
        const requestBase = typeof rev.checksRequested === "object" ? rev.checksRequested.baseSha : undefined
        events.push({
          id: nextId(),
          name: "pr/checks-requested",
          ts: at,
          data: {
            pr: seed.pr,
            revision,
            headSha: rev.headSha,
            ...(requestBase === undefined ? {} : { baseSha: requestBase }),
          },
        })
      }
    })
    // The one PROJECTED fact: a live seed's standing submit ref. Written after
    // the revision history so its `at` is the newest, exactly as a real submit
    // lands after the push it approves.
    if (seed.terminal === undefined && (seed.revs.at(-1)?.delivery ?? "submitted") === "submitted") {
      if (lastRevision === 0) throw new Error(`seed ${seed.pr}: a live seed needs at least one revision`)
      events.push({
        id: nextId(),
        name: "branch/submitted",
        ts: at,
        data: { branch: seed.branch, sha: lastHead, base },
      })
    }
    const terminal = seed.terminal
    if (terminal !== undefined) {
      if (lastRevision === 0) throw new Error(`seed ${seed.pr}: a terminal seed needs at least one revision`)
      if (terminal.kind === "integrated") {
        events.push({
          id: nextId(),
          name: "pr/integrated",
          ts: at,
          data: {
            pr: seed.pr,
            revision: lastRevision,
            headSha: lastHead,
            run: terminal.run ?? `R-${seed.pr}`,
            commit: terminal.commit,
            landingSha: terminal.commit,
            baseSha: terminal.baseSha ?? "a".repeat(40),
          },
        })
      } else if (terminal.kind === "rejected") {
        events.push({
          id: nextId(),
          name: "pr/rejected",
          ts: at,
          data: {
            pr: seed.pr,
            revision: lastRevision,
            headSha: lastHead,
            run: terminal.run ?? `R-${seed.pr}`,
            step: terminal.step ?? "check",
            submitter: seed.submitter ?? "fixture",
            ...(terminal.detail === undefined ? {} : { detail: terminal.detail }),
          },
        })
      } else if (terminal.kind === "withdrawn") {
        events.push({
          id: nextId(),
          name: "pr/withdrawn",
          ts: at,
          data: {
            pr: seed.pr,
            revision: lastRevision,
            headSha: lastHead,
            ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
          },
        })
      } else {
        events.push({
          id: nextId(),
          name: "pr/canceled",
          ts: at,
          data: {
            pr: seed.pr,
            revision: lastRevision,
            headSha: lastHead,
            run: terminal.run ?? `R-${seed.pr}`,
            by: terminal.by ?? "fixture",
            reason: terminal.reason ?? "seeded cancel",
          },
        })
      }
    }
  }
  return {
    command,
    cause: { id: nextId(), commandId: command.id, op: command.op, commandHash: Command.hash(command) },
    events,
  }
}
