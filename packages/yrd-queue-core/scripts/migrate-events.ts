/**
 * One-shot Record: -> Event: cutover for a stopped Yrd queue (25041).
 *
 * Retirement: delete this script when no queue we run has a
 * refs/yrd/<queue>/<branch>@<head> ref; /sop counts them until then.
 * The service must be stopped before plan/apply/rollback. Every phase writes
 * an evidence receipt and treats an unread or changed remote as a refusal.
 */

import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createEventStore,
  gitIn,
  openEvents,
  resolveGitSelection,
  type Event,
  type Git,
  type GitomicBackend,
  type GitSelection,
} from "../src/git.ts"
import { readHistories, readQueue } from "../src/remote.ts"
import { isActive, readOverrides } from "../src/override.ts"
import { overrideRef, parseChangeRef, pauseRef, queueRefPrefix } from "../src/refs.ts"
import { changesRef, enumerateChangeSegments, queueFormat, queueRef, readEventQueueWithChanges } from "../src/events.ts"
import { readConfig } from "../src/config.ts"
import { assertPlainEventQueueConfig } from "../src/event-config.ts"
import { inputsForLegacy, migratedStatus, sourcesForMigration, type LegacyMigrationChange } from "../src/migration.ts"
import { tipOf } from "../src/state.ts"
import { trailer } from "../src/legacy-records.ts"
import { subjects } from "../src/table.ts"
import { directMergeCommits, eventDirectMergeCommits } from "../src/direct.ts"

type Phase = "plan" | "apply" | "rollback"
type Options = Readonly<{ phase: Phase; repo: string; remote: string; queue: string; journal: string }>
type Ref = Readonly<{ ref: string; oid: string }>
type Advertisement = Readonly<{ heads: readonly Ref[]; queue: readonly Ref[]; target: string }>
type LegacyRow = Readonly<{
  ref: string
  branch: string
  head: string
  state: string
  reason?: string
  supersededBy?: string
  at: string
  opened: string
  subject: string
  submitter: string
  issue?: string
}>
type Plan = Readonly<{
  version: 1
  options: Pick<Options, "repo" | "remote" | "queue" | "journal">
  remoteUrl: string
  runtimePin: string
  capturedAt: string
  target: string
  heads: readonly Ref[]
  oldRefs: readonly Ref[]
  changes: readonly Ref[]
  legacyRows: readonly LegacyRow[]
  recordCount: number
  directCommits: readonly string[]
  pause: Ref
  override?: Ref
  bundle: string
  bundleSha256: string
  snapshot: string
}>
type Staged = Readonly<{
  version: 1
  queue: Ref
  changes: readonly Ref[]
  sources: readonly Readonly<{ ref: string; oid: string }>[]
  stagedAt: string
}>

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const USAGE = "usage: migrate-events.ts plan|apply|rollback --repo ABS --remote NAME --queue BRANCH --journal ABS"

function failure(code: string, subject: string, detail: string): never {
  throw new Error(`yrd-migration-${code}: ${subject}: ${detail}`)
}

function optionsOf(argv: readonly string[]): Options {
  const [phase, ...rest] = argv
  if (phase !== "plan" && phase !== "apply" && phase !== "rollback") {
    failure("usage", String(phase ?? "missing phase"), USAGE)
  }
  const values = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (key === undefined || value === undefined || !["--repo", "--remote", "--queue", "--journal"].includes(key)) {
      failure("usage", String(key ?? "missing option"), USAGE)
    }
    if (values.has(key)) failure("usage", key, "option was provided twice")
    values.set(key, value)
  }
  for (const name of ["--repo", "--remote", "--queue", "--journal"] as const) {
    if (!values.has(name) || values.get(name)?.trim() === "") failure("usage", name, `required; ${USAGE}`)
  }
  const requiredOption = (name: string): string => {
    const value = values.get(name)
    if (value === undefined) failure("usage", name, `required; ${USAGE}`)
    return value
  }
  const repo = requiredOption("--repo")
  const remote = requiredOption("--remote")
  const queue = requiredOption("--queue")
  const journal = requiredOption("--journal")
  if (!isAbsolute(repo) || !isAbsolute(journal)) {
    failure("usage", `${repo} / ${journal}`, "repo and journal must be absolute paths")
  }
  if (remote.startsWith("-") || remote.includes("/") || /[\s\0]/u.test(remote)) {
    failure("usage", remote, "remote must be one configured Git remote name")
  }
  if (queue.startsWith("-") || queue.includes("..") || /[\s\0]/u.test(queue)) {
    failure("usage", queue, "queue must be one branch name")
  }
  return { phase, repo, remote, queue, journal }
}

