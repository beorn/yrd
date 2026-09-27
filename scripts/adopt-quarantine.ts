/**
 * One-off adoption of the 2026-09-24 DROP quarantine (#25658, @cto 5aa025ba).
 * This script creates live event refs. It never deletes a quarantine ref.
 */
import { isAbsolute } from "node:path"
import { chainsUnder } from "gitomic/events"
import {
  changeInput,
  changesRef,
  createEventStore,
  gitIn,
  listRefs,
  queueRef,
  queueRefPrefix,
  readEventOps,
  readRemoteCommit,
  type Event,
  type QueueLocation,
} from "../packages/yrd-queue-core/src/index.ts"
import { openEvents } from "../packages/yrd-queue-core/src/git.ts"
import { project } from "../packages/yrd-queue-core/src/events.ts"
import { refuseMaintenance } from "../packages/yrd-queue-core/src/submit.ts"

type Kind = "move" | "repair" | "history"
type State = "pending" | "adopted" | "contained" | "conflict"

type AdoptionItem = Readonly<{
  branch: string
  kind: Kind
  state: State
  sourceRef: string
  sourceOid: string
  targetRef: string
  targetOid: string | null
  sourceAfterApply: "deleted" | "kept"
  events: readonly ({ type: "unchanged" } | { type: "opened" | "cancelled"; at: "apply-time"; [key: string]: string })[]
  appendedCount?: number
  dropReason?: string
  liveEvent?: string
  diagnostic?: string
  originalText?: string
}>

type AdoptionPlan = Readonly<{
  repo: string
  remote: string
  queue: string
  sourcePrefix: string
  queueTip: string
  stop: string | null
  items: readonly AdoptionItem[]
}>

type Options = Readonly<{
  repo: string
  remote: string
  queue: string
  by: string
  only?: string
  kind?: "move" | "repair"
  plan: boolean
  applyCount?: number
  json: boolean
}>

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`${flag} needs a non-empty value`)
  }
  return value
}

function parseArgs(argv: readonly string[]): Options {
  let repo: string | undefined
  let remote: string | undefined
  let queue: string | undefined
  let by: string | undefined
  let only: string | undefined
  let kind: "move" | "repair" | undefined
  let plan = false
  let applyCount: number | undefined
  let json = false
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    switch (flag) {
      case "--repo":
        repo = required(argv[++index], flag)
        break
      case "--remote":
        remote = required(argv[++index], flag)
        break
      case "--queue":
        queue = required(argv[++index], flag)
        break
      case "--by":
        by = required(argv[++index], flag)
        break
      case "--only":
        only = required(argv[++index], flag)
        break
      case "--kind": {
        const value = required(argv[++index], flag)
        if (value !== "move" && value !== "repair") throw new Error(`--kind must be move or repair, got ${value}`)
        kind = value
        break
      }
      case "--plan":
        plan = true
        break
      case "--apply": {
        const value = required(argv[++index], flag)
        if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`--apply needs a positive count, got ${value}`)
        applyCount = Number(value)
        if (!Number.isSafeInteger(applyCount)) throw new Error(`--apply count is too large: ${value}`)
        break
      }
      case "--json":
        json = true
        break
      default:
        throw new Error(`unknown argument ${String(flag)}`)
    }
  }
  if (plan === (applyCount !== undefined)) throw new Error("choose exactly one of --plan or --apply <count>")
  if (repo === undefined || !isAbsolute(repo)) throw new Error("--repo needs an absolute CODE clone path")
  if (remote === undefined || queue === undefined || by === undefined) {
    throw new Error("--remote, --queue and --by are required; no production target is inferred")
  }
  return {
    repo,
    remote,
    queue,
    by,
    plan,
    ...(applyCount === undefined ? {} : { applyCount }),
    ...(only === undefined ? {} : { only }),
    ...(kind === undefined ? {} : { kind }),
    json,
  }
}

function value(event: Event, key: string): string | undefined {
  return event.props.find(([name]) => name === key)?.[1]
}

