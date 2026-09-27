import { createEventQueue, createEventStore, gitIn, readConfig } from "@yrd/queue-core"

/**
 * Declare a fixture's queue the way a live habitat has one since 25041: a queue
 * IS its event ref, and submit, withdraw and every queue command refuse a target
 * without one ("uses a legacy Record ref"). The created event pins the target's
 * current declaration commit, so call this after the fixture's last push of
 * `.yrd.yml` to the target.
 */
export async function declareEventQueue(
  work: string,
  options: Readonly<{ remote?: string; queue?: string; at?: Date }> = {},
): Promise<string> {
  const remote = options.remote ?? "origin"
  const queue = options.queue ?? "main"
  const git = gitIn(work)
  await git(["fetch", "--quiet", remote, queue])
  const commit = (await git(["rev-parse", "FETCH_HEAD"])).trim()
  const config = await readConfig(git, commit, { branch: queue, remote })
  if (config === undefined) throw new Error(`fixture ${remote}#${queue} at ${commit} declares no .yrd.yml`)
  return createEventQueue(createEventStore(work, remote, git.selection), queue, commit, config, options.at ?? new Date())
}
