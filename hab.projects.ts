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
    yrdQueueRunnerDeclarations.map(({ serviceName, repository, owner }) => [
      serviceName,
      {
        command: `bun tools/yrd-runtime.mjs yrd queue run ${repository.name}`,
        // The habitant stands down over this RSS (exit 12, memory-cap) instead of
        // waiting for the kernel; @cto ruling 2026-08-30 on
        // @i/10-yrd/runner-exits-and-respawns — one habitant per host. Raised
        // 12 → 24 GiB on 2026-09-01 (@cto): the resident's measured working set
        // while running admissions on a 527 MB journal is 6-10 GB (sampled every
        // minute for 30 min, peak 9.96 GB), and it stood down at 16.5 GB at
        // 12:58 PDT with restart:"never" — a cap below the working set is an
        // outage generator, not a guard. The host has 121 GB; the growth itself
        // is tracked as its own defect. This number is a ceiling for runaway.
        env: { TRIBE_NAME: "@yrd", YRD_REPOSITORY_ALIASES, YRD_HABITANT_RSS_CAP_MB: "24576" },
        health: { command: `bun tools/yrd-runtime.mjs yrd queue ${repository.name} --check --json` },
        // Andon policy (operator ruling 2026-09-01): a crashed runner stays
        // exited and pages once; every restart is a deliberate operator/CTO
        // act, never supervision. hab-config validates the value.
        restart: "never" as const,
        // Wired 2026-09-01: `HabServiceDefinition.owner` (ag/packages/hab-config,
        // src/index.ts) now lists "owner" in `SERVICE_KEYS`, and a resident with
        // `restart: "never"` and no owner is a WARNING there, not the FATAL
        // config diagnostic it used to be. Spreading the registry row's owner
        // here is what makes the andon page reach @cto instead of falling back
        // to the fleet-wide @chief default.
        owner,
      },
    ]),
  ),
}