function rows(text: string, subject: string): readonly Ref[] {
  if (text.trim() === "") return []
  const found = new Map<string, string>()
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\s+(refs\/[^\s]+)$/u.exec(line)
    if (match === null) failure("unreadable-ref", subject, `malformed ref row ${JSON.stringify(line)}`)
    const [, oid, ref] = match
    if (oid === undefined || ref === undefined || found.has(ref)) {
      failure("unreadable-ref", subject, `duplicate or incomplete ref row ${JSON.stringify(line)}`)
    }
    found.set(ref, oid)
  }
  return [...found].map(([ref, oid]) => ({ ref, oid })).sort((a, b) => a.ref.localeCompare(b.ref))
}

function equalRefs(left: readonly Ref[], right: readonly Ref[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function legacyRows(
  git: Git,
  queue: string,
  entries: readonly LegacyMigrationChange[],
): Promise<readonly LegacyRow[]> {
  const titles = await subjects(
    git,
    entries.map(({ change }) => change.head),
  )
  return entries
    .map(({ ref, change, reading }) => {
      const tip = tipOf(change)
      const subject = titles.get(change.head)
      const opened = trailer(tip, "Opened")
      const submitter = trailer(tip, "Submitter")
      if (subject === undefined || opened === undefined || submitter === undefined) {
        failure("unread-change", ref, `subject, Opened: or Submitter: missing at ${tip.sha}`)
      }
      return {
        ref,
        branch: change.branch,
        head: change.head,
        state: reading.state,
        ...(reading.reason === undefined ? {} : { reason: reading.reason }),
        ...(reading.supersededBy === undefined ? {} : { supersededBy: reading.supersededBy }),
        at: tip.at.toISOString(),
        opened,
        subject,
        submitter,
        ...(trailer(tip, "Issue") === undefined ? {} : { issue: trailer(tip, "Issue") }),
      }
    })
    .sort((a, b) => a.ref.localeCompare(b.ref))
}

export async function remoteAdvertisement(git: Git, remote: string, queue: string): Promise<Advertisement> {
  const prefix = `${queueRefPrefix(queue)}/`
  const listed = rows(
    await git(["ls-remote", "--refs", remote, "refs/heads/*", `${prefix}*`]),
    `${remote} refs/heads/* and ${prefix}*`,
  )
  const heads = listed.filter(({ ref }) => ref.startsWith("refs/heads/"))
  const queueRefs = listed.filter(({ ref }) => ref.startsWith(prefix))
  const target = heads.find(({ ref }) => ref === `refs/heads/${queue}`)?.oid
  if (target === undefined) {
    failure("missing-target", `${remote}#${queue}`, `no refs/heads/${queue} in the full advertisement`)
  }
  if (queueRefs.length === 0) failure("zero-refs", `${remote}#${queue}`, `queried ${prefix}* and found no legacy refs`)
  return { heads, queue: queueRefs, target }
}

export function classify(
  queue: string,
  refs: readonly Ref[],
): Readonly<{ changes: readonly Ref[]; pause: Ref; override?: Ref }> {
  const changes: Ref[] = []
  let pause: Ref | undefined
  let override: Ref | undefined
  for (const row of refs) {
    if (row.ref === pauseRef(queue)) pause = row
    else if (row.ref === overrideRef(queue)) override = row
    else if (row.ref === queueRef(queue) || row.ref.startsWith(`${queueRefPrefix(queue)}/changes/`)) {
      failure("unknown-format", row.ref, "event-format ref is present before legacy cutover")
    } else if (parseChangeRef(queue, row.ref) !== undefined) changes.push(row)
    else {
      failure(
        "unknown-format",
        row.ref,
        `no legacy change, pause or override disposition under ${queueRefPrefix(queue)}/`,
      )
    }
  }
  if (changes.length === 0) {
    failure("zero-changes", queue, `queried ${queueRefPrefix(queue)}/ and found no legacy change refs`)
  }
  if (pause === undefined) failure("unpaused", queue, `expected ${pauseRef(queue)} in the remote census`)
  return { changes, pause, ...(override === undefined ? {} : { override }) }
}

function immutableJson(path: string, value: unknown): void {
  if (existsSync(path)) failure("journal-exists", path, "refusing to overwrite evidence")
  const temp = `${path}.writing`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" })
  renameSync(temp, path)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) {
    const bytes: unknown = chunk
    if (!Buffer.isBuffer(bytes)) failure("bundle-read", path, "stream returned a non-byte chunk")
    hash.update(bytes)
  }
  return hash.digest("hex")
}

async function runtimePin(): Promise<string> {
  const runtime = dirname(fileURLToPath(import.meta.url))
  const git = gitIn(runtime)
  const pin = (await git(["rev-parse", "HEAD"])).trim()
  if (!OID.test(pin)) failure("runtime-pin", runtime, `HEAD is not a full commit OID: ${pin}`)
  try {
    await git(["merge-base", "--is-ancestor", "ff1e54e90f", pin])
  } catch (error) {
    failure("runtime-pin", pin, `Yrd runtime must contain ff1e54e90f before migration: ${String(error)}`)
  }
  return pin
}

async function plan(options: Options, git: Git, selection: GitSelection, pin: string): Promise<unknown> {
  if (existsSync(options.journal)) failure("journal-exists", options.journal, "plan requires a new journal directory")
  const first = await remoteAdvertisement(git, options.remote, options.queue)
  const classified = classify(options.queue, first.queue)
  const remoteUrl = (await git(["remote", "get-url", options.remote])).trim()
  if (remoteUrl === "") {
    failure("remote-url", options.remote, `configured remote in ${options.repo} resolved to an empty URL`)
  }
  const reading = await readQueue(git, options.remote, options.queue, first.target)
  if (reading.pause?.kind !== "paused") {
    failure(
      "unpaused",
      `${options.remote}#${options.queue}`,
      `legacy pause ref ${classified.pause.ref} did not fold to paused`,
    )
  }
  const overrides = await readOverrides(git, options.remote, options.queue)
  const active = overrides.entries.filter((entry) => isActive(entry, Date.now()))
  if (active.length > 0) {
    failure(
      "active-override",
      classified.override?.ref ?? overrideRef(options.queue),
      `active checks: ${active.map((entry) => entry.check).join(", ")}`,
    )
  }
  if (reading.changes.length !== classified.changes.length) {
    failure(
      "unread-change",
      `${options.remote}#${options.queue}`,
      `read ${reading.changes.length} changes from ${classified.changes.length} census refs`,
    )
  }
  const histories = await readHistories(git, reading.changes, options.remote, options.queue)
  const sources = sourcesForMigration(options.queue, reading.changes, histories)
  const projected = await legacyRows(git, options.queue, sources)
  const directCommits = (await directMergeCommits(git, options.queue, first.target, reading.changes)).map(
    ({ commit }) => commit,
  )
  const directMapping = assertDirectParity(directCommits, [], first.target)
  const recordCount = sources.reduce((count, source) => count + source.change.records.length, 0)
  const second = await remoteAdvertisement(git, options.remote, options.queue)
  if (!equalRefs(first.queue, second.queue) || !equalRefs(first.heads, second.heads)) {
    failure(
      "changed-census",
      `${options.remote}#${options.queue}`,
      "refs/heads or legacy refs moved during the plan read; take a fresh plan",
    )
  }
  mkdirSync(options.journal)
  const snapshot = join(options.journal, "old-refs.git")
  const bundle = join(options.journal, "old-refs.bundle")
  await git(["init", "--bare", snapshot])
  const snapshotGit = gitIn(snapshot, undefined, selection)
  await snapshotGit(["remote", "add", options.remote, remoteUrl])
  await snapshotGit([
    "fetch",
    "--no-tags",
    options.remote,
    `+${queueRefPrefix(options.queue)}/*:${queueRefPrefix(options.queue)}/*`,
  ])
  const copied = rows(
    await snapshotGit(["for-each-ref", "--format=%(objectname) %(refname)", `${queueRefPrefix(options.queue)}/`]),
    snapshot,
  )
  if (!equalRefs(first.queue, copied)) {
    failure("changed-snapshot", snapshot, "fetched old ref names or OIDs differ from the remote census")
  }
  await snapshotGit(["bundle", "create", bundle, "--all"])
  await snapshotGit(["bundle", "verify", bundle])
  const bundled = rows(await snapshotGit(["bundle", "list-heads", bundle]), bundle)
  if (!equalRefs(first.queue, bundled)) {
    failure("incomplete-bundle", bundle, "bundle ref listing differs from the old remote census")
  }
  const complete = await remoteAdvertisement(git, options.remote, options.queue)
  if (!equalRefs(first.queue, complete.queue) || !equalRefs(first.heads, complete.heads)) {
    failure(
      "changed-census",
      `${options.remote}#${options.queue}`,
      "remote moved during the bundle read; do not apply this plan",
    )
  }
  const evidence: Plan = {
    version: 1,
    options: { repo: options.repo, remote: options.remote, queue: options.queue, journal: options.journal },
    remoteUrl,
    runtimePin: pin,
    capturedAt: new Date().toISOString(),
    target: first.target,
    heads: first.heads,
    oldRefs: first.queue,
    changes: classified.changes,
    legacyRows: projected,
    directCommits,
    recordCount,
    pause: classified.pause,
    ...(classified.override === undefined ? {} : { override: classified.override }),
    bundle,
    bundleSha256: await sha256(bundle),
    snapshot,
  }
  immutableJson(join(options.journal, "plan.json"), evidence)
  immutableJson(join(options.journal, "legacy-rows.json"), projected)
  return {
    phase: "plan",
    queue: `${options.remote}#${options.queue}`,
    count: {
      oldRefs: first.queue.length,
      changes: classified.changes.length,
      records: recordCount,
      heads: first.heads.length,
      directCommits: directCommits.length,
    },
    paths: {
      journal: join(options.journal, "plan.json"),
      legacyRows: join(options.journal, "legacy-rows.json"),
      bundle,
      snapshot,
    },
    target: first.target,
    directMapping,
    runtimePin: pin,
    bundleSha256: evidence.bundleSha256,
  }
}

export function readPlan(options: Options): Plan {
  const path = join(options.journal, "plan.json")
  if (!existsSync(path)) failure("missing-journal", path, "plan.json is required; run plan first")
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 1) {
    failure("invalid-journal", path, "expected migration plan version 1")
  }
  const value = parsed as Plan
  if (
    JSON.stringify(value.options) !==
    JSON.stringify({ repo: options.repo, remote: options.remote, queue: options.queue, journal: options.journal })
  ) {
    failure("journal-scope", path, "plan repo, remote, queue or journal differs from this invocation")
  }
  if (
    !OID.test(value.target) ||
    value.oldRefs.length === 0 ||
    value.changes.length === 0 ||
    !Array.isArray(value.directCommits)
  ) {
    failure("invalid-journal", path, "plan has no valid target or old change census")
  }
  return value
}

