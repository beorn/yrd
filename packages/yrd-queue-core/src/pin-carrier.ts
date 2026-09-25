import { createHash } from "node:crypto"
import { join } from "node:path"
import { composeGitlinkCarrier, type GitlinkCarrierPin } from "git-super/gitlink-carrier"
import { createLocalGitProcess } from "git-super/process"
import type { Target } from "./config.ts"
import {
  createEventStore,
  gitIn,
  gitlinkRows,
  isAncestor,
  mergeBase,
  readRemoteCommit,
  selectionFor,
  type Git,
} from "./git.ts"
import { isOpen, listChanges, queueFormat } from "./events.ts"
import { populateReferenceStores } from "./reference.ts"
import { readQueue, remoteUrl } from "./remote.ts"
import { holdsPlaceInLine, readChange } from "./state.ts"

export type PinCarrierPin = Readonly<{ path: string; sha: string }>
export type PreparedPinCarrier = Readonly<{ branch: string; head: string; targetHead: string }>

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu

function orderedPins(pins: readonly PinCarrierPin[]): readonly PinCarrierPin[] {
  if (pins.length === 0) throw new Error("--gitlink needs at least one path=full-sha pin")
  const sorted = [...pins].sort((a, b) => a.path.localeCompare(b.path))
  const seen = new Set<string>()
  for (const pin of sorted) {
    if (
      pin.path === "" ||
      pin.path.startsWith("/") ||
      pin.path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`invalid gitlink path ${pin.path}`)
    }
    if (!FULL_SHA.test(pin.sha)) throw new Error(`${pin.path} needs a full commit SHA, got ${pin.sha}`)
    if (seen.has(pin.path)) throw new Error(`duplicate --gitlink path ${pin.path}`)
    seen.add(pin.path)
  }
  return sorted
}

function pinIdentity(pins: readonly PinCarrierPin[]): string {
  return pins.map((pin) => `${pin.path}=${pin.sha.toLowerCase()}`).join("\n")
}

export function pinCarrierName(pins: readonly PinCarrierPin[]): string {
  const sorted = orderedPins(pins)
  const only = sorted[0]
  if (sorted.length === 1 && only !== undefined) return `pin/${only.path.replaceAll("/", "-")}/${only.sha.slice(0, 12)}`
  const paths = sorted.map((pin) => pin.path.replaceAll("/", "-")).join("+")
  const digest = createHash("sha256").update(pinIdentity(sorted)).digest("hex").slice(0, 12)
  return `pin/${paths}/${digest}`
}

/** Build a carrier in the queue-owned clone. No branch or remote ref is written. */
export async function preparePinCarrier(
  options: Readonly<{
    git: Git
    repo: string
    target: Target
    issue: string
    pins: readonly PinCarrierPin[]
    env: NodeJS.ProcessEnv
  }>,
): Promise<PreparedPinCarrier> {
  const { git, repo, target, issue, env } = options
  if (issue.trim() === "" || issue !== issue.trim() || /[\u0000-\u001f\u007f]/u.test(issue)) {
    throw new Error("--issue needs a nonempty single-line value without surrounding whitespace")
  }
  const pins = orderedPins(options.pins)
  const targetHead = await readRemoteCommit(git, target.remote, `refs/heads/${target.branch}`)
  if (targetHead === undefined) throw new Error(`${target.remote}/${target.branch} has no advertised target branch`)
  const childGit = (path: string) => gitIn(path, undefined, selectionFor(git), { env })
  await populateReferenceStores({ repo, commit: targetHead, gitIn: childGit })
  const subjects: string[] = []
  for (const pin of pins) {
    const child = childGit(join(repo, pin.path))
    const remote = await remoteUrl(child, "origin")
    try {
      // A local object is insufficient: the queue must be able to fetch this
      // exact pin after the carrier is submitted.
      await child([
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "origin",
        pin.sha,
      ])
    } catch (cause) {
      throw new Error(`${pin.path}@${pin.sha} is not fetchable from ${remote}; publish the component commit first`, {
        cause,
      })
    }
    const current = (await git(["rev-parse", `${targetHead}:${pin.path}`])).trim()
    if (await isAncestor(child, pin.sha, current)) {
      throw new Error(`${target.remote}/${target.branch} already holds ${pin.path}@${pin.sha} at or beyond that pin`)
    }
    subjects.push((await child(["show", "-s", "--format=%s", pin.sha])).trim())
  }

  const identity = pinIdentity(pins)
  const changes: Array<Readonly<{ branch: string; head: string; open: boolean }>> = []
  const store = createEventStore(repo, target.remote, selectionFor(git))
  if ((await queueFormat(store, target.branch)) === "event") {
    for (const [branch, change] of await listChanges(store, target.branch)) {
      if (change.commit !== undefined) {
        changes.push({ branch, head: change.commit, open: isOpen(change.status) })
      }
    }
  } else {
    const reading = await readQueue(git, target.remote, target.branch, targetHead)
    for (const entry of reading.changes) {
      changes.push({
        branch: entry.change.branch,
        head: entry.change.head,
        open: holdsPlaceInLine(readChange(entry.change).state),
      })
    }
  }
  for (const change of changes) {
    if (!change.open) continue
    // Compare merge-base..head so multi-commit changes expose gitlinks moved in
    // any commit across their branch history, not only in change.head^.
    // For single-commit pin carriers, merge-base with targetHead is targetHead (== head^).
    const base =
      (await mergeBase(git, change.head, targetHead)) ??
      (await git(["rev-parse", `${change.head}^`]).catch(() => "")).trim()
    if (base === "" || base === change.head) continue
    const moved = (await gitlinkRows(git, base, change.head))
      .filter((row) => row.newMode === "160000")
      .map((row) => ({ path: row.path, sha: row.sha }))
    if (moved.length > 0 && pinIdentity(orderedPins(moved)) === identity) {
      throw new Error(`pin set already has open change ${change.branch}; inspect yrd queue show ${change.branch}`)
    }
  }

  const baseName = pinCarrierName(pins)
  let branch = baseName
  for (let revision = 1; ; revision += 1) {
    const held = changes.find((change) => change.branch === branch)
    const remoteHead = await readRemoteCommit(git, target.remote, `refs/heads/${branch}`)
    if (held === undefined && remoteHead === undefined) break
    if (held === undefined || held.open) {
      throw new Error(
        `${branch} is already held${held === undefined ? " as a draft" : " by an open change"}; inspect yrd queue show ${branch}`,
      )
    }
    branch = `${baseName}-r${revision + 1}`
  }
  await git(["check-ref-format", "--branch", branch])
  const local = (await git(["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])).trim()
  if (local !== "") throw new Error(`local ${branch} already exists at ${local}; no carrier ref was changed`)

  const onlyPin = pins[0]
  const subject =
    pins.length === 1 && onlyPin !== undefined
      ? `carry ${onlyPin.path.split("/").at(-1)}@${onlyPin.sha.slice(0, 12)}: ${subjects[0]}`
      : `carry ${pins.length} gitlink pins: ${pins.map((pin) => pin.path).join(", ")}`
  const message = `${subject}\n\nRefs: ${issue}\nPin-Set: ${createHash("sha256").update(identity).digest("hex")}\n`
  const carrierPins: GitlinkCarrierPin[] = pins.map((pin) => ({ path: pin.path, commit: pin.sha }))
  const carrier = await composeGitlinkCarrier({
    repo,
    base: targetHead,
    pins: carrierPins,
    message,
    git: createLocalGitProcess(env),
  })
  return { branch, head: carrier.commit, targetHead }
}
