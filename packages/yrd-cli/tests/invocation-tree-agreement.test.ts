/**
 * @failure A queue subcommand is registered in the command tree but missing
 *          from invocation.ts's QUEUE_SUBCOMMANDS, so the router splices
 *          `list` in front of it and the command silently never runs.
 * @level   l1
 * @consumer @yrd/core/22716-yrd-hardening-program/p2-push-is-submit
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const src = join(import.meta.dirname, "..", "src")

/**
 * Registrations read out of the source rather than by building the program.
 * invocation.ts canonicalizes argv BEFORE any command tree exists — that is the
 * whole reason the second list is there — so there is no live object to diff
 * against. Scanning the source is crude and it is still mechanical, which is
 * the property that matters: the two lists cannot drift without turning a test
 * red.
 */
function registeredQueueSubcommands(): ReadonlySet<string> {
  const run = readFileSync(join(src, "run.ts"), "utf8")
  // Bound to the RECEIVER, not to a region. A region needs an end anchor, and
  // the first version's end anchor never matched — the source writes
  // `const pr = program\n    .command("mr")`, so the literal `program.command("`
  // does not appear and the region ran past the queue block. It then reported
  // `mr` and two others as unrouted queue subcommands, which would have been
  // three fabricated bugs in a report.
  const names = new Set<string>()
  for (const match of run.matchAll(/\n {2}queue\n {4}\.command\("(_?[a-z][a-z-]*)/gu)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return names
}

function declaredQueueSubcommands(): ReadonlySet<string> {
  const invocation = readFileSync(join(src, "invocation.ts"), "utf8")
  const match = /const QUEUE_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\)/u.exec(invocation)
  expect(match, "QUEUE_SUBCOMMANDS moved or changed shape").not.toBeNull()
  return new Set([...(match?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map((entry) => entry[1] ?? ""))
}

describe("queue subcommand registration agrees with the invocation router", () => {
  it("finds the registrations it is supposed to compare", () => {
    // The scan is the instrument, so prove the instrument works before trusting
    // a comparison it makes. An empty or tiny set would make the real assertion
    // below pass vacuously — the silent-zero every source-scanning test risks.
    const registered = registeredQueueSubcommands()
    expect(registered.size).toBeGreaterThan(5)
    expect(registered).toContain("audit")
    expect(registered).toContain("uncarried")
  })

  it("routes every registered subcommand instead of splicing list in front of it", () => {
    const registered = registeredQueueSubcommands()
    const declared = declaredQueueSubcommands()
    const unrouted = [...registered].filter((name) => !declared.has(name)).toSorted()
    // A missing name does not error at runtime — `queue <name>` becomes
    // `queue list <name>`, prints the timeline, and exits 0. The command is in
    // --help and simply does something else. This is the only place that fails.
    expect(unrouted, "registered under `queue` but missing from QUEUE_SUBCOMMANDS").toEqual([])
  })
})
