import { resolve } from "node:path"
import {
  normalizeYrdRepositoryAliasInvocation,
  resolveInvocation,
  type YrdRepositoryAlias,
  type YrdRepositoryAliasInvocation,
} from "./invocation.ts"
import { repositoryAuthority } from "./repository-authority.ts"

/**
 * Named repositories, declared by an embedding host rather than by Yrd.
 *
 * {@link normalizeYrdRepositoryAliasInvocation} has always known how to rewrite
 * `yrd queue <repository> …` into `--repo <path> queue …`; what lived outside
 * Yrd was everything that DRIVES it — where the declarations come from, how a
 * declared path becomes the one authority that owns the journal, and how a read
 * with no repository named spans them all. That driver is here now, so the same
 * spellings work from Yrd's own executable with no launcher in front of it.
 *
 * Yrd has no opinion about which repositories exist. A host declares them in
 * {@link YRD_REPOSITORY_ALIASES_ENV}; with nothing declared, every function
 * here is inert and Yrd behaves exactly as a standalone install does.
 */

export const YRD_REPOSITORY_ALIASES_ENV = "YRD_REPOSITORY_ALIASES" as const
export const YRD_REPOSITORY_ALIASES_SCHEMA = "yrd-repository-aliases/1" as const

export type YrdComposition = Readonly<{
  /** Declared paths resolve against this root; absent means the invocation directory. */
  root?: string
  aliases: readonly YrdRepositoryAlias[]
}>

export type YrdCompositionPlan =
  | Readonly<{ kind: "bypass"; args: string[] }>
  | Readonly<{ kind: "repository"; args: string[]; repository: Readonly<{ name: string; path: string }> }>
  | Readonly<{
      kind: "all-repositories"
      args: string[]
      repositories: readonly Readonly<{ name: string; path: string }>[]
    }>

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${YRD_REPOSITORY_ALIASES_ENV}${path} must be a non-empty string`)
  }
  return value
}

/**
 * Read one host's repository declarations and remove them from the environment.
 *
 * The declaration is consumed rather than copied because it is addressed to
 * THIS process: a queue step is an ordinary child process, and a step that
 * inherited the aliases would resolve `yrd queue code` against the composition
 * instead of the bay it is running in. `takeImplementationSourceAttestation`
 * consumes its own launcher attestation for the same reason.
 *
 * A declaration that is present and malformed refuses. Falling back to
 * standalone behavior would answer the operator's question about a DIFFERENT
 * repository — the composition's whole purpose is that `queue run code` is not
 * the same command as `queue run` in whatever directory the shell happened to
 * be in.
 */
export function takeYrdComposition(env: Record<string, string | undefined>): YrdComposition | undefined {
  const raw = env[YRD_REPOSITORY_ALIASES_ENV]
  delete env[YRD_REPOSITORY_ALIASES_ENV]
  if (raw === undefined || raw.trim() === "") return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new TypeError(`${YRD_REPOSITORY_ALIASES_ENV} must contain valid JSON`, { cause: error })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${YRD_REPOSITORY_ALIASES_ENV} must be an object`)
  }
  const envelope = value as Record<string, unknown>
  if (envelope["schema"] !== YRD_REPOSITORY_ALIASES_SCHEMA) {
    throw new TypeError(`${YRD_REPOSITORY_ALIASES_ENV}.schema must be ${JSON.stringify(YRD_REPOSITORY_ALIASES_SCHEMA)}`)
  }
  const rows = envelope["repositories"]
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TypeError(`${YRD_REPOSITORY_ALIASES_ENV}.repositories must be a non-empty array`)
  }
  const declared = new Set<string>()
  const aliases = rows.map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new TypeError(`${YRD_REPOSITORY_ALIASES_ENV}.repositories[${index}] must be an object`)
    }
    const record = row as Record<string, unknown>
    const name = text(record["name"], `.repositories[${index}].name`)
    if (declared.has(name)) throw new TypeError(`${YRD_REPOSITORY_ALIASES_ENV} declares repository '${name}' twice`)
    declared.add(name)
    return Object.freeze({
      repository: Object.freeze({ name, path: text(record["path"], `.repositories[${index}].path`) }),
      queue: Object.freeze({ base: text(record["base"], `.repositories[${index}].base`) }),
    })
  })
  return Object.freeze({
    ...(envelope["root"] === undefined ? {} : { root: text(envelope["root"], ".root") }),
    aliases: Object.freeze(aliases),
  })
}

export type YrdCompositionPlanOptions = Readonly<{
  env: Readonly<Record<string, string | undefined>>
  /** Invocation directory a declared relative path resolves against when the composition declares no root. */
  cwd?: string
  /** Seam for tests; production resolves a linked worktree to its primary. */
  authority?: (path: string) => string
}>

function helpOnly(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V")
}

