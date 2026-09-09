// The one mechanical queue runner — never ambient @chief (22728). State-write
// authority requires a verified managed-launch proof; the service is a
// non-chief actor with its own tribe name for attribution only. The
// superproject's fleet scan and Hab composition both read the row below, so it
// stays a named export rather than being inlined into the service entry.

export type YrdQueueRunnerDeclaration = Readonly<{
  serviceName: string
  repository: Readonly<{ name: string; path: string }>
  queue: Readonly<{ base: string }>
  /**
   * The tribe seat Hab pages when this runner reaches a terminal ending —
   * `HabServiceDefinition.owner` in ag/packages/hab-config.
   *
   * Required, not optional, and that is the point. Under `restart: "on-codes"`
   * a signal or unlisted exit stays down and pages ONCE; an undeclared owner
   * resolves to the fleet-wide default, so "nobody chose" and "we chose the default" become
   * the same declaration. A runner nobody is named for is a runner that stays
   * down while its page arrives as news to a seat that cannot act on it.
   */
  owner: string
}>

export const yrdQueueRunnerDeclarations: readonly YrdQueueRunnerDeclaration[] = Object.freeze([
  { serviceName: "yrd-service", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@ci" },
])

export default {
  name: "yrd",
  services: Object.fromEntries(
    yrdQueueRunnerDeclarations.map(({ serviceName, owner }) => [
      serviceName,
      {
        // The service is `yrd queue up`: the same round `yrd queue run` does, on
        // a loop (plan § Commands). `queue run` is one round and exits.
        //
        // NO REPOSITORY OPERAND. `yrd queue up <repository>` was a composition
        // spelling resolved from a `YRD_REPOSITORY_ALIASES` env this registry
        // also minted; both went with the old core at M6, and the new commands
        // take no repository argument — the declaration where the command
        // stands IS the repository, and the service stands in it
        // (`repository.path`).
        command: "bun tools/yrd-runtime.mjs yrd queue up --interval 120",
        // The habitant stands down over this RSS (exit 12, memory-cap) instead of
        // waiting for the kernel; @cto ruling 2026-08-30 on
        // @i/10-yrd/runner-exits-and-respawns — one habitant per host. Raised
        // 12 → 24 GiB on 2026-09-01 (@cto): the resident's measured working set
        // while running admissions on a 527 MB journal is 6-10 GB (sampled every
        // minute for 30 min, peak 9.96 GB), and it stood down at 16.5 GB at
        // 12:58 PDT with restart:"never" — a cap below the working set is an
        // outage generator, not a guard. The host has 121 GB; the growth itself
        // is tracked as its own defect. This number is a ceiling for runaway.
        // The service's tribe name is its own key, never `@yrd`: that seat is
        // retired (2026-08-31) and a service must not resurrect it.
        env: { TRIBE_NAME: "@yrd-service", YRD_HABITANT_RSS_CAP_MB: "24576" },
        // No health probe (M7, 2026-09-03): the loop's own process is its
        // liveness, its journal shows a running check, and a probe shelling
        // the CLI every tick was noise with a second opinion.
        // The loop relaunches only after an ending it chose: 0 for a clean
        // round/gitlink recycle, or 1 for a candidate failure. Exit 2 is stuck.
        // Signal decision: any signal observed by Hab is an unplanned host-level
        // interruption, so it stays down and pages @ci with every unlisted code.
        restart: "on-codes" as const,
        relaunchExitCodes: [0, 1],
        // `HabServiceDefinition.owner` is a recognized service key in
        // ag/packages/hab-config. Spreading the registry row's owner here makes
        // a terminal-ending andon page reach @ci instead of falling back to the
        // fleet-wide @chief default.
        owner,
      },
    ]),
  ),
}
