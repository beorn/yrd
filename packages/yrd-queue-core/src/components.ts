/**
 * The protected facts a component contributes to a product landing.
 *
 * Policy is read only from a captured protected main, never from an authored
 * pin or a tracking ref another reader can move. The caller selects the URL.
 */

import { readConfig, type Landing } from "./config.ts"
import type { Git } from "./records.ts"
import type { Process } from "@yrd/process"
import { isAbsolute } from "node:path"
import { fetchCapturedObjects, gitSuperExecution, remoteRef } from "./git.ts"

type PreparedComponent = Readonly<{ name: string; path: string; gitlink: string; url: string; gitdir: string }>

/** Git Super owns discovery and storage. This adapter only validates its
 * command result; it never constructs a store path or reads policy there. */
export async function prepareComponents(
  repo: string,
  commit: string,
  remote: string,
  process: Process,
): Promise<readonly PreparedComponent[]> {
  const execution = await gitSuperExecution(
    repo,
    ["--repo", repo, "submodule", "prepare", commit, "--remote", remote],
    { process },
  )
  const fail = (reason: string): never => {
    throw new Error(
      `component stores for ${repo} at ${commit}: git super submodule prepare exited ${execution.exitCode}: ${reason}\nstdout: ${execution.stdout}\nstderr: ${execution.stderr}`,
      { cause: execution },
    )
  }
  if (execution.exitCode !== 0) fail("the command failed; resolve its reported repository condition before retrying")
  let value: unknown
  try {
    value = JSON.parse(execution.stdout)
  } catch {
    return fail("expected one complete JSON result")
  }
  if (typeof value !== "object" || value === null) return fail("the JSON result is not an object")
  const result = value as Record<string, unknown>
  if (
    (result.state !== "updated" && result.state !== "unchanged") ||
    result.partial !== false ||
    !Array.isArray(result.repositories) ||
    !Array.isArray(result.components)
  ) {
    return fail("the JSON result does not describe complete component preparation")
  }
  const components: PreparedComponent[] = []
  for (const [index, value] of result.components.entries()) {
    if (typeof value !== "object" || value === null) return fail(`component ${index} is not an object`)
    const row = value as Record<string, unknown>
    if (
      typeof row.name !== "string" ||
      row.name === "" ||
      typeof row.path !== "string" ||
      row.path === "" ||
      typeof row.gitlink !== "string" ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(row.gitlink) ||
      typeof row.url !== "string" ||
      row.url === "" ||
      typeof row.gitdir !== "string" ||
      !isAbsolute(row.gitdir)
    ) {
      return fail(`component ${index} has no complete name, path, gitlink, URL and absolute Git directory`)
    }
    components.push({ name: row.name, path: row.path, gitlink: row.gitlink, url: row.url, gitdir: row.gitdir })
  }
  return components
}

export type ComponentTarget = Readonly<{
  repository: string
  remote: string
  target: string
  blob: string
  landing: Landing
}>

/** Observe and read one protected main through an independently bound Git repository. */
export async function readComponentTarget(git: Git, repository: string, remote: string): Promise<ComponentTarget> {
  const target = await remoteRef(git, remote, "refs/heads/main", true)
  if (target === undefined) throw new Error(`${repository} at ${remote} returned no required protected main`)
  await fetchCapturedObjects(git, remote, [target])
  const config = await readConfig(git, target, { remote, branch: "main" })
  if (config?.landing === undefined) {
    throw new Error(
      `${repository} .yrd.yml at protected main ${target} must declare landing: product or external before the queue can judge it`,
    )
  }
  return { blob: config.blob, landing: config.landing, remote, repository, target }
}
