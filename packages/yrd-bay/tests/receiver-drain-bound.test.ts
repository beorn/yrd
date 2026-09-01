/**
 * @failure The receiver drain holds its lock for unbounded work, so a push waits on other branches' intake.
 * @level l3
 * @consumer @yrd/bay Git push receiver
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createExclusive } from "@yrd/persistence"
import { createProcess, type Process } from "@yrd/process"
import { createGitPushReceiver, type GitPushReceiver, type ReceiverTarget } from "../src/receiver.ts"

type Fixture = { root: string; mainRepo: string; stateDir: string; baseSha: string; receiver: GitPushReceiver }

const roots: string[] = []
const processes: Process[] = []
const zero = "0".repeat(40)

afterEach(async () => {
  await Promise.all(processes.splice(0).map((one) => one.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git exited ${code}`)
  return stdout.trim()
}

async function fixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `yrd-drain-bound-${name}-`))
  roots.push(root)
  const mainRepo = join(root, "main")
  const stateDir = join(root, "state")
  await git(root, "init", "-q", "--initial-branch=main", mainRepo)
  await git(mainRepo, "config", "user.email", "receiver@yrd.test")
  await git(mainRepo, "config", "user.name", "Receiver Test")
  await writeFile(join(mainRepo, "base.txt"), "base\n")
  await git(mainRepo, "add", "base.txt")
  await git(mainRepo, "commit", "-qm", "base")
  const baseSha = await git(mainRepo, "rev-parse", "HEAD")
  const process_ = createProcess({ cwd: root })
  processes.push(process_)
  const receiver = await createGitPushReceiver({
    mainRepo,
    stateDir,
    process: process_,
    hookEntry: join(mainRepo, "bin-yrd-does-not-run-here"),
  })
  return { root, mainRepo, stateDir, baseSha, receiver }
}

function target(baseSha: string, bay = "B1", name = "drain-bound"): ReceiverTarget {
  return { bay, name, base: "main", baseSha }
}

/** Push one branch through the receiver's own pre/post-receive entry points so a
 * real `pending` inbox result exists, without installing a managed hook. */
async function seedPending(f: Fixture, branch: string): Promise<string> {
  await git(f.mainRepo, "switch", "-q", "-c", branch, "main")
  await writeFile(join(f.mainRepo, `${branch.replaceAll("/", "-")}.txt`), `${branch}\n`)
  await git(f.mainRepo, "add", "-A")
  await git(f.mainRepo, "commit", "-qm", `add ${branch}`)
  const headSha = await git(f.mainRepo, "rev-parse", "HEAD")
  await git(f.mainRepo, "switch", "-q", "main")
  const update = [{ oldSha: zero, newSha: headSha, ref: `refs/heads/${branch}` }] as const
  await f.receiver.prepare(update, { resolveTarget: async () => target(f.baseSha) })
  await git(f.receiver.receiverPath, "fetch", "--quiet", f.mainRepo, `+refs/heads/${branch}:refs/heads/${branch}`)
  await f.receiver.finalize(update, { resolveTarget: async () => target(f.baseSha) })
  return headSha
}

describe("receiver drain critical section", () => {
  it("bounds the lock hold: a slow intake stops the pass at the deadline instead of running every pending result", async () => {
    const f = await fixture("deadline")
    await seedPending(f, "issue/one")
    await seedPending(f, "issue/two")
    await seedPending(f, "issue/three")

    const started: string[] = []
    const drained = await f.receiver.drain({
      resolveTarget: async () => target(f.baseSha),
      intake: async (result) => {
        started.push(result.branch)
        await Bun.sleep(60)
      },
      drainDeadlineMs: 30,
    })

    // The pass takes ONE result and then stops: the deadline is checked before
    // each result, so the lock hold is bounded by (deadline + one result), not
    // by the number of results waiting.
    expect(started).toHaveLength(1)
    expect(drained.delivered).toHaveLength(1)
    expect(drained.failed).toEqual([])
    expect(drained.deferred).toHaveLength(2)
    expect(drained.deadlineExceeded).toBe(true)
  })

  it("names the lock holder in a typed deferral instead of throwing when another drain holds the lock", async () => {
    const f = await fixture("busy")
    await seedPending(f, "issue/busy")

    const held = createExclusive(join(f.receiver.inboxDir, "drain-lock"), { timeoutMs: 30_000 })
    let release = (): void => undefined
    const holder = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = held.run(() => holder, { holder: "test-holds-the-drain-lock" })
    await Bun.sleep(50)

    const intaken: string[] = []
    const drained = await f.receiver.drain({
      resolveTarget: async () => target(f.baseSha),
      intake: async (result) => void intaken.push(result.branch),
      lockTimeoutMs: 20,
    })
    release()
    await holding

    // Not a throw, and not a silent empty pass: a typed deferral that NAMES the
    // holder, so a post-receive hook can report it without failing the push.
    expect(intaken).toEqual([])
    expect(drained.delivered).toEqual([])
    expect(drained.failed).toEqual([])
    expect(drained.lockBusy).toMatch(/test-holds-the-drain-lock/u)
    expect(drained.deferred).toHaveLength(1)
  })
})
