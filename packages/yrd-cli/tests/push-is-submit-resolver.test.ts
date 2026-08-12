/**
 * @failure  Intake authorization is "an active bay tracks this branch", but a
 *           push-is-submit push predates its bay by construction, so it can
 *           never satisfy that rule and the whole `refs/for/` namespace stays
 *           unreachable — admitted by the receiver, then refused by the one
 *           resolver that decides what a pushed ref lands on.
 * @level    l2 (a real git repository; the base tip is a real rev-parse)
 * @consumer @yrd/core/22716-yrd-hardening-program/p2-push-is-submit
 */
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import type { ReceiverRefUpdate, ReceiverSubmitIntent } from "@yrd/bay"
import type { ReceiverReceipt } from "@yrd/bay"
import { materializeCarrier, receiverTarget, type ReceiverBayView } from "../src/host.ts"

const process = createProcess()
const zero = "0".repeat(40)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await process.run({ argv: ["git", "-C", cwd, ...args], cwd, timeoutMs: 30_000 })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

/** A repository with a real `main` and a real `release/2` — two bases, so the
 * resolver's base lookup is answering a question that has more than one answer. */
async function repository(): Promise<{ repo: string; mainSha: string; releaseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-submit-resolver-"))
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await writeFile(join(repo, "README.md"), "root\n")
  await git(repo, "add", "-A")
  await git(repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "root")
  const mainSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "branch", "release/2")
  await writeFile(join(repo, "next.txt"), "next\n")
  await git(repo, "add", "-A")
  await git(repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "next")
  return { repo, mainSha: await git(repo, "rev-parse", "refs/heads/main"), releaseSha: mainSha }
}

function bays(...list: readonly ReceiverBayView[]) {
  return { state: () => ({ bays: { byId: Object.fromEntries(list.map((bay) => [bay.id, bay])) } }) }
}

function bay(overrides: Partial<ReceiverBayView> = {}): ReceiverBayView {
  return { id: "B1", name: "bay-one", branch: "task/one", base: "main", baseSha: zero, status: "active", ...overrides }
}

const update: ReceiverRefUpdate = { oldSha: zero, newSha: "a".repeat(40), ref: "refs/for/main/my-change" }
const intent: ReceiverSubmitIntent = { base: "main", name: "@yrd/core/my-change" }

describe("push-is-submit target resolution", () => {
  it("admits a submit intent with no bay at all, naming a carrier and the live base tip", async () => {
    const { repo, mainSha } = await repository()
    const resolve = receiverTarget(bays(), process, repo)

    // The single fact this whole criterion turns on: no bay exists, and the
    // push is still authorized. `bay` must be ABSENT rather than empty —
    // `bay.intake` treats a named bay as a lookup and would refuse an unknown one.
    await expect(resolve("unused", update, intent)).resolves.toEqual({
      name: "@yrd/core/my-change",
      issue: "@yrd/core/my-change",
      base: "main",
      baseSha: mainSha,
      branch: "issue/@yrd/core/my-change",
    })
  })

  it("reads the base tip fresh rather than any recorded pin", async () => {
    const { repo, releaseSha } = await repository()
    const resolve = receiverTarget(bays(), process, repo)
    const resolved = await resolve("unused", update, { base: "release/2", name: "other" })
    // `release/2` is one commit behind `main`; a resolver keying off HEAD or a
    // default base would hand back main's tip and gate the change against a
    // base its author never named.
    expect(resolved).toMatchObject({ base: "release/2", baseSha: releaseSha, branch: "issue/other" })
  })

  it("attaches a submit to an active bay that already carries the same issue", async () => {
    const { repo } = await repository()
    const existing = bay({ id: "B7", name: "seven", issue: "@yrd/core/my-change", branch: "cto/hand-picked" })
    const resolve = receiverTarget(bays(existing), process, repo)

    // Same issue, deliberately NOT the derived carrier name. Minting a second
    // carrier here would split one change across two PRs, which is the failure
    // a bay-less path makes newly possible.
    await expect(resolve("unused", update, intent)).resolves.toEqual({
      bay: "B7",
      name: "seven",
      issue: "@yrd/core/my-change",
      base: "main",
      baseSha: zero,
      branch: "cto/hand-picked",
    })
  })

  it("attaches a submit to an active bay tracking the derived carrier branch", async () => {
    const { repo } = await repository()
    const existing = bay({ id: "B8", name: "eight", branch: "issue/@yrd/core/my-change" })
    const resolve = receiverTarget(bays(existing), process, repo)
    await expect(resolve("unused", update, intent)).resolves.toMatchObject({
      bay: "B8",
      branch: "issue/@yrd/core/my-change",
    })
  })

  it("ignores a closed bay and admits the submit on its own terms", async () => {
    const { repo, mainSha } = await repository()
    const closed = bay({ id: "B9", issue: "@yrd/core/my-change", status: "closed" })
    const resolve = receiverTarget(bays(closed), process, repo)
    const resolved = await resolve("unused", update, intent)
    expect(resolved).toMatchObject({ baseSha: mainSha, branch: "issue/@yrd/core/my-change" })
    expect(resolved).not.toHaveProperty("bay")
  })

  it("refuses a vanished base by naming it, never by falling through to the bay policy", async () => {
    const { repo } = await repository()
    const resolve = receiverTarget(bays(), process, repo)

    // A null here would render INTAKE_POLICY — "open one with `yrd bay open`" —
    // which answers a race about a base branch with instructions about bays.
    await expect(resolve("unused", update, { base: "gone", name: "x" })).rejects.toThrow(
      /base branch 'gone' disappeared/u,
    )
  })

  it("leaves the branch-push rule exactly as it was", async () => {
    const { repo } = await repository()
    const tracked = bay({ branch: "task/one", baseSha: "b".repeat(40) })
    const resolve = receiverTarget(bays(tracked), process, repo)
    const branchUpdate: ReceiverRefUpdate = { oldSha: zero, newSha: "a".repeat(40), ref: "refs/heads/task/one" }

    // No `branch` field: a branch push names its branch in the ref, and the
    // receiver reads it there. Adding one would be a second spelling of a fact
    // the receipt already holds.
    await expect(resolve("task/one", branchUpdate)).resolves.toEqual({
      bay: "B1",
      name: "bay-one",
      base: "main",
      baseSha: "b".repeat(40),
    })
    await expect(resolve("task/untracked", branchUpdate)).resolves.toBeNull()
  })
})

