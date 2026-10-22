/** Shared remote custody sequence; callers own ending eligibility and the custody that keeps the head (30683). */
import { shellQuote } from "git-super/shell-command"
import type { QueueLocation } from "./events.ts"
import { listRefs } from "./git.ts"

export type OriginRetirementAuthority =
  | Readonly<{ kind: "event"; ref: string; tip: string }>
  | Readonly<{ kind: "published-main"; ref: string; tip: string }>

export async function retireOriginBranch(
  store: QueueLocation,
  input: Readonly<{
    branch: string
    head: string
    authority: OriginRetirementAuthority
    protections?: () => Promise<readonly string[]>
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
}
