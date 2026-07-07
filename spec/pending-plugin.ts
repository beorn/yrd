import type { PluginFactory } from "mdspec/types"

/**
 * pending plugin — marks spec/happy-path.md as EXPECTED-PENDING.
 *
 * git bay's CLI (bin/git-bay.ts) is a P0 stub; none of the `git bay ...`
 * verbs exist yet. Running this doc under the default bash plugin would
 * fail every block for a reason that isn't a regression — it's the M1
 * build plan not being done yet. This plugin's block() always returns
 * null ("not handled"), which mdspec drops from its "N block(s), M failed"
 * tally, so `bun run spec` reports 0/0 and stays green while M1 lands.
 *
 * Remove the `mdspec: plugin: ./pending-plugin.ts` frontmatter from
 * spec/happy-path.md once `git bay init/co/status/audit` are real — the
 * doc reverts to the default bash plugin and starts asserting for real.
 */
const pending: PluginFactory = () => ({
  block: () => null,
})

export default pending
