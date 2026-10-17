/** Shared remote custody sequence; callers own ending and archive eligibility. */
import type { QueueLocation } from "./events.ts"
import { listRefs } from "./git.ts"

export type OriginRetirementAuthority =
  | Readonly<{ kind: "event"; ref: string; tip: string }>
  | Readonly<{ kind: "published-main"; ref: string; tip: string }>

/** Prepare one archive lease and its custody readback, alone or inside an ending-event push. */
export async function prepareRetirementArchive(
  store: QueueLocation,
  input: Readonly<{ branch: string; archive: string; head: string }>,
) {
  const { branch, archive, head } = input
  const subject = `${branch}@${head} at ${store.remote}`
  const previous = (await listRefs(archive, store)).get(archive)
  if (previous !== undefined && previous !== head) {
    throw new Error(`${subject}: archive ${archive} holds ${previous}, not ${head}; it is never overwritten`)
  }
  return {
    update: { ref: archive, expect: previous ?? null, oid: head },
    async verify(): Promise<void> {
      const observed = (await listRefs(archive, store)).get(archive)
      if (observed !== head) {
        throw new Error(`${subject}: archive ${archive} did not read back as ${head}; found ${observed ?? "absent"}`)
      }
    },
  }
}

/** Publish the core archive step alone; ending events use its same preparation and readback. */
export async function publishRetirementArchive(
  store: QueueLocation,
  input: Readonly<{ branch: string; archive: string; head: string; authority?: OriginRetirementAuthority }>,
): Promise<void> {
  const { branch, head, authority } = input
  const publish = store.backend.publish
  if (publish === undefined) throw new Error(`${branch}@${head} at ${store.remote}: backend lacks archive publication`)
  const archive = await prepareRetirementArchive(store, input)
  await publish(
    store.repo,
    [
      ...(authority === undefined ? [] : [{ ref: authority.ref, expect: authority.tip, oid: authority.tip }]),
      { ...archive.update, expect: archive.update.expect ?? "0".repeat(head.length) },
    ],
    store.remote,
  )
  await archive.verify()
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
  const { branch, head, authority, archive } = input
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
    if (fetch === undefined || contains === undefined) {
      throw new Error(`${subject}: backend cannot read fresh published-main ancestry`)
    }
    const observed = (await fetch(store.repo, authority.ref, store.remote)).get(authority.ref)
    if (observed !== authority.tip) {
      throw new Error(
        `${subject}: published main moved: ${authority.ref} expected ${authority.tip}, found ${observed ?? "absent"}`,
      )
    }
    if (!(await contains(store.repo, head, authority.tip))) {
      throw new Error(`${subject}: tip is not an ancestor of published ${authority.ref}@${authority.tip}`)
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
    throw new Error(
      `${subject}: ${authority.kind === "event" ? "change" : "published main"} moved during retirement; ${authority.ref} expected ${authority.tip}, found ${authorities.get(authority.ref) ?? "absent"}; ` +
        (archive === undefined ? "caller established published-main custody; " : `archive ${archive} holds ${head}; `) +
        `restore branch ${branch} from that custody: git branch '${branch.replaceAll("'", "'\\''")}' ${head}`,
    )
  }
}
