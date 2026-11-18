/**
 * `yrd env retained --discard <entry> --reason <why> [--apply]` (34787, @cto 34787-component-retention-ruling
 * correction 4 and 34787-discard-surface-authority-ruling).
 *
 * A retained entry whose component commits have no durable witness holds their last copy, so retirement keeps it. This
 * is the explicit way to lose exactly that set. Without --apply it previews: it runs GitSuper's verify, names the loss
 * per component (count, types, commit roots with subjects), the root refs that still pin a lost commit, and the
 * entry's recorded attribution, and it writes the exact disposition it would apply. --apply re-observes the loss and
 * must find that same disposition, refuses while a root ref pins a lost commit, records the decision in the Yrd log
 * and reads it back, then calls `git super worktree retention retire --discard`, which re-verifies under its leases.
 * The result row follows. Owner stays null: nothing here infers one, and the actor is only who decided.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  checkRetentionDiscard,
  RETENTION_DISCARD_SCHEMA,
  retentionDiscardDigest,
  type RetentionDiscard,
  type RetentionVerifyResult,
} from "git-super"
import { openLog, readRunLog, type LogRecord } from "@yrd/queue-core"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

/** One GitSuper invocation's raw outcome; the caller decides what a nonzero exit means. */
export type SuperRun = (args: readonly string[]) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>
/** Read the root store: `git <args>` in the repository whose refs may pin a component commit. */
export type RootGit = (args: readonly string[], input?: string) => Promise<string>

export type RetainedDiscardOptions = Readonly<{
  entry: string
  reason: string | undefined
  apply: boolean
  json: boolean
  retentionRoot: string
  common: string
  namespace: readonly string[]
  artifactDir: string
  logDirectory: string
  actor: string
}>

/** The root store's pin check: how many refs and distinct tips it read, and which pin a lost commit. */
type PinScan = Readonly<{ refs: number; tips: number; protectedBy: readonly string[] }>

type Observation = Readonly<{
  proof: RetentionVerifyResult
  disposition: RetentionDiscard
  lost: ReadonlySet<string>
  owner: string
  pins: PinScan
}>

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

/** The entry's recorded attribution, said plainly: the manifest never names an owner a reader could trust. */
function ownerLine(entry: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(entry, "manifest.json"), "utf8")) as {
      attribution?: Record<string, string | null>
    }
    const recorded = manifest.attribution
    if (recorded === undefined) return "owner unknown (legacy entry: no attribution recorded)"
    const owner = recorded.owner
    const facts = [
      recorded.actor === undefined || recorded.actor === null ? undefined : `closed by ${recorded.actor}`,
      recorded.issue === undefined || recorded.issue === null ? undefined : `issue ${recorded.issue}`,
      recorded.bay === undefined || recorded.bay === null ? undefined : `bay ${recorded.bay}`,
    ].filter((fact): fact is string => fact !== undefined)
    return `${owner === undefined || owner === null ? "owner unknown" : `recorded owner ${owner}`}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}`
  } catch (error) {
    return `owner unknown (manifest unreadable: ${error instanceof Error ? error.message : String(error)})`
  }
}

/** A partial clone answers from its local objects: a lazy network fetch is not a read, and a failed one ends the batch. */
const NO_LAZY_FETCH = "--no-lazy-fetch"

/** One `cat-file --batch-check` process: `[oid, type]` per query, or undefined for `<query> missing`. */
async function batchCheck(rootGit: RootGit, queries: readonly string[]) {
  if (queries.length === 0) return []
  const answers = (
    await rootGit(
      [NO_LAZY_FETCH, "cat-file", "--batch-check=%(objectname) %(objecttype)"],
      queries.map((query) => `${query}\n`).join(""),
    )
  ).split("\n")
  if (answers.at(-1) === "") answers.pop()
  if (answers.length !== queries.length) {
    throw new Error(`the root pin check asked ${String(queries.length)} and got ${String(answers.length)} answers`)
  }
  return answers.map((answer, index) => {
    if (answer === `${queries[index] as string} missing`) return undefined
    const [oid, type] = answer.split(" ")
    if (oid === undefined || type === undefined || !/^[0-9a-f]{40,64}$/u.test(oid)) {
      throw new Error(`the root pin check cannot read its answer for ${queries[index] as string}: ${answer}`)
    }
    return { oid, type }
  })
}

