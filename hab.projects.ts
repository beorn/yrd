// Mechanical queue runners — never ambient @chief (22728). State-write
// authority requires a verified managed-launch proof; each service is a
// non-chief actor with its own tribe name for attribution only. Supervision
// and installed multi-repository queue reads consume this registry so another
// queue cannot be declared on only one side of the liveness contract.

export type YrdQueueRunnerDeclaration = Readonly<{
  serviceName: string
  repository: Readonly<{ name: string; path: string }>
  queue: Readonly<{ base: string }>
  /**
   * The tribe seat Hab pages when this runner's restart budget exhausts —
   * `HabServiceDefinition.owner` in ag/packages/hab-config.
   *
   * Required, not optional, and that is the point. Under `restart: "never"` a
   * crashed runner stays exited and pages ONCE; an undeclared owner resolves to
   * the fleet-wide default, so "nobody chose" and "we chose the default" become
   * the same declaration. A runner nobody is named for is a runner that stays
   * down while its page arrives as news to a seat that cannot act on it.
   */
  owner: string
}>

function requiredText(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`Yrd queue runner ${label} requires text`)
  return value
}

export function defineYrdQueueRunnerDeclarations<const Rows extends readonly YrdQueueRunnerDeclaration[]>(
  rows: Rows,
): Rows {
  const services = new Set<string>()
  const repositories = new Set<string>()
  for (const row of rows) {
    requiredText(row.serviceName, "service name")
    requiredText(row.repository.name, "repository name")
    requiredText(row.repository.path, "repository path")
    requiredText(row.queue.base, "queue base")
    requiredText(row.owner, "owner")
    if (services.has(row.serviceName)) throw new Error(`duplicate service name '${row.serviceName}'`)
    if (repositories.has(row.repository.name)) {
      throw new Error(`duplicate repository name '${row.repository.name}'`)
    }
    services.add(row.serviceName)
    repositories.add(row.repository.name)
  }
  return Object.freeze(rows)
}

export const yrdQueueRunnerDeclarations = defineYrdQueueRunnerDeclarations([
  { serviceName: "yrd-runner", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@cto" },
] as const)

/**
 * The same declarations, in the form the CLI reads them.
 *
 * `yrd queue <repository>` is a composition spelling: Yrd resolves it only when
 * a host says which repositories exist. Passing the declarations to the service
 * makes this registry the ONE source — a launcher that carried its own copy is
 * how a repository ends up declared on only one side of the contract. No root
 * is declared, so the paths stay relative to the service's own directory,
 * exactly as they are here.
 */
export const YRD_REPOSITORY_ALIASES = JSON.stringify({
  schema: "yrd-repository-aliases/1",
  repositories: yrdQueueRunnerDeclarations.map(({ repository, queue }) => ({
    name: repository.name,
    path: repository.path,
    base: queue.base,
  })),
})

export default {
  name: "yrd",
  services: Object.fromEntries(
    yrdQueueRunnerDeclarations.map(({ serviceName, repository }) => [
      serviceName,
      {
        command: `bun tools/yrd-runtime.mjs yrd queue run ${repository.name}`,
        // The habitant stands down over this RSS (exit 12, memory-cap) instead of
        // waiting for the kernel; @cto ruling 2026-08-30 on
        // @i/10-yrd/runner-exits-and-respawns — 12 GiB, one habitant per host.
        env: { TRIBE_NAME: "@yrd", YRD_REPOSITORY_ALIASES, YRD_HABITANT_RSS_CAP_MB: "12288" },
        health: { command: `bun tools/yrd-runtime.mjs yrd queue ${repository.name} --check --json` },
        // Andon policy (operator ruling 2026-09-01): a crashed runner stays
        // exited and pages once; every restart is a deliberate operator/CTO
        // act, never supervision. hab-config validates the value.
        restart: "never" as const,
        // NO `owner` KEY HERE YET, and the omission is deliberate. The seat
        // that page is FOR is declared above, on the registry row; what is
        // missing is the wire, not the decision.
        //
        // `HabServiceDefinition.owner` exists in ag/packages/hab-config and is
        // read through habplan lowering, the launch envelope and the page rail,
        // where a declared owner wins and a blank one falls back to @chief. But
        // `SERVICE_KEYS` in that same file does not list "owner", and any key
        // outside that allowlist is a FATAL config diagnostic rather than an
        // ignored one — the fail-loud guard that closed the silent-typo gap.
        // So spreading `owner` in today would not route the page; it would stop
        // yrd-runner from loading at all, and under `restart: "never"` that is
        // the merge queue down behind a config error.
        //
        // Unblock, in this order: add "owner" to SERVICE_KEYS in
        // ag/packages/hab-config, then `owner,` here, then delete the pin in
        // tests/hab-projects.ts that asserts this absence.
      },
    ]),
  ),
}
