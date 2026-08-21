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
        env: { TRIBE_NAME: "@yrd", YRD_REPOSITORY_ALIASES },
        health: { command: `bun tools/yrd-runtime.mjs yrd queue ${repository.name} --check --json` },
      },
    ]),
  ),
}