export function assertAdvertised(plan: Plan, found: Advertisement, phase: string): void {
  if (!equalRefs(plan.oldRefs, found.queue) || !equalRefs(plan.heads, found.heads) || plan.target !== found.target) {
    failure(
      "changed-census",
      `${plan.options.remote}#${plan.options.queue}`,
      `${phase}: refs/heads or old queue refs differ from plan; take a new plan`,
    )
  }
}

function legacyOpened(source: LegacyMigrationChange): number {
  const written = trailer(tipOf(source.change), "Opened")
  const millis = written === undefined ? Number.NaN : Date.parse(written)
  if (Number.isNaN(millis)) {
    failure("unread-record", source.ref, `tip ${tipOf(source.change).sha} has no readable Opened:`)
  }
  return millis
}

async function legacyChanges(plan: Plan, git: Git): Promise<readonly LegacyMigrationChange[]> {
  const { remote, queue } = plan.options
  const reading = await readQueue(git, remote, queue, plan.target)
  if (reading.pause?.kind !== "paused" || reading.pause.sha !== plan.pause.oid) {
    failure("unpaused", `${remote}#${queue}`, `pause is not the planned ${plan.pause.oid}`)
  }
  const overrides = await readOverrides(git, remote, queue)
  if (overrides.entries.some((entry) => isActive(entry, Date.now()))) {
    failure("active-override", overrideRef(queue), "a check override is active at apply")
  }
  const hydrated = await readHistories(git, reading.changes, remote, queue)
  const sources = sourcesForMigration(queue, reading.changes, hydrated)
  const expected = new Map(plan.changes.map(({ ref, oid }) => [ref, oid]))
  if (sources.length !== expected.size) {
    failure(
      "unread-change",
      `${remote}#${queue}`,
      `hydrated ${sources.length} chains from ${expected.size} planned change refs`,
    )
  }
  for (const source of sources) {
    const planned = expected.get(source.ref)
    if (planned === undefined || planned !== tipOf(source.change).sha) {
      failure(
        "changed-change",
        source.ref,
        `hydrated tip ${tipOf(source.change).sha} differs from plan ${planned ?? "absent"}`,
      )
    }
  }
  return sources
}

