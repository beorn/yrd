import { basename, resolve } from "node:path"
import { Command as CliCommand } from "@silvery/commander"
import { failureFact, raiseFailure, type FailureFact } from "@yrd/core"
import { resolveYrdObservability, type YrdObservability, type YrdObservabilityFlags } from "./observability.ts"
import { parseQualifiedRunRef, type QualifiedRunRef } from "./qualified-run-ref.ts"
import type { YrdCliExitCode } from "./types.ts"

export type Invocation = Readonly<{
  name: string
  args: string[]
}>

type QueueRunMode = "follow" | "once"

export type RuntimePosture =
  | "active"
  | "viewer"
  | "journal-view-repair"
  /** Recovery: assembles its own app because the ordinary boot is the failure. */
  | "saved-state-rebuild"
  | "bracketed-bay-open"
  | "one-shot-queue-run"
  | "resident-queue-run"

export type NormalizedYrdInvocation = Invocation &
  Readonly<{
    posture: RuntimePosture
    queueRunMode?: QueueRunMode
    queueRunnerCheck: boolean
  }>

export type YrdRepositoryAlias = Readonly<{
  repository: Readonly<{ name: string; path: string }>
  queue: Readonly<{ base: string }>
}>

export type YrdRepositoryAliasInvocation =
  | Readonly<{ kind: "all-repositories-read"; args: string[] }>
  | (YrdRepositoryAlias & Readonly<{ kind: "repository-read" | "repository-write"; args: string[] }>)
  | Readonly<{ kind: "bypass"; args: string[] }>

export type FailureVerdict = Readonly<{ exitCode: YrdCliExitCode; failure: FailureFact }>

export type YrdContext = Readonly<{
  /** Git path used to discover the repository and its operation root. */
  repo: string
  /** Base-relative programmatic config selected by --config. */
  configPath?: string
  /** One host-owned logging policy shared by every command service. */
  observability: YrdObservability
}>

const increaseDiagnostics = (_value: string, previous: number): number => previous + 1

/** Install the one set of process-level options on a Commander root. */
export function configureYrdGlobalOptions(program: CliCommand): CliCommand {
  return program
    .option("--repo <path>", "repository authority and operation root (env: YRD_REPO)")
    .option("--config <path>", "base-relative .yml/.yaml config authority")
    .option("-v, --verbose", "increase diagnostics (-vv enables spans, -vvv traces)", increaseDiagnostics, 0)
    .option("-q, --quiet", "reduce diagnostics (-q errors only, -qq silent)", increaseDiagnostics, 0)
    .option("--log-level <level>", "set trace, debug, info, warn, error, or silent (env: LOG_LEVEL)")
}

const ROOT_COMMAND_ALIASES = {
  bays: "bay",
  contests: "contest",
  issues: "issue",
  prs: "pr",
  queues: "queue",
} as const

const LIST_COMMAND_PARENTS = new Set(["bay", "pr", "queue"])

/**
 * Every subcommand registered under `queue` in the command tree.
 *
 * This list is a SECOND source of truth and it fails silently: an operand that
 * is missing here is spliced into `queue list <operand>` below, which succeeds
 * and prints the timeline, so a newly registered subcommand appears in `--help`
 * and simply never runs. `queue uncarried` did exactly that — registered,
 * documented, dispatching to the timeline. `tests/invocation-tree-agreement.test.ts`
 * now fails when this set and the tree disagree, so the next person gets a red
 * test instead of a command that quietly does something else.
 */
const QUEUE_SUBCOMMANDS = new Set([
  "_list",
  "list",
  "audit",
  "candidate-refs",
  "uncarried",
  "pause",
  "resume",
  "recover",
  "run",
  "cancel",
  "finish",
])

