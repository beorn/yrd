/** The runner's one remote health claim. Change facts never read this ref. */
import {
  formatRunnerClaim,
  judgeRunnerClaim,
  judgeRunnerDeadline,
  parseRunnerClaim,
  readRemoteCommit,
  runnerRef,
  type Git,
  type RunnerClaim,
  type RunnerDeadlineJudgment,
} from "@yrd/queue-core"

type Trailers = Readonly<{
  Runner: string
  Started: string
  At: string
  Beat: string
  State: RunnerClaim["state"]
  Holding?: string
  Since: string
  Deadline?: string
}>

export type PublishedRunner = Readonly<{
  signal: "fresh" | "silent" | "absent" | "unreadable"
  claim?: Trailers
  phase?: RunnerDeadlineJudgment
  /** Absence and unreadability must say where the reader looked and why it could not answer. */
  why?: string
}>

function trailers(claim: RunnerClaim): Trailers {
  return {
    Runner: `${claim.host}/${String(claim.pid)}`,
    Started: claim.started,
    At: claim.at,
    Beat: `${String(claim.beatMs)}ms`,
    State: claim.state,
    ...(claim.holding === undefined ? {} : { Holding: claim.holding }),
    Since: claim.since,
    ...(claim.deadline === undefined ? {} : { Deadline: claim.deadline }),
  }
}

async function claimAt(git: Git, oid: string, ref: string): Promise<RunnerClaim> {
  const ancestry = (await git(["rev-list", "--parents", "-n", "1", oid])).trim().split(/\s+/u)
  if (ancestry.length !== 1 || ancestry[0] !== oid) {
    throw new Error(`${ref} at ${oid}: runner claim must be a parentless root commit`)
  }
  return parseRunnerClaim(await git(["show", "-s", "--format=%B", oid]))
}

/** The tip comes from the same queue-ref fetch as the event listing, once per refresh. */
export async function readPublishedRunner(
  git: Git,
  queue: string,
  remote: string,
  tip: string | undefined,
  now: Date = new Date(),
): Promise<PublishedRunner> {
  const ref = runnerRef(queue)
  if (tip === undefined) return { signal: "absent", why: `${remote} ${ref} is absent` }
  try {
    const claim = await claimAt(git, tip, ref)
    const verdict = judgeRunnerClaim(claim, now)
    const phase = judgeRunnerDeadline(claim, now)
    return verdict.status === "unreadable"
      ? { signal: "unreadable", claim: trailers(claim), phase, why: `${remote} ${ref} at ${tip}: ${verdict.reason}` }
      : { signal: verdict.status, claim: trailers(claim), phase }
  } catch (error) {
    return {
      signal: "unreadable",
      why: `${remote} ${ref} at ${tip} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export class RunnerConflict extends Error {
  constructor(
    readonly other: RunnerClaim,
    readonly ref: string,
  ) {
    super(`${ref}: a fresh second runner ${other.host}/${String(other.pid)} started ${other.started} owns this queue`)
    this.name = "RunnerConflict"
  }
}

type Queued = { claim: RunnerClaim; beat: boolean; resolve: () => void }

/** Serial leased writes; pending beats coalesce while transitions retain their order. */
export class RunnerPublisher {
  readonly ref: string
  private tip: string | undefined
  private known = false
  private pending: Queued[] = []
  private running = false
  conflict: RunnerConflict | undefined

  constructor(
    private readonly git: Git,
    readonly remote: string,
    readonly queue: string,
    private readonly onStatus: (
      status: { kind: "ok"; at: string } | { kind: "failed"; cause: string; at: string },
    ) => void,
    private readonly onNotice: (line: string) => void,
  ) {
    this.ref = runnerRef(queue)
  }

  publish(claim: RunnerClaim, beat = false): Promise<void> {
    return new Promise((resolve) => {
      if (this.conflict !== undefined) {
        resolve()
        return
      }
      if (beat && this.pending.at(-1)?.beat === true) {
        // The old beat has not started its write. Its caller has no separate
        // outcome to await: the new beat carries its freshest At and state.
        this.pending.pop()?.resolve()
      }
      this.pending.push({ claim, beat, resolve })
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pending.length > 0 && this.conflict === undefined) {
        const next = this.pending.shift()
        if (next === undefined) break
        try {
          await this.write(next.claim)
          this.onStatus({ kind: "ok", at: new Date().toISOString() })
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error)
          if (error instanceof RunnerConflict) this.conflict = error
          this.onNotice(`runner publication failed for ${this.remote}#${this.queue} ${this.ref}: ${cause}`)
          this.onStatus({ kind: "failed", cause, at: new Date().toISOString() })
        } finally {
          next.resolve()
        }
      }
      if (this.conflict !== undefined) {
        for (const item of this.pending.splice(0)) item.resolve()
      }
    } finally {
      this.running = false
    }
  }

  private async inspect(claim: RunnerClaim, current: string | undefined): Promise<void> {
    if (current === undefined) {
      this.tip = undefined
      this.known = true
      return
    }
    const unreadable = (cause: string): Error =>
      new Error(
        `${this.ref} at ${current}: cannot take over an unreadable runner claim: ${cause}. ` +
          `After verifying no live runner, run \`git push ${this.remote} :${this.ref}\` to remove the claim.`,
      )
    let prior: RunnerClaim
    try {
      prior = await claimAt(this.git, current, this.ref)
    } catch (error) {
      throw unreadable(error instanceof Error ? error.message : String(error))
    }
    if (prior.host === claim.host && prior.pid === claim.pid && prior.started === claim.started) {
      this.tip = current
      this.known = true
      return
    }
    if (prior.state === "stopped") {
      this.onNotice(
        `taking over relinquished runner ${prior.host}/${String(prior.pid)} started ${prior.started} at ${this.ref}`,
      )
      this.tip = current
      this.known = true
      return
    }
    const verdict = judgeRunnerClaim(prior, new Date())
    if (verdict.status === "fresh") throw new RunnerConflict(prior, this.ref)
    if (verdict.status === "unreadable") {
      throw unreadable(verdict.reason)
    }
    this.onNotice(`taking over stale runner ${prior.host}/${String(prior.pid)} started ${prior.started} at ${this.ref}`)
    this.tip = current
    this.known = true
  }

  private async write(claim: RunnerClaim): Promise<void> {
    if (!this.known) await this.inspect(claim, await readRemoteCommit(this.git, this.remote, this.ref))
    const tree = (await this.git(["mktree"], "")).trim()
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(tree)) throw new Error(`git mktree returned ${JSON.stringify(tree)}`)
    const commit = (await this.git(["commit-tree", tree, "-m", formatRunnerClaim(claim)])).trim()
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)) {
      throw new Error(`git commit-tree returned ${JSON.stringify(commit)}`)
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const expected = this.tip ?? "0".repeat(40)
      try {
        await this.git([
          "push",
          "--porcelain",
          `--force-with-lease=${this.ref}:${expected}`,
          this.remote,
          `${commit}:${this.ref}`,
        ])
        this.tip = commit
        return
      } catch (error) {
        // The push may have landed despite a lost response. A failed lease may
        // also mean a second writer; re-read before deciding either way.
        const current = await readRemoteCommit(this.git, this.remote, this.ref)
        if (current === commit) {
          this.tip = commit
          return
        }
        if (current === this.tip) throw error
        await this.inspect(claim, current)
      }
    }
    throw new Error(`${this.ref}: leased publication changed four times; retry at the next beat`)
  }
}
