/** Shared remote custody sequence; callers own ending eligibility and the custody that keeps the head (30683). */
import { shellQuote } from "git-super/shell-command"
import type { QueueLocation } from "./events.ts"
import { configMatches, gitIn, listRefs, refAt, type Git } from "./git.ts"

export type OriginRetirementAuthority =
  | Readonly<{ kind: "event"; ref: string; tip: string }>
  | Readonly<{ kind: "published-main"; ref: string; tip: string }>

/**
 * Delete one checkout's remote-tracking ref for a branch whose origin retirement completed, at exactly the retired
 * head (31457). `git push --delete` updates that ref itself; a Gitomic publish never does, so the ref outlived every
 * retirement, a reader of the checkout kept paging on it, and an env open could adopt it again. The remote is
 * `remote` as a configured remote name, else each configured remote whose url equals it byte for byte. A checkout
 * with neither has no tracking namespace for that remote, so there is nothing to delete. Git's old-value check keeps
 * the delete exact: a ref at another oid is left and named on stderr; an absent ref is a silent no-op.
 */
async function dropTrackingRef(git: Git, remote: string, branch: string, head: string): Promise<void> {
  const listed = await configMatches(git, "^remote\\..*\\.url$")
  // No remote url is configured: no tracking namespace, nothing to delete.
  if (listed === undefined) return
  const remotes = listed
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const split = entry.indexOf("\n")
      return { name: entry.slice("remote.".length, split - ".url".length), url: entry.slice(split + 1) }
    })
  const names = remotes.some((configured) => configured.name === remote)
    ? [remote]
    : remotes.filter((configured) => configured.url === remote).map((configured) => configured.name)
  for (const name of names) {
    const ref = `refs/remotes/${name}/${branch}`
    const found = await refAt(git, ref)
    if (found === undefined) continue
    if (found !== head) {
      console.warn(`yrd: kept ${ref} at ${found}; the retired head was ${head}`)
      continue
    }
    await git(["update-ref", "-d", ref, head])
  }
}

/**
 * The tracking ref for a retired branch in the store, and in the caller's checkout when one is named (31457):
 * the CLI's store is Yrd's private replica, so only the checkout holds the ref its owner and readers see.
 */
export async function dropTrackingRefs(
  store: QueueLocation,
  trackingRepo: string | undefined,
  branch: string,
  head: string,
): Promise<void> {
  for (const repo of trackingRepo === undefined ? [store.repo] : [store.repo, trackingRepo]) {
    await dropTrackingRef(gitIn(repo, undefined, store.selection), store.remote, branch, head)
  }
}

export async function retireOriginBranch(
  store: QueueLocation,
  input: Readonly<{
    branch: string
    head: string
    authority: OriginRetirementAuthority
    protections?: () => Promise<readonly string[]>
    /** The caller's checkout; omitted only by a caller with none (the service, a store-only test). */
    trackingRepo?: string
  }>,
): Promise<void> {
  const { branch, head, authority } = input
  const branchRef = `refs/heads/${branch}`
  const subject = `${branchRef}@${head} at ${store.remote}`
  const publish = store.backend.publish
  if (publish === undefined) throw new Error(`${subject}: Gitomic backend lacks publish for retirement`)
  const protect = async (): Promise<void> => {
    const reasons = await input.protections?.()
    if (reasons !== undefined && reasons.length > 0) throw new Error(`${subject}: kept: ${reasons.join("; ")}`)
  }
  await protect()
  if (authority.kind === "published-main") {
    const fetch = store.backend.fetchRefs
    const contains = store.backend.isAncestor
    if (fetch === undefined) throw new Error(`${subject}: backend cannot read fresh published-main ancestry`)
    const observed = (await fetch(store.repo, authority.ref, store.remote)).get(authority.ref)
    if (observed !== authority.tip) {
      throw new Error(
        `${subject}: published main moved: ${authority.ref} expected ${authority.tip}, found ${observed ?? "absent"}`,
      )
    }
    if (contains === undefined) throw new Error(`${subject}: backend cannot read fresh published-main ancestry`)
    if (!(await contains(store.repo, head, authority.tip))) {
      throw new Error(`${subject}: tip is not an ancestor of published ${authority.ref}@${authority.tip}`)
    }
  }
  await protect()
  await publish(
    store.repo,
    [
      { ref: authority.ref, expect: authority.tip, oid: authority.tip },
      { ref: branchRef, expect: head, oid: null },
    ],
    store.remote,
  )
  const [branches, authorities] = await Promise.all([listRefs(branchRef, store), listRefs(authority.ref, store)])
  const branchHead = branches.get(branchRef)
  if (branchHead !== undefined) throw new Error(`${subject}: removal did not read back absent; found ${branchHead}`)
  // A server may omit the same-value authority lease from its transaction. The
  // lease narrows that race; this readback makes moved custody a loud failure.
  if (authorities.get(authority.ref) !== authority.tip) {
    const localHead = (await listRefs(branchRef, { repo: store.repo, backend: store.backend })).get(branchRef)
    const git = `git -C ${shellQuote(store.repo)}`
    const recovery =
      localHead !== undefined
        ? `local branch ${branch} still points to ${localHead}; inspect it: ${git} show-ref --verify ${shellQuote(branchRef)}`
        : authority.kind === "event"
          ? `restore branch ${branch} from the event that keeps it: ${git} fetch ${shellQuote(store.remote)} ${shellQuote(authority.ref)} && ${git} branch ${shellQuote(branch)} ${shellQuote(head)}`
          : `restore branch ${branch} from the published main fetched before retirement: ${git} branch ${shellQuote(branch)} ${shellQuote(head)}`
    throw new Error(
      `${subject}: ${authority.kind === "event" ? "change" : "published main"} moved during retirement; ${authority.ref} expected ${authority.tip}, found ${authorities.get(authority.ref) ?? "absent"}; ` +
        (authority.kind === "event"
          ? `event ${authority.tip} keeps ${head}; `
          : "caller established published-main custody; ") +
        recovery,
    )
  }
  // Last, after both readbacks (31457): the tracking ref `git push --delete` would have removed with the branch.
  await dropTrackingRefs(store, input.trackingRepo, branch, head)
}