/**
 * Every spelling that names a queue subcommand, mapped to the canonical argv it
 * stands for.
 *
 * ONE table, because these names must be recognized in TWO operand positions —
 * `queue <spelling>` and `queue <repository> <spelling>` — and a name recognized
 * in only one of them does not fail in the other, it silently becomes a
 * positional FILTER TERM. `yrd queue code list` did exactly that: measured live
 * 2026-08-14 it answered 8 rows where `yrd queue code` answered 1,091, with no
 * note; `yrd queue code run` quietly listed the timeline instead of running the
 * queue. One table is also why `ls`, `status` and `watch` cannot be handled in
 * only one of the two positions again.
 */
const QUEUE_SUBCOMMAND_SPELLINGS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ...[...QUEUE_SUBCOMMANDS].map((name) => [name, [name]] as const),
  ["ls", ["list"]],
  ["status", ["list"]],
  ["watch", ["list", "--watch"]],
])

/** The canonical argv an operand stands for, or undefined when it is a filter term. */
function queueSubcommandSpelling(operand: string | undefined): readonly string[] | undefined {
  return operand === undefined ? undefined : QUEUE_SUBCOMMAND_SPELLINGS.get(operand)
}

/**
 * Refuse a filter term spelled exactly like a queue subcommand.
 *
 * Resolving the two operands after `queue` removes the ambiguity where it can
 * be resolved; this is the residue — `yrd queue list list`, or any term a
 * standalone repository (which has no declared repository names) leaves in
 * filter position. Answering it as a search is the prohibited outcome, so the
 * command refuses and names both readings plus the explicit escape hatch.
 */
export function refuseShadowedQueueFilterTerms(terms: readonly string[]): void {
  for (const term of terms) {
    if (!QUEUE_SUBCOMMAND_SPELLINGS.has(term)) continue
    usage(
      `'${term}' is a queue subcommand, not a filter term; run 'yrd queue ${term}' for the command, or pass --term ${term} to filter the timeline by that word`,
    )
  }
}

function rootCommandIndex(args: readonly string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--repo" || arg === "--config" || arg === "--log-level") {
      index += 1
      continue
    }
    if (arg?.startsWith("-")) continue
    return index
  }
  return undefined
}

function canonicalizeYrdCommandSpellings(args: string[], commandIndex: number): void {
  const command = args[commandIndex]
  const alias = command === undefined ? undefined : ROOT_COMMAND_ALIASES[command as keyof typeof ROOT_COMMAND_ALIASES]
  if (alias !== undefined) args[commandIndex] = alias
  if (args[commandIndex] === "watch") {
    args.splice(commandIndex, 1, "queue", "list", "--watch")
  }
  if (LIST_COMMAND_PARENTS.has(args[commandIndex] ?? "") && args[commandIndex + 1] === "ls") {
    args[commandIndex + 1] = "list"
  }
  if (args[commandIndex] !== "queue") return
  const spelling = queueSubcommandSpelling(args[commandIndex + 1])
  if (spelling !== undefined) args.splice(commandIndex + 1, 1, ...spelling)
}

/** Translate parse-only legacy spellings before Commander sees them. This keeps
 * help and suggestions canonical without requiring a newer Commander API. */
export function canonicalizeYrdCommandAliases(args: readonly string[]): string[] {
  const canonical = [...args]
  const commandIndex = rootCommandIndex(canonical)
  if (commandIndex === undefined) return canonical
  canonicalizeYrdCommandSpellings(canonical, commandIndex)
  const queueOperand = canonical[commandIndex + 1]
  if (
    canonical[commandIndex] === "queue" &&
    queueOperand !== "--help" &&
    queueOperand !== "-h" &&
    !QUEUE_SUBCOMMANDS.has(queueOperand ?? "")
  ) {
    canonical.splice(commandIndex + 1, 0, "list")
  }
  return canonical
}

