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
  { serviceName: "yrd-runner-pm", repository: { name: "pm", path: "pm" }, queue: { base: "main" } },
] as const)

export default {
  name: "yrd",
  services: Object.fromEntries(
    yrdQueueRunnerDeclarations.map(({ serviceName, repository }) => [
      serviceName,
      {
        command: `tools/installed/yrd queue run ${repository.name}`,
        env: { TRIBE_NAME: "@yrd" },
        health: { command: `tools/installed/yrd queue ${repository.name} --check --json` },
      },
    ]),
  ),
}
