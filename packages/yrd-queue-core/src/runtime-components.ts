/**
 * THE ROOT GITLINK PATHS THE YRD RUNTIME LOADS IN PROCESS (27886, @cto ruling
 * 3(a), 2026-10-07). A PURE constant module: no imports, no git, no filesystem.
 *
 * Why it exists. Yrd's relaunch exit (26755) and its bounded wait watched ONE
 * gitlink — the path this runtime occupies (`runtime-gitlink.ts`). A promotion
 * that moved only a DEPENDENCY (say `vendor/bearly`) left that path untouched,
 * so the exit never armed, the loop ran on code whose dependency had already
 * moved under it, and hab's source check read the landing `fresh` because the
 * entrypoint file had not changed either. A dependency-only landing was
 * invisible to both observers.
 *
 * The vector is the fix: the loop reads the pin of EVERY path here at module
 * load from the superproject it runs from, and exits when the captured target
 * records a different pin for ANY of them (queue-core-commands.ts `reload`).
 *
 * The list is enumerated BY MEASUREMENT, never by intent — a `Bun.build`
 * metafile over `bin/yrd.ts` resolves every module the runtime loads, and each
 * vendor root it reaches is one of these. `runtime-components.test.ts` re-runs
 * that measurement, so an import from a vendor root that is missing here fails
 * the suite instead of silently going unwatched.
 *
 * The runtime's OWN path is first, and is also the path `runtimeGitlinkPath`
 * derives at load. Listing it here is what lets hab's source check watch a
 * `vendor/yrd` move that the entrypoint file's own history cannot see.
 */

/** The path this runtime occupies in the hh superproject: its own gitlink. */
export const YRD_RUNTIME_OWN_COMPONENT = "vendor/yrd"

/**
 * Every root gitlink path the yrd runtime loads in process, own path first.
 *
 * Measured 2026-10-07 from `bin/yrd.ts` (bun-closure metafile): vendor/yrd's own
 * imports reach bearly (`@bearly/flock`, `@bearly/durable-file`), git-super,
 * gitomic, loggily; silvery reaches flexily and termless. npm packages (react,
 * commander, zod) are hoisted install-scope, not gitlinks, and are not listed.
 */
export const YRD_RUNTIME_COMPONENTS = [
  YRD_RUNTIME_OWN_COMPONENT,
  "vendor/bearly",
  "vendor/flexily",
  "vendor/git-super",
  "vendor/gitomic",
  "vendor/loggily",
  "vendor/silvery",
  "vendor/termless",
] as const
