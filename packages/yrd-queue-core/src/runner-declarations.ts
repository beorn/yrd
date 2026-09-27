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
