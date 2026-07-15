/**
 * @failure The PR receiver can accept unsafe refs, lose hook receipts, or duplicate intake after recovery.
 * @level l3
 * @consumer @yrd/bay Git push receiver
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess, type Process } from "@yrd/process"
import {
  createGitPushReceiver,
  loadGitPushReceiver,
  receiverHookSource,
  type GitPushReceiver,
  type ReceiverReceipt,
  type ReceiverTarget,
} from "../src/receiver.ts"

type Env = Record<string, string | undefined>
type Result = { code: number; stdout: string; stderr: string }
type Fixture = {
  root: string
  mainRepo: string
  stateDir: string
  baseSha: string
  receiver: GitPushReceiver
  process: Process
  hookEntry: string
}

const roots: string[] = []
const processes: Process[] = []
const zero = "0".repeat(40)

afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function run(argv: readonly string[], cwd: string, env: Env = process.env): Promise<Result> {
  const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run(["git", "-C", cwd, ...args], cwd)
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git exited ${result.code}`)
  return result.stdout
}

async function commit(repo: string, name: string): Promise<string> {
  await writeFile(join(repo, name), `${name}\n`)
  await git(repo, "add", name)
  await git(repo, "commit", "-qm", `add ${name}`)
  return await git(repo, "rev-parse", "HEAD")
}

async function createRepo(root: string, name: string): Promise<{ path: string; head: string }> {
  const path = join(root, name)
  await mkdir(path)
  await git(path, "init", "-q", "-b", "main")
  await git(path, "config", "user.name", "Yrd Receiver Test")
  await git(path, "config", "user.email", "receiver@example.invalid")
  return { path, head: await commit(path, "README.md") }
}

async function fixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `yrd-${label}-`))
  roots.push(root)
  const main = await createRepo(root, "main repo")
  const stateDir = join(root, "state with 'quotes $()")
  const process = createProcess()
  processes.push(process)
  // Anchor the managed hook at the yrd `installHookHost` will publish, so pushes
  // exercise a real (lightweight) receiver process instead of the full CLI entry.
  const hookEntry = join(root, "bin", "yrd")
  const receiver = await createGitPushReceiver({ mainRepo: main.path, stateDir, process, hookEntry })
  return { root, mainRepo: main.path, stateDir, baseSha: main.head, receiver, process, hookEntry }
}

function target(baseSha: string, overrides: Partial<ReceiverTarget> = {}): ReceiverTarget {
  return { bay: "B1", name: "receiver-test", base: "main", baseSha, ...overrides }
}

async function installHookHost(root: string, targets: Record<string, ReceiverTarget>): Promise<Env> {
  const bin = join(root, "bin")
  const targetFile = join(root, "targets.json")
  const executable = join(bin, "yrd")
  await mkdir(bin, { recursive: true })
  await writeFile(targetFile, JSON.stringify(targets))
  await writeFile(
    executable,
    [
      "#!/usr/bin/env bun",
      'import { readFile } from "node:fs/promises"',
      `import { createProcess } from ${JSON.stringify(new URL("../../yrd-process/src/index.ts", import.meta.url).href)}`,
      `import { runReceiverHookFromEnvironment } from ${JSON.stringify(new URL("../src/receiver.ts", import.meta.url).href)}`,
      "const [, mode] = Bun.argv.slice(2)",
      'const targets = JSON.parse(await readFile(process.env.YRD_TEST_TARGETS, "utf8"))',
      "await using runner = createProcess({ env: process.env })",
      "await runReceiverHookFromEnvironment(mode, { process: runner, resolveTarget: async branch => targets[branch] ?? null })",
      "",
    ].join("\n"),
  )
  await chmod(executable, 0o755)
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, YRD_TEST_TARGETS: targetFile }
}

async function push(f: Fixture, spec: string, env: Env): Promise<Result> {
  return await run(["git", "-C", f.mainRepo, "push", f.receiver.receiverPath, spec], f.mainRepo, env)
}

function receiverId(ref: string, oldSha: string, newSha: string): string {
  return createHash("sha256").update(`${ref}\0${oldSha}\0${newSha}`).digest("hex")
}

async function inboxFiles(receiver: GitPushReceiver): Promise<string[]> {
  return (await readdir(receiver.inboxDir)).filter((name) => name.endsWith(".json")).toSorted()
}

// Every case launches several real Git processes; budget for cold starts on loaded CI hosts.
describe("Git push receiver", { timeout: 20_000 }, () => {
  it("sets up prs.git idempotently without replacing refs, objects, or managed hooks", async () => {
    const f = await fixture("setup")
    expect(f.receiver.receiverPath).toBe(join(await realpath(f.stateDir), "prs.git"))
    expect(await git(f.receiver.receiverPath, "rev-parse", "--is-bare-repository")).toBe("true")
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/bases/main")).toBe(f.baseSha)

    for (const mode of ["pre-receive", "post-receive"] as const) {
      const hook = join(f.receiver.receiverPath, "hooks", mode)
      expect(await readFile(hook, "utf8")).toBe(receiverHookSource(mode, f.hookEntry))
      expect((await stat(hook)).mode & 0o111).not.toBe(0)
    }

    await git(f.receiver.receiverPath, "update-ref", "refs/heads/preserved", f.baseSha)
    const reopened = await createGitPushReceiver({
      mainRepo: f.mainRepo,
      stateDir: f.stateDir,
      process: f.process,
      hookEntry: f.hookEntry,
    })
    expect(await git(reopened.receiverPath, "rev-parse", "refs/heads/preserved")).toBe(f.baseSha)
    expect(await git(reopened.receiverPath, "cat-file", "-e", `${f.baseSha}^{commit}`)).toBe("")
    const loaded = await loadGitPushReceiver(reopened.receiverPath, f.process)
    expect(loaded).toMatchObject({
      version: reopened.version,
      receiverPath: reopened.receiverPath,
      mainRepo: reopened.mainRepo,
      stateDir: reopened.stateDir,
      inboxDir: reopened.inboxDir,
      objectFormat: reopened.objectFormat,
      shaLength: reopened.shaLength,
    })
    expect([loaded.prepare, loaded.finalize, loaded.drain].every((method) => typeof method === "function")).toBe(true)
  })

  it("refuses unmanaged hooks and retargeting", async () => {
    const f = await fixture("binding")
    const hook = join(f.receiver.receiverPath, "hooks", "pre-receive")
    await writeFile(hook, "#!/bin/sh\necho operator-hook\n")
    await expect(
      createGitPushReceiver({ mainRepo: f.mainRepo, stateDir: f.stateDir, process: f.process }),
    ).rejects.toThrow(/unmanaged pre-receive hook/)
    expect(await readFile(hook, "utf8")).toContain("operator-hook")

    const other = await createRepo(f.root, "other repo")
    await expect(
      createGitPushReceiver({ mainRepo: other.path, stateDir: f.stateDir, process: f.process }),
    ).rejects.toThrow(/already belongs to main repository/)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/bases/main")).toBe(f.baseSha)
  })

  it("accepts an authorized pinned push and leaves a pending receipt for Bay intake", async () => {
    const f = await fixture("push")
    await git(f.mainRepo, "switch", "-qc", "issue/good")
    const headSha = await commit(f.mainRepo, "good.txt")
    const result = await push(
      f,
      "issue/good:refs/heads/issue/good",
      await installHookHost(f.root, { "issue/good": target(f.baseSha) }),
    )
    expect(result.code, result.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/heads/issue/good")).toBe(headSha)
    expect(await inboxFiles(f.receiver)).toEqual([expect.stringMatching(/\.pending\.json$/u)])

    const delivered: ReceiverReceipt[] = []
    const drained = await f.receiver.drain({
      resolveTarget: async () => target(f.baseSha),
      intake: async (receipt) => void delivered.push(receipt),
    })
    expect(drained).toMatchObject({ delivered: [expect.any(String)], failed: [], ambiguous: [] })
    expect(delivered).toEqual([
      expect.objectContaining({
        branch: "issue/good",
        ref: "refs/heads/issue/good",
        oldSha: zero,
        headSha,
        intake: { bay: "B1", name: "receiver-test", branch: "issue/good", base: "main", baseSha: f.baseSha, headSha },
      }),
    ])
    expect(await inboxFiles(f.receiver)).toEqual([])
  })

  it("re-invokes the worktree-anchored yrd and ignores an ambient PATH yrd (hermetic cold replay)", async () => {
    const f = await fixture("hermetic")
    await git(f.mainRepo, "switch", "-qc", "issue/hermetic")
    const headSha = await commit(f.mainRepo, "hermetic.txt")

    // The fixture's managed hook is anchored to f.hookEntry (the worktree yrd).
    // Publish a DIFFERENT yrd earlier on PATH to stand in for a foreign (mutable
    // main) checkout. The pre-21170 hook spawned a bare ["yrd", …] and would run
    // this decoy — dropping a marker and failing intake with its own exit code.
    // A hermetic hook resolves its entry by absolute path and never consults PATH.
    const foreign = join(f.root, "foreign-bin")
    await mkdir(foreign, { recursive: true })
    const marker = join(f.root, "foreign-yrd-ran.txt")
    await writeFile(
      join(foreign, "yrd"),
      `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, "foreign")\nprocess.exit(3)\n`,
    )
    await chmod(join(foreign, "yrd"), 0o755)

    const env = await installHookHost(f.root, { "issue/hermetic": target(f.baseSha) })
    const poisoned = { ...env, PATH: `${foreign}:${env.PATH ?? ""}` }
    const result = await push(f, "issue/hermetic:refs/heads/issue/hermetic", poisoned)

    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/heads/issue/hermetic")).toBe(headSha)
    expect(await inboxFiles(f.receiver)).toEqual([expect.stringMatching(/\.pending\.json$/u)])
  })

  it("rejects unknown branches, deletes, and commits outside the pinned base", async () => {
    const f = await fixture("reject")
    await git(f.mainRepo, "switch", "--orphan", "issue/unrelated")
    await run(["git", "-C", f.mainRepo, "rm", "-qrf", "."], f.mainRepo)
    const unrelated = await commit(f.mainRepo, "unrelated.txt")
    const env = await installHookHost(f.root, { "issue/unrelated": target(f.baseSha) })

    const ancestry = await push(f, "issue/unrelated:refs/heads/issue/unrelated", env)
    expect(ancestry.code).not.toBe(0)
    expect(ancestry.stderr).toContain("does not descend from pinned base")
    expect(ancestry.stderr).toContain(unrelated.slice(0, 12))

    const wrongPin = await push(
      f,
      "issue/unrelated:refs/heads/issue/unrelated",
      await installHookHost(f.root, { "issue/unrelated": target(unrelated) }),
    )
    expect(wrongPin.stderr).toContain("is not in the history of base branch 'main'")

    await git(f.mainRepo, "switch", "-q", "main")
    await git(f.mainRepo, "switch", "-qc", "issue/unknown")
    await commit(f.mainRepo, "unknown.txt")
    expect((await push(f, "issue/unknown:refs/heads/issue/unknown", env)).stderr).toContain(
      "is not authorized for Yrd intake",
    )

    await git(f.mainRepo, "switch", "-q", "main")
    const mainEnv = await installHookHost(f.root, { main: target(f.baseSha) })
    expect((await push(f, "main:refs/heads/main", mainEnv)).code).toBe(0)
    const deletion = await push(f, ":refs/heads/main", mainEnv)
    expect(deletion.code).not.toBe(0)
    expect(deletion.stderr).toContain("ref deletion is not accepted")
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/heads/main")).toBe(f.baseSha)
  })

  it("recovers prepared receipts by ref and retries the same receipt id after ambiguous intake", async () => {
    const f = await fixture("recover")
    await git(f.mainRepo, "switch", "-qc", "issue/recover")
    const headSha = await commit(f.mainRepo, "recover.txt")
    await git(f.receiver.receiverPath, "fetch", "-q", f.mainRepo, `+${headSha}:refs/yrd/test/recover`)
    const update = `${zero} ${headSha} refs/heads/issue/recover\n`
    const [receipt] = await f.receiver.prepare(update, { resolveTarget: async () => target(f.baseSha) })
    expect(await inboxFiles(f.receiver)).toEqual([`${receipt!.id}.prepared.json`])
    expect(
      await f.receiver.drain({
        resolveTarget: async () => target(f.baseSha),
        intake: async () => {
          throw new Error("must not run before ref acceptance")
        },
      }),
    ).toEqual({ delivered: [], failed: [], ambiguous: [receipt!.id] })
    expect(await inboxFiles(f.receiver)).toEqual([`${receipt!.id}.prepared.json`])
    await git(f.receiver.receiverPath, "update-ref", "refs/heads/issue/recover", headSha, zero)

    const applied = new Set<string>()
    const failed = await f.receiver.drain({
      resolveTarget: async () => target(f.baseSha),
      intake: async (current) => {
        applied.add(current.id)
        throw new Error("crash after durable intake")
      },
    })
    expect(failed.failed).toEqual([{ id: receipt!.id, error: "crash after durable intake" }])
    expect(await inboxFiles(f.receiver)).toEqual([`${receipt!.id}.pending.json`])

    const retried: string[] = []
    const recovered = await f.receiver.drain({
      resolveTarget: async () => target(f.baseSha),
      intake: async (current) => {
        expect(applied.has(current.id)).toBe(true)
        retried.push(current.id)
      },
    })
    expect(recovered).toEqual({ delivered: [receipt!.id], failed: [], ambiguous: [] })
    expect(retried).toEqual([receipt!.id])
    expect(await inboxFiles(f.receiver)).toEqual([])
  })

  it("drains each branch in ref-update order rather than receipt-name order", async () => {
    const f = await fixture("order")
    await git(f.mainRepo, "switch", "-qc", "issue/source")
    const first = await commit(f.mainRepo, "one.txt")
    const second = await commit(f.mainRepo, "two.txt")
    await git(f.receiver.receiverPath, "fetch", "-q", f.mainRepo, `+${second}:refs/yrd/test/order`)
    const branch = Array.from({ length: 1_000 }, (_, index) => `issue/order-${index}`).find((candidate) => {
      const ref = `refs/heads/${candidate}`
      return receiverId(ref, zero, first) > receiverId(ref, first, second)
    })!
    const ref = `refs/heads/${branch}`
    const resolveTarget = async () => target(f.baseSha)

    for (const [oldSha, headSha] of [
      [zero, first],
      [first, second],
    ] as const) {
      const update = `${oldSha} ${headSha} ${ref}\n`
      await f.receiver.prepare(update, { resolveTarget })
      await git(f.receiver.receiverPath, "update-ref", ref, headSha, oldSha)
      await f.receiver.finalize(update, { resolveTarget })
    }
    const heads: string[] = []
    const result = await f.receiver.drain({
      resolveTarget,
      intake: async (receipt) => void heads.push(receipt.headSha),
    })
    expect(result.failed).toEqual([])
    expect(heads).toEqual([first, second])
  })

  it("retains and reports malformed receipt data", async () => {
    const f = await fixture("malformed")
    const id = "a".repeat(64)
    const corrupt = join(f.receiver.inboxDir, `${id}.pending.json`)
    await writeFile(corrupt, "{not-json\n")
    const result = await f.receiver.drain({
      resolveTarget: async () => null,
      intake: async () => {
        throw new Error("must not run")
      },
    })
    expect(result.failed).toEqual([{ id, error: expect.stringContaining("invalid JSON") }])
    expect(await readFile(corrupt, "utf8")).toBe("{not-json\n")
  })
})
