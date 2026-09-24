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
  // OWNER, changed 2026-09-16 by the andon design (@cto, approved by the
  // operator). Item 5 of @i/10-yrd/24395 made this declaration bite: it decides
  // who is woken. A stuck change now STOPS THE LINE, and the page stays open
  // until an act lifts the stop — withdraw the change, merge its fix, or resume
  // the repaired queue. Deciding which is a stop-line call, and @chief owns the
  // stop-line; it was @ci while a stuck round retried itself on a ladder and the
  // page cleared on its own.
  { serviceName: "yrd", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@chief" },
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
        env: { TRIBE_NAME: "yrd", YRD_HABITANT_RSS_CAP_MB: "24576" },
        // The declared health probe (2026-09-11). M7 rejected a probe on
        // 2026-09-03 as noise with a SECOND OPINION, and that objection is
        // answered rather than overruled: `queue health` re-derives nothing.
        // It reads the document the loop itself last wrote — as it started, at
        // a round's end, or on the heartbeat that restates it between — so
        // there is exactly one opinion and it is the loop's. No network, no
        // declaration read, no process census, no judgement of the queue.
        //
        // This is where the stuck ALARM lives. A stuck change stops the line —
        // the queue pauses itself naming it — and the service stays up holding
        // the stop, so the supervisor pages on unhealthy-while-running WITHOUT
        // restarting. The page clears when an act lifts the stop (the change
        // withdrawn or merged, or `yrd queue resume`), never by itself.
        health: { command: "bun tools/yrd-runtime.mjs yrd queue health" },
        // The loop relaunches only after an ending it chose: 0 for a clean
        // round/gitlink recycle, or 1 for a candidate failure. Exit 2 is
        // reserved for what the loop cannot hold a line on — a declaration that
        // is absent or unreadable, a runtime gitlink that is absent, a round
        // that could not read its queue at all — so it stays off the allowlist
        // and still pages non-relaunchable.
        // Signal decision: any signal observed by Hab is an unplanned host-level
        // interruption, so it stays down and pages the declared owner with every
        // unlisted code.
        restart: "on-codes" as const,
        relaunchExitCodes: [0, 1],
        // `HabServiceDefinition.owner` is a recognized service key in
        // ag/packages/hab-config. Spreading the registry row's owner here makes
        // every page of this service — the stopped line's and a terminal
        // ending's — reach the declared owner, named rather than left to the
        // fleet-wide default.
        owner,
      },
    ]),
  ),
}