describe("push-is-submit carrier materialization", () => {
  /** A receipt shaped exactly as the receiver writes one for a submit push. */
  function receipt(headSha: string, overrides: Partial<ReceiverReceipt> = {}): ReceiverReceipt {
    return {
      version: 1,
      id: "a".repeat(64),
      receivedAt: "2026-08-12T00:00:00.000Z",
      ref: "refs/for/main/my-change",
      branch: "issue/my-change",
      change: "my-change",
      oldSha: zero,
      headSha,
      intake: { name: "my-change", base: "main", baseSha: zero, branch: "issue/my-change", headSha },
      ...overrides,
    } as ReceiverReceipt
  }

  it("creates the carrier the submit push named, at the head it pushed", async () => {
    const { repo, mainSha } = await repository()
    // The whole point: this ref does not exist, and nothing else would create
    // it. Without it the PR is admitted and then refused forever by the
    // pre-submit gate with `required-check candidate '<branch>' is missing`.
    await expect(git(repo, "rev-parse", "--verify", "refs/heads/issue/my-change")).rejects.toThrow()

    await materializeCarrier(process, repo, receipt(mainSha))
    expect(await git(repo, "rev-parse", "refs/heads/issue/my-change")).toBe(mainSha)
  })

  it("fast-forwards an existing carrier, and is a no-op on replay", async () => {
    const { repo, mainSha, releaseSha } = await repository()
    // `release/2` is one behind `main`, so this is a genuine fast-forward.
    await git(repo, "update-ref", "refs/heads/issue/my-change", releaseSha)
    await materializeCarrier(process, repo, receipt(mainSha))
    expect(await git(repo, "rev-parse", "refs/heads/issue/my-change")).toBe(mainSha)

    // Draining the same receipt twice must not fail — the carrier is already
    // where it belongs, which is success, not a collision.
    await materializeCarrier(process, repo, receipt(mainSha))
    expect(await git(repo, "rev-parse", "refs/heads/issue/my-change")).toBe(mainSha)
  })

  it("refuses to move a carrier the pushed head does not descend from", async () => {
    const { repo, mainSha } = await repository()
    // A sibling commit: neither head contains the other, so overwriting would
    // silently drop whatever the carrier already carried.
    await git(repo, "checkout", "-q", "-b", "sibling", "release/2")
    await writeFile(join(repo, "sibling.txt"), "sibling\n")
    await git(repo, "add", "-A")
    await git(repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "sibling")
    const siblingSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "update-ref", "refs/heads/issue/my-change", siblingSha)

    await expect(materializeCarrier(process, repo, receipt(mainSha))).rejects.toThrow(/does not descend from/u)
    // And it left the carrier exactly where it was.
    expect(await git(repo, "rev-parse", "refs/heads/issue/my-change")).toBe(siblingSha)
  })

  it("does nothing for a branch push, which already is its own branch", async () => {
    const { repo, mainSha } = await repository()
    const branchPush = receipt(mainSha, { ref: "refs/heads/task/one", branch: "task/one", change: undefined })
    await materializeCarrier(process, repo, branchPush)
    // No ref invented: a refs/heads push created its branch by pushing it.
    await expect(git(repo, "rev-parse", "--verify", "refs/heads/task/one")).rejects.toThrow()
  })
})
