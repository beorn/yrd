/** Birth a real event queue for CLI fixtures whose subject is format neutral. */
import { appendOpsCutover, createEventQueue, createEventStore, gitIn, readConfig } from "@yrd/queue-core"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { workdirOf } from "../../src/workdir.ts"

export async function birthEventQueue(
  repo: string,
  branch = "main",
  options: Readonly<{ localStore?: boolean }> = {},
): Promise<void> {
  const git = gitIn(repo)
  const target = (await git(["rev-parse", `refs/heads/${branch}`])).trim()
  const config = await readConfig(git, target, { branch, remote: "origin" })
  if (config === undefined) throw new Error(`event fixture ${repo} has no .yrd.yml on ${branch}`)
  const store = createEventStore(repo, "origin", git.selection)
  await createEventQueue(store, branch, target, config, new Date())
  await appendOpsCutover(store, git, branch, target, new Date(), "yrd-cli-fixture")
  if (options.localStore === false) return
  await git(["config", "yrd.workdir", join(dirname(repo), "queue")])
  const workdir = await workdirOf(git, { cwd: repo })
  mkdirSync(workdir, { recursive: true })
  const remote = (await git(["config", "--get", "remote.origin.url"])).trim()
  await gitIn(workdir)(["clone", "--quiet", "--no-checkout", remote, join(workdir, "repo")])
}
