/** Shared remote custody sequence; callers own ending and archive eligibility. */
import { shellQuote } from "git-super/shell-command"
import type { QueueLocation } from "./events.ts"
import { gitIn, listRefs, mergeChangesNothing, refAt } from "./git.ts"

export type OriginRetirementAuthority =
  | Readonly<{ kind: "event"; ref: string; tip: string }>
  | Readonly<{ kind: "published-main"; ref: string; tip: string }>
  | Readonly<{ kind: "published-main-content"; ref: string; tip: string; archive: string }>

/** Prepare one archive lease and its custody readback, alone or inside an ending-event push. */
export async function prepareRetirementArchive(
  store: QueueLocation,
  input: Readonly<{ branch: string; archive: string; head: string }>,
) {
  const { branch, archive, head } = input
  const subject = `${branch}@${head} at ${store.remote}`
  const publish = store.backend.publish
  if (publish === undefined) throw new Error(`${subject}: backend lacks archive publication`)
  const previous = (await listRefs(archive, store)).get(archive)
  if (previous !== undefined && previous !== head) {
    throw new Error(`${subject}: archive ${archive} already holds ${previous}, not ${head}; it is never overwritten`)
  }
  const update = { ref: archive, expect: previous ?? null, oid: head }
  const verify = async (): Promise<void> => {
    const observed = (await listRefs(archive, store)).get(archive)
    if (observed !== head) {
      throw new Error(`${subject}: archive ${archive} did not read back as ${head}; found ${observed ?? "absent"}`)
    }
  }
  return {
    update,
    verify,
    async publish(authority?: OriginRetirementAuthority): Promise<void> {
      try {
        await publish(
          store.repo,
          [
            ...(authority === undefined ? [] : [{ ref: authority.ref, expect: authority.tip, oid: authority.tip }]),
            { ...update, expect: update.expect ?? "0".repeat(head.length) },
          ],
          store.remote,
        )
      } catch (cause) {
        throw new Error(
          `${subject}: archive publication failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        )
      }
      await verify()
    },
  }
}

/** Publish the core archive step alone; ending events use its same preparation and readback. */
export async function publishRetirementArchive(
  store: QueueLocation,
  input: Readonly<{ branch: string; archive: string; head: string; authority?: OriginRetirementAuthority }>,
): Promise<void> {
  const archive = await prepareRetirementArchive(store, input)
  await archive.publish(input.authority)
}

export async function retireOriginBranch(
  store: QueueLocation,
  input: Readonly<{
    branch: string
    head: string
    authority: OriginRetirementAuthority
    archive?: string
    protections?: () => Promise<readonly string[]>
  }>,
): Promise<void> {
  const { branch, head, authority } = input
  const archive = authority.kind === "published-main-content" ? authority.archive : input.archive
  const branchRef = `refs/heads/${branch}`
  const subject = `${branchRef}@${head} at ${store.remote}`
  if (authority.kind === "published-main-content" && (typeof archive !== "string" || archive.length === 0)) {
    throw new Error(`${subject}: content retirement requires an exact-tip archive`)
  }
  const publish = store.backend.publish
  if (publish === undefined) throw new Error(`${subject}: Gitomic backend lacks publish for retirement`)
  const protect = async (): Promise<void> => {
    const reasons = await input.protections?.()
    if (reasons !== undefined && reasons.length > 0) throw new Error(`${subject}: kept: ${reasons.join("; ")}`)
  }
  await protect()
  if (authority.kind === "published-main" || authority.kind === "published-main-content") {
    const fetch = store.backend.fetchRefs
    const contains = store.backend.isAncestor
    if (fetch === undefined) {
      throw new Error(
        `${subject}: backend cannot read fresh published-main ${authority.kind === "published-main" ? "ancestry" : "content authority"}`,
      )
    }
    const observed = (await fetch(store.repo, authority.ref, store.remote)).get(authority.ref)
    if (observed !== authority.tip) {
      throw new Error(
        `${subject}: published main moved: ${authority.ref} expected ${authority.tip}, found ${observed ?? "absent"}`,
      )
    }
    if (authority.kind === "published-main-content") {
      if (!(await mergeChangesNothing(gitIn(store.repo, undefined, store.selection), authority.tip, head))) {
        throw new Error(`${subject}: merging tip into published ${authority.ref}@${authority.tip} changes its tree`)
      }
    } else {
      if (contains === undefined) throw new Error(`${subject}: backend cannot read fresh published-main ancestry`)
      if (!(await contains(store.repo, head, authority.tip))) {
        throw new Error(`${subject}: tip is not an ancestor of published ${authority.ref}@${authority.tip}`)
      }
    }
  }
  if (archive !== undefined) {
    await publishRetirementArchive(store, { branch, archive, head, authority })
  }
  await protect()
  await publish(
    store.repo,
    [
      { ref: authority.ref, expect: authority.tip, oid: authority.tip },
      ...(archive === undefined ? [] : [{ ref: archive, expect: head, oid: head }]),
      { ref: branchRef, expect: head, oid: null },
    ],
    store.remote,
  )
  const [branches, archives, authorities] = await Promise.all([
    listRefs(branchRef, store),
    archive === undefined ? Promise.resolve(undefined) : listRefs(archive, store),
    listRefs(authority.ref, store),
  ])
  const branchHead = branches.get(branchRef)
  if (
    authority.kind === "published-main-content" &&
    (branchHead !== undefined ||
      archives?.get(authority.archive) !== head ||
      authorities.get(authority.ref) !== authority.tip)
  ) {
    const localHead = (await listRefs(branchRef, { repo: store.repo, backend: store.backend })).get(branchRef)
    const git = `git -C ${shellQuote(store.repo)}`
    const originCustody =
      branchHead === head ? branchRef : archives?.get(authority.archive) === head ? authority.archive : undefined
    const recovery =
      originCustody !== undefined
        ? `exact commit retained at ${store.remote}:${originCustody}; inspect it: ${git} fetch ${shellQuote(store.remote)} ${shellQuote(originCustody)} && ${git} show ${shellQuote(head)}`
        : localHead === head
          ? `local branch ${branch} still retains the exact commit; inspect it: ${git} show-ref --verify ${shellQuote(branchRef)}`
          : (await refAt(gitIn(store.repo, undefined, store.selection), head)) === head
            ? `exact commit remains in local objects; inspect it: ${git} show ${shellQuote(head)}`
            : "no exact-tip recovery source remains in the observed origin refs or local objects; recover it from another retained copy"
    throw new Error(
      `${subject}: retirement failed after conditional removal; observed ${branchRef}=${branchHead ?? "absent"}, ` +
        `${authority.archive}=${archives?.get(authority.archive) ?? "absent"}, ${authority.ref}=${authorities.get(authority.ref) ?? "absent"}; ` +
        `main content equality does not retain the original commit; ${recovery}`,
    )
  }
  if (branchHead !== undefined) throw new Error(`${subject}: removal did not read back absent; found ${branchHead}`)
  // A server may omit a same-value archive update from its transaction. The
  // lease narrows that race; this readback makes lost custody a loud failure.
  if (archive !== undefined && archives?.get(archive) !== head) {
    throw new Error(
      `${subject}: archive ${archive} no longer holds ${head} after removal; ` +
        `found ${archives?.get(archive) ?? "absent"}; retaining ${authority.kind} ${authority.ref}@${authority.tip} keeps ${head}`,
    )
  }
  if (authorities.get(authority.ref) !== authority.tip) {
    const localHead = (await listRefs(branchRef, { repo: store.repo, backend: store.backend })).get(branchRef)
    const git = `git -C ${shellQuote(store.repo)}`
    const recovery =
      localHead !== undefined
        ? `local branch ${branch} still points to ${localHead}; inspect it: ${git} show-ref --verify ${shellQuote(branchRef)}`
        : archive !== undefined
          ? `restore branch ${branch} from that custody: ${git} fetch ${shellQuote(store.remote)} ${shellQuote(archive)} && ${git} branch ${shellQuote(branch)} ${shellQuote(head)}`
          : authority.kind === "published-main"
            ? `restore branch ${branch} from the published main fetched before retirement: ${git} branch ${shellQuote(branch)} ${shellQuote(head)}`
            : `obtain ${head} from the caller's published-main custody in ${store.repo} before restoring local branch ${branch}`
    throw new Error(
      `${subject}: ${authority.kind === "event" ? "change" : "published main"} moved during retirement; ${authority.ref} expected ${authority.tip}, found ${authorities.get(authority.ref) ?? "absent"}; ` +
        (archive === undefined ? "caller established published-main custody; " : `archive ${archive} holds ${head}; `) +
        recovery,
    )
  }
}
