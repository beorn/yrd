/** Pure environment inventory format; importing it performs no runtime discovery. */
import type { EnvLifetime } from "./env-open-record.ts"

/** Association from the existing opening record; absence and read failure are not an unbound record. */
export type EnvIssueBinding =
  | Readonly<{ state: "recorded"; issue?: string; lifetime: EnvLifetime; expiresAt?: string }>
  | Readonly<{ state: "unrecorded"; why: string }>
  | Readonly<{ state: "unreadable"; why: string }>

/** One environment as git holds it: a worktree under the bays root. */
export type EnvRow = Readonly<{
  name: string
  path: string
  branch?: string
  head?: string
  hold: string | null
  issueBinding: EnvIssueBinding
}>

function isIssueBinding(value: unknown): value is EnvIssueBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const binding = value as Record<string, unknown>
  if (binding.state === "unrecorded" || binding.state === "unreadable") return typeof binding.why === "string"
  return (
    binding.state === "recorded" &&
    (binding.lifetime === "job" || binding.lifetime === "standing") &&
    (binding.issue === undefined || typeof binding.issue === "string") &&
    (binding.expiresAt === undefined || typeof binding.expiresAt === "string")
  )
}

/** The producer's transport boundary. A missing opening fact never supplies an automatic binding. */
export function parseEnvironmentList(text: string): EnvRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`its JSON cannot be read (${error instanceof Error ? error.message : String(error)})`)
  }
  const environments = (parsed as { environments?: unknown } | null)?.environments
  if (!Array.isArray(environments)) throw new Error("it carries no environments array")
  return environments.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`environment ${index} is not an object`)
    }
    const row = entry as Record<string, unknown>
    if (typeof row.name !== "string" || row.name === "" || typeof row.path !== "string" || row.path === "") {
      throw new Error(`environment ${index} carries no name or path`)
    }
    for (const key of ["head", "branch", "hold"] as const) {
      if (row[key] !== undefined && row[key] !== null && typeof row[key] !== "string") {
        throw new Error(`environment ${index}.${key} is not a string or null`)
      }
    }
    return {
      name: row.name,
      path: row.path,
      hold: typeof row.hold === "string" ? row.hold : null,
      ...(typeof row.head === "string" ? { head: row.head } : {}),
      ...(typeof row.branch === "string" ? { branch: row.branch } : {}),
      issueBinding: isIssueBinding(row.issueBinding)
        ? row.issueBinding
        : {
            state: "unreadable" as const,
            why: `environment ${index} opening issue binding is missing or malformed`,
          },
    }
  })
}
