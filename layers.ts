/**
 * yrd's layer map: which yrd packages may import which.
 *
 * Read the strata bottom first. A package imports only packages in strata
 * beneath its own. Packages that share a stratum do not import each other
 * unless `allowedEdges` names the edge. The root package, ".", is git-yrd, the
 * distribution: its bins, hab.projects.ts, scripts and root tests compose the
 * packages beneath it, so it sits alone in the top stratum.
 * `bun run lint:deps:yrd` enforces this map through km's
 * packages/km-infra/depcruise/config.cjs, which reads it through the one
 * loader, packages/km-infra/depcruise/layers-loader.cjs.
 *
 * The cruise reads every directory, tests and scripts included, so
 * `skippedFiles` is empty.
 *
 * Pure data with no imports at all: yrd must work when cloned standalone, where
 * km's `LayerMap` type does not exist, so the loader's validation is this map's
 * only schema check. A new yrd package must be placed here or excluded with its
 * reason; the loader refuses the run until it is.
 */
export default {
  strata: [
    {
      name: "process",
      doc: "Process and Git execution: spawning with timeouts and output capture, failure records, the Git environment and git-super adapter, and path-holder censuses (@yrd/process). The bottom stratum imports no other yrd package.",
      packages: ["packages/yrd-process"],
    },
    {
      name: "bay-and-queue-core",
      doc: "Bays, the git worktree environment for one branch (@yrd/bay), beside the queue's core, whose one store is the git repository: submissions, runs, refs, pauses and records (@yrd/queue-core). Neither imports the other.",
      packages: ["packages/yrd-bay", "packages/yrd-queue-core"],
    },
    {
      name: "cli",
      doc: "The yrd command line: queue and environment commands, addresses, health, stats and the watch view (@yrd/cli).",
      packages: ["packages/yrd-cli"],
    },
    {
      name: "distribution",
      doc: "The root package, git-yrd: the git-yrd and yrd bins, hab.projects.ts, the vitest configs, the build and typecheck scripts, and the root tests, among them the boundary tests that run the queue through its CLI. It sits alone at the top: its bins and tests import the packages beneath it.",
      packages: ["."],
    },
  ],
  excluded: [],
  allowedEdges: [
    {
      from: "packages/yrd-cli",
      to: ".",
      fromFiles: ["packages/yrd-cli/src/version.ts"],
      reason:
        "The git-yrd manifest is the one home of the distribution's name and version: the CLI reads both through version.ts and never carries a second literal, and the production bundle embeds the manifest. Every other yrd-cli file stays forbidden from importing the root package.",
      decided: "yrd 8f9afb40d7",
    },
  ],
  skippedFiles: [],
}
