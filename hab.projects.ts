// Mechanical queue runners — never ambient @chief (22728). State-write
// authority requires a verified managed-launch proof; each service is a
// non-chief actor with its own tribe name for attribution only. Supervision
// and installed multi-repository queue reads consume this registry so another
// queue cannot be declared on only one side of the liveness contract.

export type YrdQueueRunnerDeclaration = Readonly<{
  serviceName: string
  repository: Readonly<{ name: string; path: string }>
  queue: Readonly<{ base: string }>
  /**
   * The tribe seat Hab pages when this runner's restart budget exhausts —
   * `HabServiceDefinition.owner` in ag/packages/hab-config.
   *
   * Required, not optional, and that is the point. Under `restart: "never"` a
   * crashed runner stays exited and pages ONCE; an undeclared owner resolves to
   * the fleet-wide default, so "nobody chose" and "we chose the default" become
   * the same declaration. A runner nobody is named for is a runner that stays
   * down while its page arrives as news to a seat that cannot act on it.
   */
  owner: string
}>

function requiredText(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`Yrd queue runner ${label} requires text`)
  return value
}

export function defineYrdQueueRunnerDeclarations<const Rows extends readonly YrdQueueRunnerDeclaration[]>(
  rows: Rows,
): Rows {
  const services = new Set<string>()
  const repositories = new Set<string>()
  for (const row of rows) {
    requiredText(row.serviceName, "service name")
    requiredText(row.repository.name, "repository name")
    requiredText(row.repository.path, "repository path")
    requiredText(row.queue.base, "queue base")
    requiredText(row.owner, "owner")
    if (services.has(row.serviceName)) throw new Error(`duplicate service name '${row.serviceName}'`)
    if (repositories.has(row.repository.name)) {
      throw new Error(`duplicate repository name '${row.repository.name}'`)
    }
    services.add(row.serviceName)
    repositories.add(row.repository.name)
  }
  return Object.freeze(rows)
}

export const yrdQueueRunnerDeclarations = defineYrdQueueRunnerDeclarations([
  { serviceName: "yrd-service", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@cto" },
] as const)

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
        // The service relaunches itself on the ONE condition whose CURE is the
        // relaunch: a moved pin (18), read at the target after every round and
        // taken at a round boundary with nothing in flight — "the code moved
        // under me". `source-stale` (11) and the stale installed plan (13)
        // were the incumbent resident's self-supervision and went with it at
        // M6 along with `habitant-exit.ts`; the loop's other two exits are 2
        // (stuck: it stays down until the garage fixes the queue) and a signal.
        //
        // Was `restart: "never"` (andon ruling, operator 2026-09-01: a crashed
        // runner stays exited and pages once). Under that value the entire
        // exit taxonomy was INERT: 13 fired twice on 2026-09-02 alone, once at
        // 08:06 and once before 08:42, each time as a merge changed the step
        // definitions under a serving runner, and each time the queue stayed
        // down until a person ran `hab up`. The pin advances cost the same
        // ritual — stop the resident, advance the gitlink, start it again —
        // between 2m43s and ~40 minutes each, on the fleet's critical path.
        // Operator ruling 2026-09-02: "why isn't yrd fully automatic now? that
        // is critical path and should be driven hard."
        //
        // WHAT THIS COSTS, stated rather than discovered later. `on-failure`
        // restarts on EVERY non-zero exit, so it also restarts exit 2, a stuck
        // queue, into the same fault. Inhab's default budget bounds it — three
        // restarts per 600s with 1s→30s backoff, then `stop-budget` — so a
        // stuck queue still ends stopped and paged to `owner` below, three
        // attempts and at most ten minutes later than the andon ruling wants.
        //
        // The narrower policy that would hold those two exactly is hab-core's
        // `permanentExitCodes`, and it is NOT reachable from here today: it
        // lives on habd's runtime launch envelope
        // (ag/packages/hab-core/src/habd-runtime.ts) with no production writer,
        // and it is absent from `SERVICE_KEYS` in ag/packages/hab-config
        // (src/index.ts). Declaring it here does not degrade — `validateServiceKeys`
        // pushes `unknown key 'permanentExitCodes'` onto `diagnostics.errors`,
        // and `checkHabConfig` then returns no habplan at all, taking down
        // EVERY service in the composition rather than just this one. So it is
        // deliberately not declared. Restoring full andon fidelity means adding
        // the key to `SERVICE_KEYS`, threading it through `HabplanService` to
        // the launch envelope, and then declaring
        // `permanentExitCodes: [2]` here — a change in ag, not in Yrd (M7,
        // owned by dev/7 on 2026-09-03).
        restart: "on-failure" as const,
        // Wired 2026-09-01: `HabServiceDefinition.owner` (ag/packages/hab-config,
        // src/index.ts) now lists "owner" in `SERVICE_KEYS`, and a resident with
        // `restart: "never"` and no owner is a WARNING there, not the FATAL
        // config diagnostic it used to be. Spreading the registry row's owner
        // here is what makes the andon page reach @cto instead of falling back
        // to the fleet-wide @chief default.
        owner,
      },
    ]),
  ),
}