function classify(ref: string, events: readonly Event[]): Kind {
  if (ref.endsWith("/task/dev3-25620-guards-r2") && events[0]?.type === "opened") return "history"
  if (events.length === 1 && events[0]?.type === "cancelled" && value(events[0], "Reason") === "dropped") {
    return "repair"
  }
  if (
    events.length >= 2 &&
    events[0]?.type === "opened" &&
    events.at(-1)?.type === "cancelled" &&
    value(events.at(-1) as Event, "Reason") === "dropped"
  ) {
    return "move"
  }
  throw new Error(
    `${ref}: quarantine chain has ${events.length} events, first=${events[0]?.type ?? "none"}, last=${events.at(-1)?.type ?? "none"}; expected the 25658 DROP shapes`,
  )
}

function sourcePrefix(queue: string): string {
  return queueRefPrefix(queue).replace(/^refs\/yrd\//u, "refs/yrd-quarantine/") + "/changes/"
}

async function inspectTarget(
  store: QueueLocation,
  kind: Kind,
  sourceEvents: readonly Event[],
  sourceOid: string,
  targetRef: string,
  targetOid: string | null,
  originalText: string | undefined,
): Promise<
  Readonly<{ state: State; appendedCount?: number; dropReason?: string; liveEvent?: string; diagnostic?: string }>
> {
  if (kind === "move") {
    if (targetOid === null)
      return { state: "conflict", diagnostic: "live target is absent; reviewed move requires an exact live OID" }
    if (targetOid === sourceOid) return { state: "adopted", appendedCount: 0 }
    // chainsUnder reconstructs events through the first parent of each commit.
    const liveIndex = sourceEvents.findIndex((event) => event.id === targetOid)
    if (liveIndex < 0)
      return { state: "conflict", diagnostic: "live target is not on the quarantine first-parent chain" }
    const live = sourceEvents[liveIndex]
    const appended = sourceEvents.slice(liveIndex + 1)
    const drop = appended[0]
    const details = {
      appendedCount: appended.length,
      dropReason: drop === undefined ? "absent" : (value(drop, "Reason") ?? "absent"),
      liveEvent: live?.type ?? "absent",
    }
    if (appended.length !== 1 || drop?.type !== "cancelled" || details.dropReason !== "dropped") {
      return {
        state: "conflict",
        ...details,
        diagnostic: "appended first-parent commits are not exactly one cancelled DROP event",
      }
    }
    const liveAt = live === undefined ? undefined : value(live, "Time")
    const dropAt = value(drop, "Time")
    if (
      liveAt === undefined ||
      dropAt === undefined ||
      !Number.isFinite(Date.parse(liveAt)) ||
      !Number.isFinite(Date.parse(dropAt)) ||
      Date.parse(dropAt) < Date.parse(liveAt)
    ) {
      return {
        state: "conflict",
        ...details,
        diagnostic: `DROP Time ${dropAt ?? "absent"} precedes or cannot compare with live Time ${liveAt ?? "absent"}`,
      }
    }
    try {
      project(sourceEvents, targetRef, store.repo)
    } catch (error) {
      return {
        state: "conflict",
        ...details,
        diagnostic: `writer projection refused replay: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return { state: "pending", ...details }
  }
  if (targetOid === null) return { state: kind === "repair" ? "pending" : "conflict" }
  const events = await (await openEvents({ ...store, ref: targetRef })).events()
  if (events.at(-1)?.id !== targetOid) throw new Error(`${targetRef}: target moved during read from ${targetOid}`)
  if (kind === "history") return { state: events.some((event) => event.id === sourceOid) ? "contained" : "conflict" }
  if (
    events.length === 2 &&
    events[0]?.type === "opened" &&
    events[0].links.includes(sourceOid) &&
    events[1]?.type === "cancelled" &&
    value(events[1], "Reason") === "dropped" &&
    events[1].content.includes(originalText ?? "\u0000")
  ) {
    return { state: "adopted" }
  }
  return { state: "conflict" }
}

async function planQuarantine(options: Options): Promise<{ plan: AdoptionPlan; store: QueueLocation }> {
  const git = gitIn(options.repo)
  const store = createEventStore(options.repo, options.remote, git.selection)
  const targetHead = await readRemoteCommit(git, options.remote, `refs/heads/${options.queue}`)
  if (targetHead === undefined) throw new Error(`${options.remote}: expected refs/heads/${options.queue} missing`)
  const ops = await readEventOps(store, git, options.queue, targetHead)
  const prefix = sourcePrefix(options.queue)
  const [sources, targets] = await Promise.all([
    chainsUnder(prefix, store),
    listRefs(`${queueRefPrefix(options.queue)}/changes/`, store),
  ])
  if (sources.size === 0) throw new Error(`${options.remote}: no quarantine refs under ${prefix}`)
  const items: AdoptionItem[] = []
  for (const [ref, events] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const sourceOid = events.at(-1)?.id
    if (sourceOid === undefined) throw new Error(`${ref}: quarantine ref has no event`)
    const branch = ref.slice(prefix.length)
    if (branch.length === 0 || branch === ref) throw new Error(`${ref}: cannot derive branch under ${prefix}`)
    const kind = classify(ref, events)
    const targetRef = changesRef(options.queue, branch)
    const targetOid = targets.get(targetRef) ?? null
    const originalText =
      kind === "repair" ? (await store.backend.readCommit(options.repo, sourceOid)).message.trimEnd() : undefined
    const inspected = await inspectTarget(store, kind, events, sourceOid, targetRef, targetOid, originalText)
    const eventPlan: AdoptionItem["events"] =
      kind === "repair"
        ? [
            {
              type: "opened",
              at: "apply-time",
              commit: sourceOid,
              by: options.by,
              title: `dropped by @dev/1 2026-09-24 13:25 PDT under the DROP plan; adopted from ${ref} at ${sourceOid}`,
            },
            { type: "cancelled", at: "apply-time", commit: sourceOid, reason: "dropped", content: originalText ?? "" },
          ]
        : [{ type: "unchanged" }]
    items.push({
      branch,
      kind,
      ...inspected,
      sourceRef: ref,
      sourceOid,
      targetRef,
      targetOid,
      sourceAfterApply: kind === "move" ? "deleted" : "kept",
      events: eventPlan,
      ...(originalText === undefined ? {} : { originalText }),
    })
  }
  return {
    plan: {
      repo: options.repo,
      remote: options.remote,
      queue: options.queue,
      sourcePrefix: prefix,
      queueTip: ops.queue.tip,
      stop: ops.stop === undefined ? null : `${ops.stop.cause}: ${ops.stop.reason}`,
      items,
    },
    store,
  }
}

async function applyQuarantine(
  options: Options,
): Promise<Readonly<{ plan: AdoptionPlan; applied: readonly { branch: string; kind: Kind; targetOid: string }[] }>> {
  const { plan, store } = await planQuarantine(options)
  const git = gitIn(options.repo)
  const targetHead = await readRemoteCommit(git, options.remote, `refs/heads/${options.queue}`)
  if (targetHead === undefined) {
    throw new Error(`${options.remote}: expected refs/heads/${options.queue} missing before apply`)
  }
  const ops = await readEventOps(store, git, options.queue, targetHead)
  refuseMaintenance(ops.stop, options.remote, options.queue)
  if (ops.queue.tip !== plan.queueTip) {
    throw new Error(`${queueRef(options.queue)} moved from ${plan.queueTip} during plan; rerun --plan`)
  }
  const selected = plan.items.filter(
    (item) =>
      (options.only === undefined || item.branch === options.only) &&
      (options.kind === undefined || item.kind === options.kind),
  )
  if (options.only !== undefined && selected.length !== 1) {
    throw new Error(`--only ${options.only} names ${selected.length} quarantine rows`)
  }
  const conflicts = selected.filter((item) => item.state === "conflict")
  if (conflicts.length > 0) {
    throw new Error(
      `live target differs for ${conflicts.map((item) => `${item.branch}@${item.targetOid}`).join(", ")}; return to @cto before a write`,
    )
  }
  const pending = selected.filter((item) => item.state === "pending")
  if (pending.length !== options.applyCount) {
    throw new Error(
      `--apply ${options.applyCount} requested, but ${pending.length} pending rows matched; already adopted/contained rows are not silently counted`,
    )
  }
  if (store.backend.publish === undefined) throw new Error("Gitomic backend lacks atomic MULTI publish")
  const applied: { branch: string; kind: Kind; targetOid: string }[] = []
  const moves = pending.filter((item) => item.kind !== "repair")
  if (moves.length > 0) {
    const updates = [
      { ref: queueRef(options.queue), expect: plan.queueTip, oid: plan.queueTip },
      ...moves.flatMap((item) => [
        { ref: item.targetRef, expect: item.targetOid ?? "0".repeat(item.sourceOid.length), oid: item.sourceOid },
        { ref: item.sourceRef, expect: item.sourceOid, oid: null },
      ]),
    ]
    const result = await store.backend.publish(options.repo, updates, options.remote)
    for (const item of moves) {
      if (!result.outcomes.some((row) => row.ref === item.targetRef && row.outcome === "updated")) {
        throw new Error(`${item.targetRef}: MULTI did not report target creation`)
      }
      if (!result.outcomes.some((row) => row.ref === item.sourceRef && row.outcome === "deleted")) {
        throw new Error(`${item.sourceRef}: MULTI did not report quarantine deletion`)
      }
      applied.push({ branch: item.branch, kind: item.kind, targetOid: item.sourceOid })
    }
  }
  for (const item of pending.filter((row) => row.kind === "repair")) {
    const at = new Date()
    const result = await (
      await openEvents({ ...store, ref: item.targetRef, writer: options.by })
    ).append(
      [
        changeInput("opened", {
          queueTip: plan.queueTip,
          at,
          commit: item.sourceOid,
          by: options.by,
          title: `dropped by @dev/1 2026-09-24 13:25 PDT under the DROP plan; adopted from ${item.sourceRef} at ${item.sourceOid}`,
        }),
        changeInput("cancelled", {
          queueTip: plan.queueTip,
          at,
          commit: item.sourceOid,
          reason: "dropped",
          by: options.by,
          content: item.originalText,
        }),
      ],
      {
        expect: null,
        also: [
          { ref: queueRef(options.queue), expect: plan.queueTip, oid: plan.queueTip },
          { ref: item.sourceRef, expect: item.sourceOid, oid: item.sourceOid },
        ],
      },
    )
    if (result.events.map((event) => event.type).join(",") !== "opened,cancelled") {
      throw new Error(`${item.targetRef}: repair did not write opened,cancelled`)
    }
    if (result.head === null) throw new Error(`${item.targetRef}: repair wrote no target head`)
    applied.push({ branch: item.branch, kind: item.kind, targetOid: result.head })
  }
  const targets = await listRefs(`${queueRefPrefix(options.queue)}/changes/`, store)
  const sources = await listRefs(plan.sourcePrefix, store)
  for (const item of pending) {
    const written = applied.find((row) => row.branch === item.branch)
    if (
      written === undefined ||
      targets.get(item.targetRef) !== written.targetOid ||
      (item.kind === "move" ? sources.has(item.sourceRef) : sources.get(item.sourceRef) !== item.sourceOid)
    ) {
      throw new Error(`${item.branch}: postflight ref mismatch; inspect live target and quarantine source before retry`)
    }
  }
  return { plan, applied }
}

function output(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value))
    return
  }
  if (typeof value === "object" && value !== null && "items" in value) {
    const plan = value as AdoptionPlan
    console.log(
      `${plan.remote} ${plan.sourcePrefix}: ${plan.items.length} quarantine refs; queue ${plan.queueTip}; stop ${plan.stop ?? "none"}`,
    )
    for (const item of plan.items) {
      console.log(
        `${item.kind} ${item.state} ${item.sourceRef}@${item.sourceOid} -> ${item.targetRef}@${item.targetOid ?? "absent"}: ${JSON.stringify(item.events)}`,
      )
    }
    return
  }
  console.log(JSON.stringify(value))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.plan) {
    output((await planQuarantine(options)).plan, options.json)
    return
  }
  const result = await applyQuarantine(options)
  output(
    {
      remote: result.plan.remote,
      queue: result.plan.queue,
      queueTip: result.plan.queueTip,
      applied: result.applied,
      quarantineRefsDeleted: result.applied.filter((item) => item.kind === "move").length,
    },
    options.json,
  )
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `yrd adopt-quarantine: ${error instanceof Error ? error.message : String(error)} (code=quarantine-adoption-refused)`,
    )
    process.exitCode = 2
  })
}
