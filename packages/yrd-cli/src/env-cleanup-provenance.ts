import { resolve } from "node:path"
import {
  changesRef,
  enumerateChangeSegments,
  issueBindingsOf,
  listChangeHistories,
  normalizeIssueReference,
  type Git,
} from "@yrd/queue-core"
import { readReflogEntries } from "git-super"

/** Root-only evidence: created OIDs themselves, plus every recorded branch join. */
export async function environmentProvenance(
  cwd: string,
  git: Git,
  currentBranch?: string,
): Promise<Readonly<{ commits: readonly string[]; branches: readonly string[] }>> {
  const logPath = (await git(["rev-parse", "--git-path", "logs/HEAD"])).trim()
  if (logPath === "") throw new Error(`environment ${cwd}: Git returned no HEAD reflog path`)
  const path = resolve(cwd, logPath)
  const commits = new Set<string>()
  const branches = new Set<string>(currentBranch === undefined ? [] : [currentBranch])
  let first = true
  let lastOid: string | undefined
  const branch = (name: string): void => {
    if (name !== "HEAD" && !/^[0-9a-f]{40}$/iu.test(name)) branches.add(name)
  }
  for (const entry of readReflogEntries(path)) {
    if (lastOid !== undefined && entry.oldOid !== lastOid) {
      throw new Error(`environment ${cwd}: HEAD reflog ${path} has a discontinuous OID chain`)
    }
    lastOid = entry.newOid
    if (first) {
      first = false
      if (entry.oldOid !== "0".repeat(40)) {
        throw new Error(`environment ${cwd}: HEAD reflog ${path} lacks creation evidence`)
      }
      continue
    }
    const message = entry.message
    const checkout = /^checkout: moving from (.+) to (.+)$/u.exec(message)
    if (checkout?.[1] !== undefined && checkout[2] !== undefined) {
      branch(checkout[1])
      branch(checkout[2])
      continue
    }
    const finish = /^(?:rebase|rebase -i|pull --rebase) \(finish\): returning to refs\/heads\/(.+)$/u.exec(message)
    if (finish?.[1] !== undefined) {
      branch(finish[1])
      continue
    }
    if (/^(?:reset:|(?:rebase|rebase -i|pull --rebase) \((?:start|finish|abort)\):)/u.test(message)) continue
    if (/^(?:merge|pull)(?::| ).*Fast-forward/u.test(message)) continue
    if (
      /^(?:commit(?: \((?:amend|merge|initial)\))?|cherry-pick|revert|am):/u.test(message) ||
      /^(?:rebase|rebase -i|pull --rebase) \((?:pick|reword|edit|squash|fixup|continue)\):/u.test(message) ||
      /^(?:merge|pull)(?::| ).*Merge made by/u.test(message)
    ) {
      commits.add(entry.newOid)
      continue
    }
    throw new Error(`environment ${cwd}: unclassified HEAD reflog message in ${path}: ${JSON.stringify(message)}`)
  }
  if (first) throw new Error(`environment ${cwd}: HEAD reflog ${path} lacks creation evidence`)
  const head = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim()
  if (lastOid !== head) throw new Error(`environment ${cwd}: HEAD reflog ${path} does not end at current HEAD ${head}`)
  return { commits: [...commits], branches: [...branches] }
}

/** The complete root binding union; each recorded author span is decoded independently. */
export async function environmentIssues(
  cwd: string,
  git: Git,
  name: string,
  currentBranch: string | undefined,
  queueGit: Git,
  queue: string,
  store: Parameters<typeof listChangeHistories>[0],
  histories: Awaited<ReturnType<typeof listChangeHistories>>,
  resolveIssue: (raw: string) => Promise<string>,
): Promise<readonly string[]> {
  const provenance = await environmentProvenance(cwd, git, currentBranch)
  const issues = new Set<string>()
  const add = async (raw: string): Promise<void> => {
    issues.add(normalizeIssueReference(await resolveIssue(normalizeIssueReference(raw))))
  }
  for (const label of [name, ...provenance.branches]) {
    for (const match of label.matchAll(/(?:^|\/)(\d+)(?:-|$)/gu)) {
      if (match[1] !== undefined) await add(match[1])
    }
  }
  // --no-walk reads these OIDs themselves. Multiple ^! ranges would subtract
  // one another's parents and could drop an earlier creating commit's binding.
  if (provenance.commits.length > 0) {
    for await (const binding of issueBindingsOf(
      git,
      ["--no-walk=unsorted", ...provenance.commits],
      name,
      resolveIssue,
    )) {
      issues.add(binding.issue)
    }
  }
  const spans = new Set<string>()
  for (const branch of provenance.branches) {
    const invalid = histories.invalid.get(branch)
    if (invalid !== undefined) throw new Error(`${cwd}: change chain ${invalid.ref} is unproven: ${invalid.error}`)
    const history = histories.histories.get(branch)
    if (history === undefined) continue
    for (const segment of enumerateChangeSegments(history.events, changesRef(queue, branch), store.repo)) {
      if (segment.state.issue !== undefined) await add(segment.state.issue)
      for (const event of segment.events) {
        if (event.type !== "verifying") continue
        const candidate = event.props.find(([key]) => key === "Commit")?.[1]
        if (candidate === undefined || !event.links.includes(candidate)) {
          throw new Error(`${cwd}: verifying event ${event.id} has no kept candidate`)
        }
        const parents = (await queueGit(["rev-list", "--parents", "-n", "1", candidate])).trim().split(/\s+/u)
        const target = parents[1]
        const head = parents[2]
        if (parents.length !== 3 || target === undefined || head === undefined) {
          throw new Error(`${cwd}: candidate ${candidate} does not keep exactly [target, head] parents`)
        }
        const span = `${target} ${head}`
        if (spans.has(span)) continue
        spans.add(span)
        const base = (await queueGit(["merge-base", target, head])).trim()
        if (base === "") throw new Error(`${cwd}: candidate ${candidate} has no author merge base`)
        for await (const binding of issueBindingsOf(
          queueGit,
          [`${base}..${head}`, `^${target}`],
          branch,
          resolveIssue,
        )) {
          issues.add(binding.issue)
        }
      }
    }
  }
  return [...issues]
}
