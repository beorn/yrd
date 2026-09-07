/**
 * The garage, as a declaration in git.
 *
 * A service in the garage has its automatic form stopped and one seat, the
 * mechanic, doing its work themselves (`CONTEXT.md` § Garage). For the merge
 * queue that record has to be readable by yrd itself, from the queue's own
 * repository, with nothing else running.
 *
 * WHY IT IS A REF. The first garage recorded itself in hab's declared-stop
 * record for the queue-runner service, and `queue list` read it from there.
 * On 2026-09-02 the composed hab plan stopped declaring that service at all —
 * the only way to keep `hab up <seat>` from starting it — so the record
 * vanished and the status line fell back to "NO RUNNER - habitant runner [pid]
 * died ...; restart it", which is false in the garage and names the one act the
 * garage forbids. A record whose store disappears when the service is turned off
 * is the wrong store. Git is the truth (plan of record, principle 1), so the
 * garage is `refs/yrd/garage` in the queue's repository: a commit with no
 * parent whose message is `garage: <reason>` and whose `Opened-By:` trailer
 * names the mechanic, with the time taken from the commit itself.
 *
 * READS ARE GIT, EVERY TIME. No cache, no file beside the journal, no state
 * the app has to be booted to see. That is what lets the resident's own
 * refusal run before it takes the queue-runner lease, and what lets
 * `queue list` answer in a repository where yrd has never run.
 *
 * NOT PUSHED. The mechanic's repository is the truth; yrd never pushes this
 * ref anywhere, and nothing fetches it.
 */
import { refAt, type Git } from "@yrd/queue-core"

/** The one ref. A garage is open exactly when it exists. */
export const GARAGE_REF = "refs/yrd/garage"

/** The trailer naming the seat that opened the garage. */
export const GARAGE_OPENED_BY_TRAILER = "Opened-By"

/** The commit message's first line, which is also how the reason is read back. */
const GARAGE_SUBJECT_PREFIX = "garage: "

/** The env yrd already reads to name the seat operating it. */
const GARAGE_SEAT_ENV = "YRD_DEFAULT_SUBMITTER"

/** An open garage, exactly as the ref records it. */
export type GarageDeclaration = Readonly<{
  /** Why the service is in the garage, from the commit's subject. */
  reason: string
  /** When it was opened, from the commit itself. Strict ISO 8601. */
  since: string
  /** The seat that opened it, from the `Opened-By:` trailer. */
  by: string
}>

/**
 * The seat this invocation is. The same environment variable yrd already uses
 * to name who is operating it, with the same `operator` default the host
 * applies, so the garage's `Opened-By:` and a change's submitter never
 * disagree about who is at the keyboard.
 */
export function garageSeat(env: NodeJS.ProcessEnv): string {
  const declared = env[GARAGE_SEAT_ENV]?.trim()
  return declared === undefined || declared === "" ? "operator" : declared
}

/** What the queue timeline prints while the garage is open. */
export function garageStatusLine(garage: GarageDeclaration): string {
  return `garage: ${garage.reason} since ${garage.since} by ${garage.by}`
}

/** The one line the service prints instead of starting. */
export function garageServiceRefusal(garage: GarageDeclaration): string {
  return `garage: ${garage.reason}; the service stays down until the garage closes`
}

/**
 * The garage as the ref records it, or undefined when no garage is open.
 *
 * Two git reads: the ref, then the commit it names. A ref that exists but whose
 * commit does not say `garage: …`, or does not name its opener, is a LOUD
 * failure and never a quiet "no garage" — a declaration nobody can read is not
 * the same record as no declaration (NO SILENT ERRORS).
 */
export async function readGarageDeclaration(repo: string, git: Git): Promise<GarageDeclaration | undefined> {
  if ((await garageRefCommit(repo, git)) === undefined) return undefined
  const shown = await git(["show", "--no-patch", `--format=%aI%n%B`, GARAGE_REF])
  const [since, ...body] = shown.split("\n")
  const message = body.join("\n")
  const subject = message.split("\n")[0] ?? ""
  if (since === undefined || since === "" || !subject.startsWith(GARAGE_SUBJECT_PREFIX)) {
    throw new Error(
      `yrd: ${GARAGE_REF} in '${repo}' is not a garage declaration: its commit subject is '${subject}', ` +
        `and a garage's is '${GARAGE_SUBJECT_PREFIX}<reason>'. Delete the ref or reopen the garage with ` +
        "'yrd queue garage open --reason <text>'.",
    )
  }
  const by = trailer(message, GARAGE_OPENED_BY_TRAILER)
  if (by === undefined) {
    throw new Error(
      `yrd: ${GARAGE_REF} in '${repo}' names no ${GARAGE_OPENED_BY_TRAILER}, so nobody owns this garage. ` +
        "Reopen it with 'yrd queue garage open --reason <text>'.",
    )
  }
  return Object.freeze({ reason: subject.slice(GARAGE_SUBJECT_PREFIX.length), since, by })
}

function trailer(message: string, key: string): string | undefined {
  const prefix = `${key}:`
  for (const line of message.split("\n").toReversed()) {
    if (!line.startsWith(prefix)) continue
    const value = line.slice(prefix.length).trim()
    return value === "" ? undefined : value
  }
  return undefined
}

/**
 * Open the garage: one commit with no parent and an empty tree, and the ref
 * pointing at it.
 *
 * The ref is created with git's own compare-and-swap against "no such ref", so
 * two mechanics opening at once cannot both win; the read above it is what lets
 * the loser be told whose garage it already is.
 */
export async function openGarage(
  repo: string,
  input: Readonly<{ reason: string; by: string }>,
  git: Git,
): Promise<Readonly<{ garage: GarageDeclaration; commit: string }>> {
  const reason = input.reason.trim()
  if (reason === "") throw new Error("yrd: a garage needs a reason; pass --reason '<why the service is off>'")
  if (reason.includes("\n")) throw new Error("yrd: a garage reason is one line")
  const message = `${GARAGE_SUBJECT_PREFIX}${reason}\n\n${GARAGE_OPENED_BY_TRAILER}: ${input.by}\n`
  // `mktree` with nothing on stdin is the empty tree in this repository's own
  // object format, so this works in a sha256 repository too.
  const tree = (await git(["mktree"], "")).trim()
  const commit = (await git(["commit-tree", tree, "-m", message])).trim()
  // Native `create` verifies absence without an empty argv word.
  await git(["update-ref", "--create-reflog", "--stdin"], `create ${GARAGE_REF} ${commit}\n`)
  const garage = await readGarageDeclaration(repo, git)
  if (garage === undefined) throw new Error(`yrd: ${GARAGE_REF} was written but does not read back in '${repo}'`)
  return { garage, commit }
}

/** Close the garage: delete the ref. The commit stays in the object store. */
export async function closeGarage(_repo: string, at: string, git: Git): Promise<void> {
  await git(["update-ref", "-d", GARAGE_REF, at])
}

/**
 * The commit the ref points at, or undefined when no garage is open — the one
 * read every other function here starts from, and what `closeGarage` compares
 * against.
 *
 * The core owns absence: only a clean missing-ref result means closed.
 * An unreadable ref, failed invocation or non-repository path throws before
 * the service starts. The bound Git retains the invocation and its evidence.
 */
export async function garageRefCommit(_repo: string, git: Git): Promise<string | undefined> {
  return refAt(git, GARAGE_REF)
}