/**
 * Every root ref, in every namespace (branches, tags, remotes, queue changes, archives, pins), whose tree pins a lost
 * commit by gitlink. One for-each-ref and one `cat-file --batch-check` over `<tip>:<component>` read the whole store
 * with no tip bound. `missing` means either an absent path or an absent tree object, so each missing answer is
 * resolved: its deepest local ancestor tree is listed, and an entry named there whose object is not local is unknown
 * and thrown, never read as "no pin".
 */
async function pinningRoots(
  rootGit: RootGit,
  lost: ReadonlySet<string>,
  components: readonly string[],
): Promise<PinScan> {
  const refsByTip = new Map<string, string[]>()
  let refs = 0
  for (const line of (await rootGit(["for-each-ref", "--format=%(objectname) %(refname)"])).split("\n")) {
    if (line === "") continue
    const space = line.indexOf(" ")
    const tip = line.slice(0, space)
    if (space < 0 || !/^[0-9a-f]{40,64}$/u.test(tip)) throw new Error(`unreadable root ref line: ${line}`)
    refs += 1
    const named = refsByTip.get(tip)
    if (named === undefined) refsByTip.set(tip, [line.slice(space + 1)])
    else named.push(line.slice(space + 1))
  }
  const refOf = (tip: string) => {
    const named = refsByTip.get(tip) ?? []
    return `${named[0] ?? tip}${named.length > 1 ? ` (and ${String(named.length - 1)} more ref(s) at that tip)` : ""}`
  }
  const queries = [...refsByTip.keys()].flatMap((tip) => components.map((component) => ({ tip, component })))
  const protectedBy: string[] = []
  const unresolved: { tip: string; component: string }[] = []
  // `<rev>:<path>` peels tags to their tree. A gitlink answers `submodule`, or `commit` when its target is local.
  for (const [index, answer] of (
    await batchCheck(
      rootGit,
      queries.map((q) => `${q.tip}:${q.component}`),
    )
  ).entries()) {
    const query = queries[index] as { tip: string; component: string }
    if (answer === undefined) {
      unresolved.push(query)
    } else if ((answer.type === "submodule" || answer.type === "commit") && lost.has(answer.oid)) {
      protectedBy.push(`${refOf(query.tip)} pins ${query.component} at ${answer.oid}`)
    }
  }
  // Each missing answer: the deepest ancestor that is a local tree, and the next path segment to look for in it.
  const levels = unresolved.map(({ tip, component }) => {
    const segments = component.split("/")
    const prefixes = segments.slice(0, -1).map((_, depth) => `${tip}:${segments.slice(0, depth + 1).join("/")}`)
    return { tip, component, segments, queries: [`${tip}^{tree}`, ...prefixes] }
  })
  const ancestors = await batchCheck(
    rootGit,
    levels.flatMap((level) => level.queries),
  )
  const lookups: { tip: string; component: string; tree: string; name: string; at: string }[] = []
  let offset = 0
  for (const level of levels) {
    const answers = ancestors.slice(offset, offset + level.queries.length)
    offset += level.queries.length
    // answers[0] is the root tree, answers[i] the tree at the first i segments; the chain stops at the first gap.
    const first = answers.findIndex((answer) => answer === undefined || answer.type !== "tree")
    if (first === 0) {
      throw new Error(`cannot tell whether ${refOf(level.tip)} pins ${level.component}: its tree is not local`)
    }
    // A path below a blob or gitlink cannot exist.
    if (first > 0 && answers[first] !== undefined) continue
    const depth = first < 0 ? answers.length - 1 : first - 1
    // Every ancestor is local, so the component entry itself is absent or a non-gitlink whose object is not local
    // (an absent gitlink target still answers `submodule`): either way, no pin.
    if (depth === level.segments.length - 1) continue
    const at = answers[depth] as { oid: string; type: string }
    lookups.push({
      tip: level.tip,
      component: level.component,
      tree: at.oid,
      name: level.segments[depth] as string,
      at: level.segments.slice(0, depth).join("/"),
    })
  }
  const names = new Map<string, ReadonlySet<string>>()
  for (const tree of new Set(lookups.map((lookup) => lookup.tree))) {
    const listing = await rootGit([NO_LAZY_FETCH, "ls-tree", "-z", "--name-only", tree])
    names.set(tree, new Set(listing.split("\0").filter((name) => name !== "")))
  }
  for (const lookup of lookups) {
    if (names.get(lookup.tree)?.has(lookup.name) === true) {
      throw new Error(
        `cannot tell whether ${refOf(lookup.tip)} pins ${lookup.component}: ${lookup.at === "" ? "" : `${lookup.at}/`}${lookup.name} is named in its tree but not in the local store`,
      )
    }
  }
  return { refs, tips: refsByTip.size, protectedBy }
}