function sourceKey(ref: string, oid: string): string {
  return `${ref}@${oid}`
}

function sourceCounts(sources: readonly LegacyMigrationChange[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const source of sources) {
    for (const record of source.change.records) {
      const key = sourceKey(source.ref, record.sha)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

function assertStagedBranch(
  branch: string,
  events: readonly Event[],
  sources: readonly LegacyMigrationChange[],
  repo: string,
  queue: string,
): readonly Readonly<{ ref: string; oid: string }>[] {
  const ref = changesRef(queue, branch)
  const segments = enumerateChangeSegments(events, ref, repo)
  if (segments.length !== sources.length) {
    failure("segment-count", ref, `staged ${segments.length} opened segments from ${sources.length} old refs`)
  }
  for (const [index, source] of sources.entries()) {
    const segment = segments[index]
    if (segment === undefined) failure("segment-count", ref, `missing segment ${index}`)
    const expectedStatus = migratedStatus(source.reading)
    if (segment.head !== source.change.head || segment.state.status !== expectedStatus) {
      failure(
        "segment-parity",
        source.ref,
        `old ${source.change.head}/${source.reading.state} maps to ${expectedStatus}, staged ${segment.head}/${segment.state.status}`,
      )
    }
    if (segment.state.at?.getTime() !== tipOf(source.change).at.getTime()) {
      failure(
        "segment-parity",
        source.ref,
        `old tip at ${tipOf(source.change).at.toISOString()}, staged at ${segment.state.at?.toISOString() ?? "absent"}`,
      )
    }
    const submitter = trailer(tipOf(source.change), "Submitter")
    if (segment.state.submitter !== submitter || segment.state.issue !== trailer(tipOf(source.change), "Issue")) {
      failure("segment-parity", source.ref, "submitter or issue differs after event fold")
    }
    const found = segment.sources.filter((row) => row.ref === source.ref)
    if (
      found.length !== source.change.records.length ||
      found.some((row, at) => row.oid !== source.change.records[at]?.sha)
    ) {
      failure(
        "source-accounting",
        source.ref,
        `staged ${found.length} kept Migrated-From records, expected ${source.change.records.length} in order`,
      )
    }
    if (segment.sources.length !== found.length) {
      failure("source-accounting", ref, `segment ${segment.opened} mixes old ref identities`)
    }
  }
  return segments.flatMap((segment) => segment.sources)
}

function branchGroups(
  sources: readonly LegacyMigrationChange[],
): readonly Readonly<{ branch: string; changes: readonly LegacyMigrationChange[] }>[] {
  const grouped = new Map<string, LegacyMigrationChange[]>()
  for (const source of sources) {
    const branch = source.change.branch
    const existing = grouped.get(branch) ?? []
    existing.push(source)
    grouped.set(branch, existing)
  }
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([branch, changes]) => ({
      branch,
      changes: changes.sort((a, b) => legacyOpened(a) - legacyOpened(b) || a.ref.localeCompare(b.ref)),
    }))
}

export function readbackStatus(
  oldRefs: readonly Ref[],
  newRefs: readonly Ref[],
  found: Advertisement,
  heads: readonly Ref[],
): "committed" | "unchanged" | "divergent" {
  if (!equalRefs(found.heads, heads)) return "divergent"
  if (equalRefs(found.queue, newRefs)) return "committed"
  if (equalRefs(found.queue, oldRefs)) return "unchanged"
  return "divergent"
}

/** A legacy direct row at the created event's Commit is represented by that event. */
export function assertDirectParity(
  legacy: readonly string[],
  event: readonly string[],
  createdCommit: string,
): Readonly<{ creationCommit?: string; directCommits: readonly string[] }> {
  const creation = legacy.filter((commit) => commit === createdCommit)
  if (creation.length > 1) failure("direct-parity", createdCommit, "legacy direct census repeats queue creation commit")
  const remaining = legacy.filter((commit) => commit !== createdCommit)
  if (JSON.stringify(remaining) !== JSON.stringify(event)) {
    failure(
      "direct-parity",
      createdCommit,
      `legacy direct commits outside queue creation ${JSON.stringify(remaining)} differ from event direct commits ${JSON.stringify(event)}`,
    )
  }
  return { ...(creation.length === 0 ? {} : { creationCommit: createdCommit }), directCommits: event }
}

async function apply(options: Options, plan: Plan, git: Git, selection: GitSelection): Promise<unknown> {
  const stagedPath = join(options.journal, "staged.json")
  if (existsSync(stagedPath)) {
    failure(
      "already-staged",
      stagedPath,
      "one publication attempt may have happened; inspect the journal and full remote readback, never retry",
    )
  }
  if (!existsSync(plan.bundle) || (await sha256(plan.bundle)) !== plan.bundleSha256) {
    failure("invalid-bundle", plan.bundle, "bundle is missing or its SHA256 differs from plan")
  }
  await gitIn(plan.snapshot, undefined, selection)(["bundle", "verify", plan.bundle])
  const first = await remoteAdvertisement(git, options.remote, options.queue)
  assertAdvertised(plan, first, "apply preflight")
  const declared = await readConfig(git, plan.target, { remote: options.remote, branch: options.queue })
  if (declared === undefined) failure("missing-config", plan.target, "target commit has no .yrd.yml declaration")
  assertPlainEventQueueConfig(declared, "create")
  const sources = await legacyChanges(plan, git)
  const groups = branchGroups(sources)
  const expectedSources = sourceCounts(sources)
  if ([...expectedSources.values()].some((count) => count !== 1)) {
    failure("source-accounting", options.queue, "the old record census contains a duplicate ref@record identity")
  }
  const store = createEventStore(options.repo, options.remote, selection)
  const queueChain = await openEvents({ ...store, ref: queueRef(options.queue), writer: "yrd-migration" })
  const preparedQueue = await queueChain.stage(
    [
      {
        type: "created",
        props: [
          ["Commit", plan.target],
          ["Time", new Date().toISOString()],
          ["Start-Paused", "25041 event migration cutover"],
        ],
        keeps: [plan.target],
      },
    ],
    { expect: null },
  )
  const queueTip = preparedQueue.events[0]?.id
  if (queueTip === undefined || queueTip !== preparedQueue.head) {
    failure("stage-queue", queueRef(options.queue), "prepared created event has no exact tip")
  }
  const stagedChanges: Array<
    Readonly<{ ref: string; oid: string; sources: readonly Readonly<{ ref: string; oid: string }>[] }> | undefined
  > = Array.from({ length: groups.length }, () => undefined)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(8, groups.length) }, async () => {
      while (cursor < groups.length) {
        const index = cursor++
        const group = groups[index]
        if (group === undefined) failure("stage-change", options.queue, `missing branch group ${index}`)
        const ref = changesRef(options.queue, group.branch)
        const inputs = group.changes.flatMap((source) => inputsForLegacy(source, queueTip))
        const staged = await (
          await openEvents({ ...store, ref, writer: "yrd-migration" })
        ).stage(inputs, { expect: null })
        const kept = assertStagedBranch(group.branch, staged.events, group.changes, options.repo, options.queue)
        stagedChanges[index] = { ref, oid: staged.head, sources: kept }
      }
    }),
  )
  const ready = stagedChanges.map((row, index) => {
    if (row === undefined) failure("stage-change", options.queue, `branch group ${index} produced no staged ref`)
    return row
  })
  const actualSources = new Map<string, number>()
  for (const row of ready) {
    for (const source of row.sources) {
      const key = sourceKey(source.ref, source.oid)
      actualSources.set(key, (actualSources.get(key) ?? 0) + 1)
    }
  }
  if (JSON.stringify([...actualSources].sort()) !== JSON.stringify([...expectedSources].sort())) {
    failure(
      "source-accounting",
      options.queue,
      `staged ${actualSources.size} distinct source records, expected ${expectedSources.size}; one may be absent or repeated`,
    )
  }
  const newRefs: readonly Ref[] = [
    { ref: queueRef(options.queue), oid: preparedQueue.head },
    ...ready.map(({ ref, oid }) => ({ ref, oid })),
  ].sort((a, b) => a.ref.localeCompare(b.ref))
  const staged: Staged = {
    version: 1,
    queue: { ref: queueRef(options.queue), oid: preparedQueue.head },
    changes: ready.map(({ ref, oid }) => ({ ref, oid })),
    sources: ready.flatMap(({ sources }) => sources),
    stagedAt: new Date().toISOString(),
  }
  immutableJson(stagedPath, staged)
  const before = await remoteAdvertisement(git, options.remote, options.queue)
  assertAdvertised(plan, before, "immediately before atomic publication")
  const also = [
    ...ready.map(({ ref, oid }) => ({ ref, expect: null, oid })),
    ...plan.oldRefs.map(({ ref, oid }) => ({ ref, expect: oid, oid: null })),
  ]
  const started = performance.now()
  let publicationError: string | undefined
  try {
    await preparedQueue.publish({ also })
  } catch (error) {
    publicationError = error instanceof Error ? error.message : String(error)
  }
  const seconds = (performance.now() - started) / 1000
  const after = await remoteAdvertisement(git, options.remote, options.queue)
  const state = readbackStatus(plan.oldRefs, newRefs, after, plan.heads)
  const result = {
    phase: "apply",
    state,
    queue: `${options.remote}#${options.queue}`,
    refUpdates: newRefs.length + plan.oldRefs.length,
    pushSeconds: seconds,
    ...(publicationError === undefined ? {} : { publicationError }),
    paths: {
      plan: join(options.journal, "plan.json"),
      bundle: plan.bundle,
      staged: stagedPath,
      result: join(options.journal, "apply-result.json"),
    },
    readback: after.queue,
  }
  immutableJson(join(options.journal, "apply-result.json"), result)
  if (state !== "committed") {
    failure(
      "apply-readback",
      `${options.remote}#${options.queue}`,
      `${state} after one atomic push attempt; ${publicationError ?? "push returned success"}; see ${join(options.journal, "apply-result.json")}`,
    )
  }
  const remote = await readEventQueueWithChanges(store, options.queue)
  for (const [branch, defect] of remote.invalid) {
    failure("postflight", branch, `${defect.ref}@${defect.tip}: ${defect.error}`)
  }
  if (remote.queue.pause === undefined || remote.histories.size !== groups.length) {
    failure(
      "postflight",
      `${options.remote}#${options.queue}`,
      `event queue paused=${remote.queue.pause !== undefined}, branch chains=${remote.histories.size}, expected ${groups.length}`,
    )
  }
  for (const group of groups) {
    const actual = remote.histories.get(group.branch)?.state
    const latest = group.changes.at(-1)
    if (
      actual === undefined ||
      latest === undefined ||
      actual.commit !== latest.change.head ||
      actual.status !== migratedStatus(latest.reading)
    ) {
      failure(
        "postflight",
        group.branch,
        `remote current event row differs from the latest old head ${latest?.change.head ?? "absent"}`,
      )
    }
  }
  if (remote.queue.declaration !== plan.target) {
    failure("direct-parity", options.queue, `created event kept ${remote.queue.declaration}, planned ${plan.target}`)
  }
  const eventDirect = (
    await eventDirectMergeCommits(git, options.queue, plan.target, remote.queue.declaration, remote.histories)
  ).map(({ commit }) => commit)
  const directMapping = assertDirectParity(plan.directCommits, eventDirect, remote.queue.declaration)
  const postflight = {
    phase: "postflight",
    state: "clean",
    branchChains: groups.length,
    sourceRecords: expectedSources.size,
    queuePaused: true,
    directMapping,
  }
  immutableJson(join(options.journal, "postflight.json"), postflight)
  return { ...result, postflight: join(options.journal, "postflight.json") }
}

