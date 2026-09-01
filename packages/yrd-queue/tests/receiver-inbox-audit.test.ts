/**
 * @failure A push git accepted whose intake never completed is invisible to `queue audit`.
 * @level l2
 * @consumer @yrd/queue queue audit
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { censusReceiverInbox, receiverInboxFindings, RECEIVER_INTAKE_GRACE_MS } from "../src/receiver-inbox-audit.ts"

const roots: string[] = []
const NOW = Date.parse("2026-08-31T12:00:00.000Z")

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function inbox(entries: ReadonlyArray<readonly [string, string]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-inbox-audit-"))
  roots.push(root)
  for (const [name, body] of entries) await writeFile(join(root, name), body)
  return root
}

function result(branch: string, ageMs: number): string {
  return JSON.stringify({ branch, receivedAt: new Date(NOW - ageMs).toISOString(), headSha: "a".repeat(40) })
}

describe("receiver inbox census", () => {
  it("says an absent inbox is absent rather than empty", async () => {
    const census = await censusReceiverInbox(join(tmpdir(), "yrd-inbox-audit-does-not-exist"), NOW)
    expect(census).toMatchObject({ present: false, scanned: 0, stranded: [], inFlight: [] })
    expect(receiverInboxFindings(census)).toEqual([])
  })

  it("leaves a result inside the grace window alone and names one past it", async () => {
    const dir = await inbox([
      ["young.pending.json", result("issue/young", 1_000)],
      ["old.pending.json", result("issue/old", RECEIVER_INTAKE_GRACE_MS + 60_000)],
      ["stuck.prepared.json", result("issue/stuck", RECEIVER_INTAKE_GRACE_MS + 5_000)],
      ["not-a-result.txt", "ignored"],
    ])
    const census = await censusReceiverInbox(dir, NOW)

    expect(census.scanned).toBe(3)
    expect(census.inFlight.map((entry) => entry.branch)).toEqual(["issue/young"])
    expect(census.stranded.map((entry) => entry.branch).toSorted()).toEqual(["issue/old", "issue/stuck"])

    const [finding, ...rest] = receiverInboxFindings(census)
    expect(rest).toEqual([])
    expect(finding?.code).toBe("receiver-intake-stranded")
    expect(finding?.specimen).toBe(dir)
    expect(finding?.message).toContain("2 of 3")
    expect(finding?.message).toContain("issue/old")
    // The audit's own clock decides the age, never the file's mtime — the files
    // above were all written in the same millisecond and still classify apart.
    expect(finding?.message).toMatch(/oldest 660s/u)
  })

  it("counts an unreadable or unstamped result as stranded and names the file", async () => {
    const dir = await inbox([
      ["corrupt.pending.json", "{ not json"],
      ["unstamped.pending.json", JSON.stringify({ branch: "issue/no-stamp" })],
    ])
    const census = await censusReceiverInbox(dir, NOW)

    // "We cannot tell how old it is" must never resolve to "it is probably fine".
    expect(census.stranded).toHaveLength(2)
    expect(census.inFlight).toEqual([])
    expect(census.unreadable).toEqual(["corrupt.pending.json"])
    expect(receiverInboxFindings(census)[0]?.message).toContain("corrupt.pending.json")
  })
})
