// Mechanical queue runners — never ambient @chief (22728). State-write
// authority requires a verified managed-launch proof; each service is a
// non-chief actor with its own tribe name for attribution only. Supervision
// and installed multi-repository queue reads consume this registry so another
// queue cannot be declared on only one side of the liveness contract.

export type YrdQueueRunnerDeclaration = Readonly<{
  serviceName: string
  repository: Readonly<{ name: string; path: string }>
  queue: Readonly<{ base: string }>
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
  { serviceName: "yrd-runner", repository: { name: "code", path: "." }, queue: { base: "main" } },
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
      },
    ]),
  ),
}