async function observe(
  options: RetainedDiscardOptions,
  runSuper: SuperRun,
  rootGit: RootGit,
  pass: string,
): Promise<Observation> {
  const entry = join(options.retentionRoot, options.entry)
  const verified = await runSuper([
    "super",
    "--json",
    "worktree",
    "retention",
    "verify",
    entry,
    "--root",
    options.retentionRoot,
    ...options.namespace.flatMap((path) => ["--namespace", path]),
    "--artifact-dir",
    join(options.artifactDir, options.entry, pass),
  ])
  let proof: RetentionVerifyResult
  try {
    proof = JSON.parse(verified.stdout) as RetentionVerifyResult
  } catch {
    throw new Error(
      `git super retention verify of ${entry} gave no JSON result (exit ${String(verified.code)}): ${verified.stderr.trim()}`,
    )
  }
  if (proof.verdict === "candidate") {
    throw new Error(`every at-risk object of ${entry} has a durable witness; nothing to discard (use --retire-expired)`)
  }
  const custody = proof.gates.find((gate) => gate.gate === "positive-custody")
  if (custody?.status !== "blocked" || proof.custody?.missingSidecar === undefined) {
    throw new Error(
      `the loss of ${entry} is not known, so it cannot be discarded: ${proof.reasons.join("; ") || `verdict ${proof.verdict}`}`,
    )
  }
  const unknownRoots = proof.custody.loss.find((component) => component.roots === undefined)
  if (unknownRoots !== undefined) {
    throw new Error(
      `commit roots of ${unknownRoots.component} are unknown (${unknownRoots.rootsUnknown ?? "no reason"}); nothing discarded`,
    )
  }
  const lost = new Set<string>()
  for (const line of readFileSync(proof.custody.missingSidecar.path, "utf8").split("\n")) {
    const oid = line.split("\t")[0]
    if (oid !== undefined && oid !== "") lost.add(oid)
  }
  if (lost.size !== proof.custody.missingCount) {
    throw new Error(
      `missing-object list ${proof.custody.missingSidecar.path} names ${String(lost.size)}, not ${String(proof.custody.missingCount)}`,
    )
  }
  // A component's store sits at modules/<path>; the root store pins that same path by gitlink.
  const components = proof.custody.loss.map((component) => component.component)
  const disposition = checkRetentionDiscard({
    schema: RETENTION_DISCARD_SCHEMA,
    entry: proof.entry,
    entryDevIno: proof.entryDevIno,
    manifestSha256: proof.manifestSha256,
    missingCount: proof.custody.missingCount,
    missingSidecarSha256: proof.custody.missingSidecar.sha256,
    loss: proof.custody.loss,
    reason: options.reason,
    attribution: { actor: options.actor, owner: null },
  })
  return {
    proof,
    disposition,
    lost,
    owner: ownerLine(entry),
    pins: await pinningRoots(rootGit, lost, components),
  }
}