/**
 * Where a declared repository actually lives.
 *
 * A declared path is relative to the composition, exactly like `--repo` is
 * relative to the invocation directory, and it is then resolved to the primary
 * worktree: a slot and the repository that created it share one journal, and
 * opening it through two paths is how the same delivery state grows two
 * answers.
 */
function declaredPath(composition: YrdComposition, options: YrdCompositionPlanOptions, path: string): string {
  const root = composition.root ?? options.cwd ?? process.cwd()
  return (options.authority ?? repositoryAuthority)(resolve(root, path))
}

/** Rewrite the one `--repo` value the normalizer emitted, which still carries
 * the declared spelling rather than the resolved authority. */
function withAuthority(args: readonly string[], authority: string): string[] {
  const rewritten = [...args]
  const index = rewritten.indexOf("--repo")
  if (index < 0 || rewritten[index + 1] === undefined) {
    throw new Error("yrd: normalized repository alias invocation omitted --repo")
  }
  rewritten[index + 1] = authority
  return rewritten
}

/**
 * Resolve one invocation against the declared composition.
 *
 * Three things travel straight through to the runtime: an explicit selector
 * (`--repo`, `YRD_REPO`), because the operator already answered the question
 * this resolves; help and version, because they describe the command rather
 * than run it; and anything that is not a queue spelling, because no other rail
 * has an all-repository projection.
 */
export function planYrdComposition(
  args: readonly string[],
  composition: YrdComposition,
  options: YrdCompositionPlanOptions,
): YrdCompositionPlan {
  if (
    helpOnly(args) ||
    args.some((argument) => argument.startsWith("--repo=")) ||
    Boolean(options.env["YRD_REPO"]?.trim())
  ) {
    return { kind: "bypass", args: [...args] }
  }
  const normalized: YrdRepositoryAliasInvocation = normalizeYrdRepositoryAliasInvocation(args, composition.aliases)
  if (normalized.kind === "bypass") return { kind: "bypass", args: normalized.args }
  if (normalized.kind === "all-repositories-watch") {
    // Bare `yrd watch` (item 35): one live watch over the CURRENT
    // repository's journal — the declared repository containing the
    // invocation directory, the first declaration when cwd is outside every
    // one (e.g. a linked worktree the declarations do not name). The watch
    // shows all of that repository's queues; the composition stays the
    // WRITER boundary and never constrains this read (item 37f).
    const cwd = options.cwd ?? process.cwd()
    const resolved = composition.aliases.map((alias) => ({
      alias,
      path: declaredPath(composition, options, alias.repository.path),
    }))
    const within = resolved.find(({ path }) => cwd === path || cwd.startsWith(`${path}/`))
    const chosen = within ?? resolved[0]
    if (chosen === undefined) {
      throw new Error(`yrd: ${YRD_REPOSITORY_ALIASES_ENV} declared no repositories to watch`)
    }
    const queueIndex = normalized.args.indexOf("queue")
    if (queueIndex < 0) throw new Error("yrd: normalized watch invocation lost its queue command")
    const composed = [
      ...normalized.args.slice(0, queueIndex),
      "--repo",
      chosen.path,
      ...normalized.args.slice(queueIndex),
    ]
    return {
      kind: "repository",
      repository: Object.freeze({ name: chosen.alias.repository.name, path: chosen.path }),
      args: composed,
    }
  }
  if (normalized.kind === "all-repositories-read") {
    return {
      kind: "all-repositories",
      args: normalized.args,
      repositories: composition.aliases.map(({ repository }) =>
        Object.freeze({ name: repository.name, path: declaredPath(composition, options, repository.path) }),
      ),
    }
  }
  const path = declaredPath(composition, options, normalized.repository.path)
  return {
    kind: "repository",
    repository: Object.freeze({ name: normalized.repository.name, path }),
    args: withAuthority(normalized.args, path),
  }
}

/** Rebuild one process argv around composed arguments, preserving the
 * executable prefix {@link resolveInvocation} strips — including Git's
 * two-token `git yrd` spelling. */
export function composeYrdArgv(argv: readonly string[], args: readonly string[]): string[] {
  const prefix = argv.length - resolveInvocation(argv).args.length
  return [...argv.slice(0, prefix), ...args]
}

/** The composition's own preamble for `queue --help`: the declared names, and
 * the two operand positions they can be typed in. Yrd's own help cannot
 * document repositories it does not declare. */
export function yrdCompositionQueueHelp(commandName: string, composition: YrdComposition): string {
  const repositories = composition.aliases.map(({ repository }) => repository.name)
  const example = repositories[0]
  return (
    `Composition repositories: ${repositories.join(", ")}\n` +
    `Reads: ${commandName} queue [${repositories.join("|")}]\n` +
    `Writes put the repository after the verb; for example: ${commandName} queue pause ${example} --reason "maintenance"\n\n`
  )
}