const READ_ONLY_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  bay: new Set(["_list", "list", "path", "log"]),
  // `uncarried` reads refs and queue state and writes nothing, so a viewer
  // runtime must be able to run it — the rail is least useful exactly where
  // mutation is not allowed.
  queue: new Set(["_list", "list", "audit", "uncarried"]),
  pr: new Set(["list", "view", "runs", "diff", "status", "checks"]),
  mr: new Set(["list", "view", "runs", "diff", "status", "checks"]),
  issue: new Set(["_list", "list", "view"]),
  contest: new Set(["_list", "list", "view"]),
}

function queueRunMode(args: readonly string[], queueIndex: number): QueueRunMode {
  const tail = args.slice(queueIndex + 2)
  if (tail.includes("--once")) return "once"
  const stepsIndex = tail.indexOf("--steps")
  const selectorRegion = stepsIndex < 0 ? tail : tail.slice(0, stepsIndex)
  for (let index = 0; index < selectorRegion.length; index += 1) {
    const argument = selectorRegion[index]
    if (argument === "--interval") {
      index += 1
      continue
    }
    if (argument?.startsWith("-")) continue
    return "once"
  }
  return "follow"
}

function invocationPosture(args: readonly string[], commandIndex: number | undefined): RuntimePosture {
  if (commandIndex === undefined) return "viewer"
  const command = args[commandIndex]
  const subcommand = args[commandIndex + 1]
  if (command === "_dashboard" || command === "log") return "viewer"
  if (command !== undefined && subcommand !== undefined && READ_ONLY_SUBCOMMANDS[command]?.has(subcommand) === true) {
    return "viewer"
  }
  if (
    (command === "bay" && (subcommand === "open" || subcommand === "run" || subcommand === "in")) ||
    command === "open" ||
    command === "run" ||
    command === "in" ||
    command === "sh"
  ) {
    return "bracketed-bay-open"
  }
  // Checked before the view-repair row: this posture must not load the runtime
  // at all, because loading it is exactly what fails.
  if (command === "doctor" && subcommand === "rebuild-saved-state") return "saved-state-rebuild"
  if (command === "doctor" && args.includes("--rebuild-views")) return "journal-view-repair"
  if (command === "queue" && subcommand === "run") {
    return queueRunMode(args, commandIndex) === "follow" ? "resident-queue-run" : "one-shot-queue-run"
  }
  return "active"
}

function queueRunnerCheck(args: readonly string[], commandIndex: number | undefined): boolean {
  if (commandIndex === undefined || args[commandIndex] !== "queue" || args[commandIndex + 1] !== "list") return false
  const options = args.slice(commandIndex + 2)
  return options.includes("--check") && options.every((argument) => argument === "--check" || argument === "--json")
}

/** Resolve executable spelling, canonical aliases, runtime posture, run mode,
 * and bootstrap-health eligibility exactly once for one process invocation. */
export function normalizeYrdInvocation(argv: readonly string[]): NormalizedYrdInvocation {
  const invocation = resolveInvocation(argv)
  const args = canonicalizeYrdCommandAliases(invocation.args)
  const commandIndex = rootCommandIndex(args)
  const mode =
    commandIndex !== undefined && args[commandIndex] === "queue" && args[commandIndex + 1] === "run"
      ? queueRunMode(args, commandIndex)
      : undefined
  return Object.freeze({
    name: invocation.name,
    args,
    posture: invocationPosture(args, commandIndex),
    ...(mode === undefined ? {} : { queueRunMode: mode }),
    queueRunnerCheck: queueRunnerCheck(args, commandIndex),
  })
}