function describe(observation: Observation): string[] {
  const { proof, disposition } = observation
  const lines = [
    `${proof.entry}: ${String(disposition.missingCount)} un-witnessed object(s) have no durable copy elsewhere; ${observation.owner}`,
  ]
  for (const component of disposition.loss) {
    const types = Object.entries(component.types)
      .map(([type, count]) => `${String(count)} ${type}`)
      .join(", ")
    lines.push(`  ${component.component}: ${String(component.count)} object(s) (${types})`)
    for (const root of component.roots ?? []) lines.push(`    ${root.oid} ${root.subject}`)
  }
  const others = proof.gates.filter((gate) => gate.gate !== "positive-custody" && gate.status !== "pass")
  for (const gate of others) lines.push(`  still applies: ${gate.gate} ${gate.status}: ${gate.message}`)
  const { pins } = observation
  lines.push(
    `  root pin check: ${String(pins.refs)} ref(s) in every namespace, ${String(pins.tips)} distinct tip(s); ${String(pins.protectedBy.length)} pin a lost commit`,
  )
  for (const pin of pins.protectedBy) lines.push(`  protected: ${pin}; withdraw that root ref first`)
  return lines
}

/** The preview and the decision both live beside the entry's pass evidence. */
function previewPath(options: RetainedDiscardOptions): string {
  return join(options.artifactDir, options.entry, "discard-preview.json")
}

