// Mechanical queue runners — never ambient @chief (22728). State-write
// authority requires a verified managed-launch proof; each service is a
// non-chief actor with its own tribe name for attribution only. Supervision
// and WATCH consume this one repository registry so another queue cannot be
// declared on only one side of the liveness contract.
export const yrdQueueRunnerDeclarations = [
  { name: "yrd-runner", repository: "." },
  { name: "yrd-runner-pm", repository: "pm" },
] as const

function shellRepositoryPath(repository: string): string {
  return repository === "." ? "$PWD" : `$PWD/${repository}`
}

export default {
  name: "yrd",
  services: Object.fromEntries(
    yrdQueueRunnerDeclarations.map(({ name, repository }) => {
      const path = shellRepositoryPath(repository)
      return [
        name,
        {
          command: `YRD_REPO="${path}" tools/installed/yrd queue run --follow`,
          env: { TRIBE_NAME: "@yrd" },
          health: { command: `tools/installed/yrd --repo "${path}" queue list --check --json` },
        },
      ]
    }),
  ),
}