function namedAlternatives(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "a declared repository"
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`
}

/**
 * Resolve `<repository>:<base>#<number>` against the repository this command
 * was already routed to. Our own prefix is stripped, leaving the bare form the
 * resolver accepts; a SIBLING's prefix refuses, because that run lives in a
 * journal this process will never open and stripping it would silently resolve
 * our own run of the same number instead. An undeclared prefix is left alone —
 * it is ordinary text as far as the composition is concerned, and the ordinary
 * not-found refusal already names it.
 *
 * Only OPERAND positions are rewritten. An option's value is ordinary text the
 * operator wrote for a human to read, and rewriting the whole tail edited it:
 * `--reason "code:main#7"` had its own prefix silently stripped out of the
 * journalled prose, and `--reason "pm:main#2711"` aborted the command with a
 * refusal about a run that was never its subject. Every queue spelling puts its
 * operands before its options, so the rewrite stops at the first option-looking
 * token and everything from there travels verbatim — including the values of
 * variadic options such as `--allow` and `--steps`, whose arity this adapter
 * deliberately does not model. A qualified reference typed AFTER an option is
 * therefore left alone and refused downstream by
 * {@link requireUnqualifiedRunSelector}, which names the same remedy.
 */
function localRunReferences(
  tail: readonly string[],
  ownName: string,
  byName: ReadonlyMap<string, YrdRepositoryAlias>,
  remedy: (qualified: QualifiedRunRef) => string,
): string[] {
  const firstOption = tail.findIndex((token) => token.startsWith("-"))
  const operands = firstOption < 0 ? tail.length : firstOption
  return tail.map((token, index) => {
    if (index >= operands) return token
    const qualified = parseQualifiedRunRef(token)
    if (qualified === undefined) return token
    if (qualified.repository === ownName) return qualified.run
    if (!byName.has(qualified.repository)) return token
    usage(
      `run '${token}' lives in Yrd repository '${qualified.repository}', not '${ownName}'; run '${remedy(qualified)}' to reach it`,
    )
  })
}

/** Optional composition-host adapter for named repositories. Standalone Yrd
 * deliberately never calls this: aliases are injected by the installed host. */
export function normalizeYrdRepositoryAliasInvocation(
  input: readonly string[],
  declarations: readonly YrdRepositoryAlias[],
): YrdRepositoryAliasInvocation {
  const args = [...input]
  if (args.some((argument) => argument === "--repo" || argument.startsWith("--repo="))) {
    return { kind: "bypass", args }
  }
  const queueIndex = rootCommandIndex(args)
  if (queueIndex === undefined) return { kind: "bypass", args }
  canonicalizeYrdCommandSpellings(args, queueIndex)
  if (args[queueIndex] !== "queue") return { kind: "bypass", args }
  const byName = new Map(declarations.map((declaration) => [declaration.repository.name, declaration] as const))
  const requiredRepository = (name: string | undefined): YrdRepositoryAlias => {
    const declaration = name === undefined ? undefined : byName.get(name)
    if (declaration !== undefined) return declaration
    const expected = namedAlternatives([...byName.keys()])
    usage(`unknown Yrd repository '${name ?? ""}'; expected ${expected}`)
  }
  const prefix = args.slice(0, queueIndex)
  const readOnly = (command: string): boolean => READ_ONLY_SUBCOMMANDS.queue?.has(command) === true
  const resolved = resolveQueueOperands(args, queueIndex, byName, requiredRepository, readOnly)
  const [command = "list", ...commandFlags] = resolved.command
  if (resolved.declaration === undefined) {
    // Reads with no repository named span every declared repository; the other
    // read rails have no all-repository projection, so they stay ambient.
    if (command !== "list" && command !== "_list") return { kind: "bypass", args }
    const tail = [...commandFlags, ...resolved.tail]
    if (tail.includes("--watch")) {
      const remedies = namedAlternatives([...byName.keys()].map((name) => `'yrd queue ${name} --watch'`))
      usage(`all-repository queue watch is unsupported; run ${remedies}`)
    }
    return { kind: "all-repositories-read", args: [...prefix, "queue", "list", ...tail] }
  }
  const declaration = resolved.declaration
  // `yrd queue <repository>` names a REPOSITORY, so it asks the same question
  // `yrd queue list` asks inside that repository: every queue with work, each
  // carrying a 1..N label (user directive 2026-08-13). Injecting the declared
  // base here as `--base` answered a narrower question — one queue, no labels,
  // no legend, no digit toggles — on every aliased path, which is every path a
  // composition host has. The base an operator names travels in the tail like
  // any other option; the declaration's base is not argv, it is the
  // repository's own configured base, which the CLI reads for the primary
  // label. `pause` and `resume` are the exception because their base is an
  // OPERAND they cannot run without, not a scope filter over a listing.
  const scope = command === "pause" || command === "resume" ? [declaration.queue.base] : []
  return {
    kind: readOnly(command) ? "repository-read" : "repository-write",
    ...declaration,
    args: [
      ...prefix,
      "--repo",
      declaration.repository.path,
      "queue",
      command,
      ...scope,
      ...commandFlags,
      ...localRunReferences(resolved.tail, declaration.repository.name, byName, (qualified) =>
        [
          "yrd",
          "queue",
          ...(resolved.typed === undefined ? [] : [resolved.typed]),
          qualified.repository,
          qualified.run,
        ].join(" "),
      ),
    ],
  }
}

type ResolvedQueueOperands = Readonly<{
  command: readonly string[]
  declaration?: YrdRepositoryAlias
  tail: string[]
  /** The subcommand as the operator spelled it, absent when they named only a repository. A
   * remedy echoes this rather than the canonical argv so the command it prints is the one they
   * typed — `yrd queue watch beta ...`, never the `list --watch` it expands to. */
  typed?: string
}>

/**
 * Split the operands after `queue` into one subcommand and one repository, in
 * EITHER order: both `yrd queue run alpha` and `yrd queue alpha run` read
 * naturally, and an order this does not recognize does not refuse — it falls
 * through to a positional filter term and answers a different question.
 *
 * The two positions are not symmetric in what they require. A WRITE names its
 * repository, because there is no all-repository write; a READ spans every
 * repository by default and scopes to one only when the operand is a DECLARED
 * name, which keeps `yrd queue list topic/alpha` the cross-repository term
 * search it has always been.
 */
function resolveQueueOperands(
  args: readonly string[],
  queueIndex: number,
  byName: ReadonlyMap<string, YrdRepositoryAlias>,
  requiredRepository: (name: string | undefined) => YrdRepositoryAlias,
  readOnly: (command: string) => boolean,
): ResolvedQueueOperands {
  const first = args[queueIndex + 1]
  if (first === undefined || first.startsWith("-")) {
    return { command: ["list"], tail: args.slice(queueIndex + 1) }
  }
  const spelling = queueSubcommandSpelling(first)
  if (spelling === undefined) {
    const declaration = requiredRepository(first)
    const typed = args[queueIndex + 2]
    const next = queueSubcommandSpelling(typed)
    if (next === undefined) return { command: ["list"], declaration, tail: args.slice(queueIndex + 2) }
    return { command: next, declaration, tail: args.slice(queueIndex + 3), typed }
  }
  if (!readOnly(spelling[0] ?? "list")) {
    return {
      command: spelling,
      declaration: requiredRepository(args[queueIndex + 2]),
      tail: args.slice(queueIndex + 3),
      typed: first,
    }
  }
  const named = args[queueIndex + 2]
  const declaration = named === undefined ? undefined : byName.get(named)
  if (declaration === undefined) return { command: spelling, tail: args.slice(queueIndex + 2), typed: first }
  return { command: spelling, declaration, tail: args.slice(queueIndex + 3), typed: first }
}

/** Resolve the command operand with Commander's canonical global-option rules. */
export function yrdCommandOperand(args: readonly string[]): string | undefined {
  const parser = configureYrdGlobalOptions(new CliCommand("yrd"))
  return parser.parseOptions([...args]).operands[0]
}

/** Resolve the one repository selector against the captured invocation
 * directory. CLI overrides environment; ambient discovery is the fallback. */
export function resolveYrdContext(
  options: Readonly<{ repo?: string; config?: string }> & YrdObservabilityFlags,
  env: Readonly<Record<string, string | undefined>>,
  ambientCwd: string,
): YrdContext {
  const ambient = resolve(ambientCwd)
  return Object.freeze({
    repo: resolve(ambient, options.repo ?? env.YRD_REPO ?? "."),
    ...(options.config === undefined ? {} : { configPath: options.config }),
    observability: resolveYrdObservability(options, env),
  })
}

function executableName(value: string | undefined): string {
  if (value === undefined) return ""
  return basename(value).replace(/\.(?:[cm]?[jt]s)$/u, "")
}

function presentation(executable: string): Pick<Invocation, "name"> | undefined {
  if (executable === "git-yrd") return { name: "git yrd" }
  if (executable === "yrd") return { name: "yrd" }
  return undefined
}

/** Resolve process.argv, direct argv, and Git's two-token spelling. */
export function resolveInvocation(argvInput: readonly string[]): Invocation {
  const argv = [...argvInput]
  const first = executableName(argv[0])
  const second = executableName(argv[1])
  if (first === "git" && argv[1] === "yrd") return { name: "git yrd", args: argv.slice(2) }

  const direct = presentation(first)
  if (direct !== undefined) return { ...direct, args: argv.slice(1) }

  const script = presentation(second)
  if (script !== undefined) return { ...script, args: argv.slice(2) }

  return { name: "yrd", args: argv }
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value))}\n`
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== "object" || value === null) return value
  const object = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, stableValue(object[key])]),
  )
}

export function classifyFailure(error: unknown): FailureVerdict {
  const failure =
    failureFact(error) ??
    Object.freeze({
      kind: "infrastructure" as const,
      code: "unexpected",
      message: error instanceof Error ? error.message : String(error),
    })
  const exitCode = (
    failure.kind === "refusal" ? 1 : failure.kind === "usage" || failure.kind === "configuration" ? 2 : 3
  ) satisfies YrdCliExitCode
  return Object.freeze({ exitCode, failure })
}

export type UnrecognizedKeyFailure = Readonly<{ keys: readonly string[] }>

/** Journal rows written by a newer Yrd surface as Zod `unrecognized_keys`
 * issues, either bare (domain event replay) or as the cause of a journal
 * corruption error (storage frame decode). Detection duck-types the issue
 * shape because the raising Zod instance may not be this module's import. */
export function unrecognizedKeyFailure(error: unknown): UnrecognizedKeyFailure | undefined {
  const keys = new Set<string>()
  let cause: unknown = error
  for (let depth = 0; typeof cause === "object" && cause !== null && depth < 8; depth += 1) {
    const record = cause as Readonly<{ issues?: unknown; cause?: unknown }>
    if (Array.isArray(record.issues)) collectUnrecognizedKeys(record.issues, keys, 0)
    cause = record.cause
  }
  if (keys.size === 0) return undefined
  return Object.freeze({ keys: Object.freeze([...keys].sort()) })
}

function collectUnrecognizedKeys(issues: readonly unknown[], into: Set<string>, depth: number): void {
  if (depth > 4) return
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue
    const record = issue as Readonly<{ code?: unknown; keys?: unknown; errors?: unknown }>
    if (record.code === "unrecognized_keys" && Array.isArray(record.keys)) {
      for (const key of record.keys) if (typeof key === "string") into.add(key)
    }
    if (record.code === "invalid_union" && Array.isArray(record.errors)) {
      for (const branch of record.errors) {
        if (Array.isArray(branch)) collectUnrecognizedKeys(branch, into, depth + 1)
      }
    }
  }
}

export function usage(message: string): never {
  raiseFailure("usage", "invalid-usage", message)
}

export function configuration(message: string): never {
  raiseFailure("configuration", "invalid-configuration", message)
}

export function refusal(message: string): never {
  raiseFailure("refusal", "request-refused", message)
}