function readStaged(options: Options, plan: Plan): Staged {
  const path = join(options.journal, "staged.json")
  if (!existsSync(path)) failure("missing-journal", path, "staged manifest is required for rollback")
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 1) {
    failure("invalid-journal", path, "expected staged manifest version 1")
  }
  const value = parsed as Staged
  if (
    value.queue.ref !== queueRef(options.queue) ||
    !OID.test(value.queue.oid) ||
    value.sources.length !== plan.recordCount
  ) {
    failure("invalid-journal", path, "staged queue or source record count differs from plan")
  }
  return value
}

async function rollback(options: Options, plan: Plan, git: Git, selection: GitSelection): Promise<unknown> {
  const resultPath = join(options.journal, "apply-result.json")
  const rollbackPath = join(options.journal, "rollback-result.json")
  if (existsSync(rollbackPath)) {
    failure("already-rolled-back", rollbackPath, "one rollback attempt may have happened; inspect full readback")
  }
  if (!existsSync(resultPath)) {
    failure("missing-journal", resultPath, "apply readback receipt is required before rollback")
  }
  const applied: unknown = JSON.parse(readFileSync(resultPath, "utf8"))
  if (typeof applied !== "object" || applied === null || !("state" in applied) || applied.state !== "committed") {
    failure("invalid-journal", resultPath, "apply receipt did not prove exact committed ref readback")
  }
  const staged = readStaged(options, plan)
  if (!existsSync(plan.bundle) || (await sha256(plan.bundle)) !== plan.bundleSha256) {
    failure("invalid-bundle", plan.bundle, "bundle is missing or its SHA256 differs from plan")
  }
  const snapshotGit = gitIn(plan.snapshot, undefined, selection)
  await snapshotGit(["bundle", "verify", plan.bundle])
  const bundled = rows(await snapshotGit(["bundle", "list-heads", plan.bundle]), plan.bundle)
  if (!equalRefs(bundled, plan.oldRefs)) {
    failure("invalid-bundle", plan.bundle, "bundle ref listing differs from the original census")
  }
  const lastSource = new Map<string, string>()
  const count = new Map<string, number>()
  for (const source of staged.sources) {
    const key = sourceKey(source.ref, source.oid)
    count.set(key, (count.get(key) ?? 0) + 1)
    lastSource.set(source.ref, source.oid)
  }
  if (staged.sources.length !== plan.recordCount || [...count.values()].some((number) => number !== 1)) {
    failure("source-accounting", options.queue, "staged Migrated-From entries do not account for every old record once")
  }
  for (const old of plan.changes) {
    if (lastSource.get(old.ref) !== old.oid) {
      failure(
        "source-accounting",
        old.ref,
        `last Migrated-From record ${lastSource.get(old.ref) ?? "absent"} differs from bundled tip ${old.oid}`,
      )
    }
  }
  const newRefs: readonly Ref[] = [staged.queue, ...staged.changes].sort((a, b) => a.ref.localeCompare(b.ref))
  const before = await remoteAdvertisement(git, options.remote, options.queue)
  if (!equalRefs(before.queue, newRefs) || !equalRefs(before.heads, plan.heads)) {
    failure(
      "changed-census",
      `${options.remote}#${options.queue}`,
      "new ref OIDs or branch heads differ from staged apply receipt; rollback lease is unsafe",
    )
  }
  const backend = createEventStore(options.repo, options.remote, selection).backend as GitomicBackend
  if (typeof backend.publish !== "function") {
    failure("backend", options.repo, "Gitomic backend lacks atomic publish for rollback")
  }
  const absent = "0".repeat(40)
  const updates = [
    ...plan.oldRefs.map(({ ref, oid }) => ({ ref, expect: absent, oid })),
    ...newRefs.map(({ ref, oid }) => ({ ref, expect: oid, oid: null })),
  ]
  const started = performance.now()
  let publicationError: string | undefined
  try {
    await backend.publish(options.repo, updates, options.remote)
  } catch (error) {
    publicationError = error instanceof Error ? error.message : String(error)
  }
  const seconds = (performance.now() - started) / 1000
  const after = await remoteAdvertisement(git, options.remote, options.queue)
  const state = equalRefs(after.heads, plan.heads)
    ? equalRefs(after.queue, plan.oldRefs)
      ? "restored"
      : equalRefs(after.queue, newRefs)
        ? "unchanged"
        : "divergent"
    : "divergent"
  const result = {
    phase: "rollback",
    state,
    queue: `${options.remote}#${options.queue}`,
    refUpdates: updates.length,
    pushSeconds: seconds,
    ...(publicationError === undefined ? {} : { publicationError }),
    paths: {
      plan: join(options.journal, "plan.json"),
      bundle: plan.bundle,
      staged: join(options.journal, "staged.json"),
      result: rollbackPath,
    },
    readback: after.queue,
  }
  immutableJson(rollbackPath, result)
  if (state !== "restored") {
    failure(
      "rollback-readback",
      `${options.remote}#${options.queue}`,
      `${state} after one atomic rollback attempt; ${publicationError ?? "push returned success"}; see ${rollbackPath}`,
    )
  }
  const store = createEventStore(options.repo, options.remote, selection)
  if ((await queueFormat(store, options.queue)) !== "legacy") {
    failure(
      "rollback-format",
      `${options.remote}#${options.queue}`,
      "queueFormat still selects event after exact old ref restoration",
    )
  }
  const restored = await legacyChanges(plan, git)
  const projected = await legacyRows(git, options.queue, restored)
  if (JSON.stringify(projected) !== JSON.stringify(plan.legacyRows)) {
    failure(
      "rollback-parity",
      `${options.remote}#${options.queue}`,
      `restored legacy rows differ from ${join(options.journal, "legacy-rows.json")}`,
    )
  }
  const postflight = {
    phase: "rollback-postflight",
    state: "clean",
    legacyRows: projected.length,
    queueFormat: "legacy",
  }
  immutableJson(join(options.journal, "rollback-postflight.json"), postflight)
  return { ...result, postflight: join(options.journal, "rollback-postflight.json") }
}

async function main(argv: readonly string[]): Promise<void> {
  const options = optionsOf(argv)
  const pin = await runtimePin()
  const selection = await resolveGitSelection(options.repo)
  const git = gitIn(options.repo, undefined, selection)
  const absolute = (await git(["rev-parse", "--show-toplevel"])).trim()
  if (absolute !== options.repo) failure("repo", options.repo, `Git resolved checkout root ${absolute}`)
  if (options.phase === "plan") {
    process.stdout.write(`${JSON.stringify(await plan(options, git, selection, pin))}\n`)
    return
  }
  const evidence = readPlan(options)
  if (evidence.runtimePin !== pin) {
    failure(
      "runtime-pin",
      pin,
      `plan recorded ${evidence.runtimePin}; run the same reviewed Yrd runtime for ${options.phase}`,
    )
  }
  if (options.phase === "apply") {
    process.stdout.write(`${JSON.stringify(await apply(options, evidence, git, selection))}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(await rollback(options, evidence, git, selection))}\n`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
