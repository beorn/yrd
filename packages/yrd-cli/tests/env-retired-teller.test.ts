/**
 * @failure 29720 gate rows (@cto REVISE 0773295f B1-B3): the env-retired
 *   teller must tell only a merged change, name every skip, take the
 *   no-chain case from an undefined change rather than matched message
 *   text, and — before any chain read — do nothing but print the named
 *   no-entry line when no notify entry wants env-retired.
 * @level   l1 (injected reader, teller and io; no filesystem)
 * @consumer the queue round's onEnvironmentClosed callback
 * @testonly none
 */
import { expect, it } from "vitest"
import type { EventChange } from "@yrd/queue-core"
import { envRetiredTeller } from "../src/queue-core-commands.ts"
import type { ClosedEnvironment } from "../src/env-cleanup.ts"

const CLOSED: ClosedEnvironment = {
  branch: "task/env-fresh",
  head: "c".repeat(40),
  path: "/repo/.bays/env-fresh",
  proof: {
    path: "/repo/.bays/env-fresh",
    head: "c".repeat(40),
    repositories: ["/repo"],
    modules: "none",
    retained: "/retained/env-fresh",
    manifest: "/retained/env-fresh/manifest.json",
    createdAt: "2026-10-17T00:00:00.000Z",
    retainUntil: "2026-10-24T00:00:00.000Z",
    writerLocks: [],
    createdWriterLocks: [],
  } as NonNullable<ClosedEnvironment["proof"]>,
}

function change(status: EventChange["status"]): EventChange {
  return { status, commit: "c".repeat(40), tip: "b".repeat(40) } as EventChange
}

function harness(read: EventChange | undefined, wants = true) {
  const reads: string[] = []
  const told: { branch: string; status: EventChange["status"] }[] = []
  const said: string[] = []
  const teller = envRetiredTeller({
    notify: wants ? [{ name: "author", on: ["env-retired"], run: "true" }] : [{ name: "author", on: ["merged"], run: "true" }],
    readChange: async (branch) => {
      reads.push(branch)
      return read
    },
    tell: async (closed, readChange) => {
      told.push({ branch: closed.branch, status: readChange.status })
    },
    io: {
      cwd: "/repo",
      stdout: () => {},
      stderr: (text: string) => void said.push(text),
      localBranchProtections: null,
    },
  })
  return { reads, told, said, teller }
}

it("tells a merged change exactly once", async () => {
  const h = harness(change("merged"))
  await h.teller(CLOSED)
  expect(h.reads).toEqual(["task/env-fresh"])
  expect(h.told).toEqual([{ branch: "task/env-fresh", status: "merged" }])
})

it("never tells a cancelled change; the merged-only skip is named", async () => {
  const h = harness(change("cancelled"))
  await h.teller(CLOSED)
  expect(h.told).toEqual([])
  expect(h.said.join("")).toContain("(cancelled); no env-retired tell (merged changes only)")
})

it("names the no-chain case from the reader result, not matched text", async () => {
  const h = harness(undefined)
  await h.teller(CLOSED)
  expect(h.told).toEqual([])
  expect(h.said.join("")).toContain("no change record for task/env-fresh, nobody to tell")
})

it("reads nothing and prints the named no-entry line when no entry wants env-retired", async () => {
  const h = harness(change("merged"), false)
  await h.teller(CLOSED)
  expect(h.reads, "zero chain reads before the subscriber check fails").toEqual([])
  expect(h.told).toEqual([])
  expect(h.said.join("")).toContain("no notify entry in .yrd.yml wants env-retired")
})

it("names a closed environment that carries no branch or no proof", async () => {
  const h = harness(change("merged"))
  await h.teller({ path: CLOSED.path })
  expect(h.said.join("")).toContain("(branch not named)")
  await h.teller({ path: CLOSED.path, branch: "task/env-fresh" })
  expect(h.said.join("")).toContain("(proof not named)")
  expect(h.reads).toEqual([])
  expect(h.told).toEqual([])
})
