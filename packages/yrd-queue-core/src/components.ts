/**
 * The protected facts a component contributes to a product landing.
 *
 * Policy is read only from the component's fetched `origin/main`, never from
 * an authored pin. A materialized component must therefore carry `origin`;
 * missing remote/configuration is an authority failure, never a fallback.
 */

import { readConfig, type Landing } from "./config.ts"
import type { Git } from "./records.ts"

export type ComponentTarget = Readonly<{
  repository: string
  remote: string
  target: string
  blob: string
  landing: Landing
}>

/** Fetch and read one component's protected main policy through its bound Git checkout. */
export async function readComponentTarget(git: Git, repository: string): Promise<ComponentTarget> {
  const remote = (await git(["remote", "get-url", "origin"])).trim()
  if (remote === "") throw new Error(`${repository} origin remote has no URL`)
  await git(["fetch", "--quiet", "--no-tags", remote, "+refs/heads/main:refs/remotes/origin/main"])
  const target = (await git(["rev-parse", "refs/remotes/origin/main^{commit}"])).trim()
  if (target === "") throw new Error(`${repository} origin/main has no commit`)
  const config = await readConfig(git, target, { remote, branch: "main" })
  if (config?.landing === undefined) {
    throw new Error(
      `${repository} .yrd.yml at protected main ${target} must declare landing: product or external before the queue can judge it`,
    )
  }
  return { blob: config.blob, landing: config.landing, remote, repository, target }
}
