/**
 * `yrd mirror refresh` — bring this host's mirror of every hosted repository
 * the current repository declares up to date (25570 row 1, slice 1; the store
 * and its layout are documented in @yrd/queue-core's mirror.ts).
 *
 * The store root is `git config yrd.mirror`, for the same reason the workdir
 * is `git config yrd.workdir` (workdir.ts): it is a path on THIS machine, which
 * the shared declaration cannot know. Unlike the workdir it has no default. A
 * store is shared by every queue and seat on the host, so one invented under a
 * repository's git dir would be a second store nobody else reads.
 */

import { configValue, gitIn, MIRROR_STORE_SETTING, refreshDeclaredMirrors } from "@yrd/queue-core"
import { relative } from "node:path"
import { repositoryHere } from "./declaration.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"


export { MIRROR_STORE_SETTING }

export type MirrorRefreshOptions = Readonly<{ commit?: string; json?: boolean }>

export async function refreshMirrors(options: MirrorRefreshOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const cwd = io.cwd ?? process.cwd()
  const repo = repositoryHere(cwd)
  if (repo === undefined) {
    io.stderr(
      `yrd mirror refresh: no Git clone contains ${cwd}; run it inside the repository whose submodules to mirror\n`,
    )
    return 1
  }
  const store = await configValue(gitIn(repo), MIRROR_STORE_SETTING)
  if (store === undefined) {
    io.stderr(
      `yrd mirror refresh: this host declares no mirror store (${MIRROR_STORE_SETTING} is unset in ${repo}); ` +
        `set it once for the host with git config --global ${MIRROR_STORE_SETTING} <directory>\n`,
    )
    return 1
  }
  let result: Awaited<ReturnType<typeof refreshDeclaredMirrors>>
  try {
    result = await refreshDeclaredMirrors({
      root: store,
      repo,
      commits: [options.commit ?? "HEAD"],
      gitIn: (directory) => gitIn(directory),
    })
  } catch (error) {
    io.stderr(`yrd mirror refresh: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (options.json === true) {
    io.stdout(
      `${JSON.stringify({
        store,
        refreshed: result.refreshed.map((mirror) => ({ ...mirror, refreshedAt: mirror.refreshedAt.toISOString() })),
        skipped: result.skipped,
      })}\n`,
    )
    return 0
  }
  for (const mirror of result.refreshed) {
    io.stdout(
      `${mirror.outcome} ${relative(store, mirror.path)} ${String(mirror.bytes)} bytes ${String(mirror.ms)}ms\n`,
    )
  }
  for (const skip of result.skipped) io.stdout(`skipped ${skip.path} (${skip.url}): ${skip.reason}\n`)
  return 0
}