export async function discardRetainedEntry(
  options: RetainedDiscardOptions,
  io: YrdCliIO,
  runSuper: SuperRun,
  rootGit: RootGit,
): Promise<YrdCliExitCode> {
  if (basename(options.entry) !== options.entry || options.entry === "." || options.entry === "..") {
    throw new Error(`--discard ${options.entry} must name one direct child of ${options.retentionRoot}`)
  }
  if (options.reason === undefined || options.reason.trim() === "") {
    throw new Error("--discard requires --reason <why>; nothing was discarded")
  }
  if (options.namespace.length === 0 || options.artifactDir === "") {
    throw new Error("--discard requires the complete --namespace declaration and --artifact-dir; nothing was discarded")
  }
  if (options.apply && (options.actor.trim() === "" || options.actor === "unknown")) {
    throw new Error("--discard --apply requires an identified actor (YRD_DEFAULT_SUBMITTER); 'unknown' decides nothing")
  }
  if (!options.apply) {
    const observation = await observe(options, runSuper, rootGit, "preview")
    const path = previewPath(options)
    mkdirSync(join(options.artifactDir, options.entry), { recursive: true })
    writeFileSync(path, `${JSON.stringify(observation.disposition, null, 2)}\n`)
    const lines = [
      ...describe(observation),
      `preview ${path} (disposition ${retentionDiscardDigest(observation.disposition)}); nothing was discarded`,
      observation.pins.protectedBy.length > 0
        ? "--apply refuses while a root ref pins a lost commit"
        : "to lose exactly this set: rerun with --apply as the deciding actor, with the same --reason",
    ]
    io.stdout(
      options.json
        ? `${JSON.stringify({ entry: observation.proof.entry, apply: false, preview: path, disposition: observation.disposition, pinCheck: observation.pins, owner: observation.owner })}\n`
        : `${lines.join("\n")}\n`,
    )
    return 0
  }
  const path = previewPath(options)
  if (!existsSync(path)) {
    throw new Error(`no discard preview at ${path}; preview first (omit --apply); nothing was discarded`)
  }
  const previewed = checkRetentionDiscard(JSON.parse(readFileSync(path, "utf8")) as unknown)
  const observation = await observe(options, runSuper, rootGit, "apply")
  if (JSON.stringify(canonical(previewed)) !== JSON.stringify(canonical(observation.disposition))) {
    throw new Error(
      `the loss, reason or actor of ${observation.proof.entry} differs from the preview at ${path}; preview again; nothing was discarded`,
    )
  }
  if (observation.pins.protectedBy.length > 0) {
    io.stderr(`${describe(observation).join("\n")}\n`)
    throw new Error(
      `${String(observation.pins.protectedBy.length)} root ref(s) still pin a lost commit; nothing was discarded`,
    )
  }
  const digest = retentionDiscardDigest(observation.disposition)
  const dispositionFile = join(options.artifactDir, options.entry, `disposition-${digest}.json`)
  writeFileSync(dispositionFile, `${JSON.stringify(observation.disposition, null, 2)}\n`)
  const log = openLog(options.logDirectory)
  log.write({ kind: "run", command: "env retained --discard", pid: process.pid, target: options.retentionRoot })
  const roots = observation.disposition.loss.flatMap((component) =>
    (component.roots ?? []).map((root) => `${component.component} ${root.oid} ${root.subject}`),
  )
  let decision: LogRecord
  try {
    decision = log.write({
      kind: "retained-discard",
      outcome: "decision",
      entry: observation.proof.entry,
      actor: options.actor,
      owner: "unknown",
      attribution: observation.owner,
      reason: observation.disposition.reason,
      disposition: digest,
      dispositionFile,
      missingCount: observation.disposition.missingCount,
      missingSidecarSha256: observation.disposition.missingSidecarSha256,
      roots,
      pinCheckRefs: observation.pins.refs,
      pinCheckTips: observation.pins.tips,
      pid: process.pid,
    })
    const fd = openSync(log.path, "r")
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const rows = readRunLog(dirname(log.path), log.id)
    if (!rows.some((row) => JSON.stringify(row) === JSON.stringify(decision))) {
      throw new Error("exact decision row is missing or differs")
    }
  } catch (cause) {
    throw new Error(`discard decision could not be recorded in ${log.path}: ${String(cause)}; nothing was discarded`)
  }
  const retired = await runSuper([
    "super",
    "--json",
    "worktree",
    "retention",
    "retire",
    observation.proof.entry,
    "--root",
    options.retentionRoot,
    "--common",
    options.common,
    ...options.namespace.flatMap((ns) => ["--namespace", ns]),
    "--artifact-dir",
    join(options.artifactDir, options.entry, `retire-${log.id}`),
    "--discard",
    dispositionFile,
  ])
  let detail: { code?: string; message?: string } = {}
  try {
    detail = (JSON.parse(retired.stdout) as { detail?: { code?: string; message?: string } }).detail ?? {}
  } catch {
    detail = { code: "unreadable", message: `exit ${String(retired.code)}: ${retired.stderr.trim()}` }
  }
  const discarded = retired.code === 0 && detail.code === "discarded"
  log.write({
    kind: "retained-discard",
    outcome: discarded ? "discarded" : "kept",
    entry: observation.proof.entry,
    actor: options.actor,
    disposition: digest,
    code: detail.code ?? "none",
    message: detail.message ?? retired.stderr.trim(),
    pid: process.pid,
  })
  const summary = discarded
    ? `discarded ${observation.proof.entry}: ${String(observation.disposition.missingCount)} un-witnessed object(s) lost by ${options.actor}'s decision (${observation.owner}); decision and result in ${log.path}`
    : `kept ${observation.proof.entry}: ${detail.code ?? "unknown"}: ${detail.message ?? retired.stderr.trim()}; decision and result in ${log.path}; fix the named cause and rerun --apply`
  io.stdout(
    options.json
      ? `${JSON.stringify({ entry: observation.proof.entry, apply: true, discarded, disposition: digest, log: log.path, detail })}\n`
      : `${summary}\n`,
  )
  return discarded ? 0 : 1
}
