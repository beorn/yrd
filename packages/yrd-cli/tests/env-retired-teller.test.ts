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
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, expect, it } from "vitest"
import { createEventQueue, createEventStore, readConfig, type EventChange } from "@yrd/queue-core"
import { envRetiredTeller, readClosedChange } from "../src/queue-core-commands.ts"
import type { ClosedEnvironment } from "../src/env-cleanup.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

// The proof shape is git-super's retention report, opaque to the teller: it
// only requires one to be present and passes it through untouched.
const PROOF = {
  manifest: "/retained/env-fresh/manifest.json",
  retained: "/retained/env-fresh",
  retainUntil: "2026-10-24T00:00:00.000Z",
} as unknown as NonNullable<ClosedEnvironment["proof"]>

const CLOSED: ClosedEnvironment = {
  branch: "task/env-fresh",
  head: "c".repeat(40),
  path: "/repo/.bays/env-fresh",
  proof: PROOF,
}

function change(status: EventChange["status"]): EventChange {
  return { status, commit: "c".repeat(40), tip: "b".repeat(40) } as EventChange
}

function harness(read: EventChange | undefined, wants = true) {
  const reads: string[] = []
  const told: { branch: string; status: EventChange["status"] }[] = []
  const said: string[] = []
  const teller = envRetiredTeller({
    notify: wants
      ? [{ name: "author", on: ["env-retired"], run: "true" }]
      : [{ name: "author", on: ["merged"], run: "true" }],
    where: "origin#main",
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
  expect(h.said.join("")).toContain("no change record for task/env-fresh at origin#main, nobody to tell")
})

it("reads nothing and prints the named no-entry line when no entry wants env-retired", async () => {
  const h = harness(change("merged"), false)
  await h.teller(CLOSED)
  expect(h.reads, "zero chain reads before the subscriber check fails").toEqual([])
  expect(h.told).toEqual([])
  expect(h.said.join("")).toContain("no notify entry in .yrd.yml wants env-retired")
})

const fixtureRoots: string[] = []
afterAll(() => {
  for (const root of fixtureRoots.splice(0)) safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
})

it("the production reader returns undefined on a store with no chain for the branch", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-read-closed-change-")))
  fixtureRoots.push(root)
  const seed = gitIn(root)
  const bare = join(root, "remote.git")
  const repo = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", bare])
  await seed(["clone", "--quiet", bare, repo])
  const git = gitIn(repo)
  await git(["config", "user.email", "teller@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, ".yrd.yml"), "{}\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "declare the queue"])
  await git(["push", "--quiet", "origin", "main"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  const store = createEventStore(repo, "origin", git.selection)
  const config = await readConfig(git, head, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("the fixture target lost .yrd.yml")
  // A real queue chain (cleanup only ever runs after a round), but no chain
  // for the branch: the never-submitted close the sweep can meet.
  await createEventQueue(store, "main", head, config, new Date())
  await expect(readClosedChange(store, "main", "task/never-submitted")).resolves.toBeUndefined()
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
