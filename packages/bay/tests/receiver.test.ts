import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createGitPushReceiver,
  drainReceiverInbox,
  finalizeReceiverUpdates,
  loadGitPushReceiver,
  prepareReceiverUpdates,
  receiverHookSource,
  type ReceiverReceipt,
  type ReceiverTarget,
} from "../src/receiver.ts"

type ProcessResult = { code: number; stdout: string; stderr: string }

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function run(argv: readonly string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<ProcessResult> {
  const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function git(cwd: string, args: readonly string[], env?: Record<string, string | undefined>): Promise<string> {
  const result = await run(["git", "-C", cwd, ...args], cwd, env)
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git exited ${result.code}`)
  return result.stdout
}

async function commit(repo: string, name: string, content: string): Promise<string> {
  await writeFile(join(repo, name), content)
  await git(repo, ["add", name])
  await git(repo, ["commit", "-qm", `add ${name}`])
  return await git(repo, ["rev-parse", "HEAD"])
}

async function fixture(label = "receiver"): Promise<{
  root: string
  mainRepo: string
  stateDir: string
  baseSha: string
}> {
  const root = await mkdtemp(join(tmpdir(), `yrd-${label}-`))
  roots.push(root)
  const mainRepo = join(root, "main repo")
  const stateDir = join(root, "state with 'quotes $()")
  await mkdir(mainRepo)
  await git(mainRepo, ["init", "-q", "-b", "main"])
  await git(mainRepo, ["config", "user.name", "Yrd Receiver Test"])
  await git(mainRepo, ["config", "user.email", "receiver@example.invalid"])
  const baseSha = await commit(mainRepo, "README.md", "base\n")
  return { root, mainRepo, stateDir, baseSha }
}

function target(baseSha: string, overrides: Partial<ReceiverTarget> = {}): ReceiverTarget {
  return { bay: "B1", name: "receiver-test", base: "main", baseSha, ...overrides }
}

async function hookPath(receiverPath: string, mode: "pre-receive" | "post-receive"): Promise<string> {
  return join(receiverPath, "hooks", mode)
}

async function installTestHookHost(
  root: string,
  targets: Record<string, ReceiverTarget>,
): Promise<Record<string, string | undefined>> {
  const binDir = join(root, "bin")
  const targetsPath = join(root, "targets.json")
  const executable = join(binDir, "yrd")
  await mkdir(binDir, { recursive: true })
  await writeFile(targetsPath, JSON.stringify(targets), "utf8")
  const receiverModule = new URL("../src/receiver.ts", import.meta.url).href
  await writeFile(
    executable,
    [
      "#!/usr/bin/env bun",
      'import { readFile } from "node:fs/promises"',
      `import { runReceiverHookFromEnvironment } from ${JSON.stringify(receiverModule)}`,
      'const [command, mode] = Bun.argv.slice(2)',
      'if (command !== "receiver-hook" || (mode !== "pre-receive" && mode !== "post-receive")) process.exit(64)',
      'const targets = JSON.parse(await readFile(process.env.YRD_TEST_TARGETS, "utf8"))',
      "await runReceiverHookFromEnvironment(mode, {",
      "  resolveTarget: async (branch) => targets[branch] ?? null,",
      "})",
      "",
    ].join("\n"),
    "utf8",
  )
  await chmod(executable, 0o755)
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    YRD_TEST_TARGETS: targetsPath,
  }
}

async function inboxFiles(inboxDir: string): Promise<string[]> {
  const result: string[] = []
  for (const state of ["prepared", "pending", "processing"] as const) {
    const dir = join(inboxDir, state)
    if (!existsSync(dir)) continue
    for (const file of await readdir(dir)) {
      if (file.endsWith(".json")) result.push(`${state}/${file}`)
    }
  }
  return result.sort()
}

describe("Git push receiver", () => {
  it("creates and reopens prs.git without replacing refs, objects, or deterministic managed hooks", async () => {
    const { root, mainRepo, stateDir, baseSha } = await fixture("receiver-open")
    const receiver = await createGitPushReceiver({ mainRepo, stateDir })

    expect(receiver.receiverPath).toBe(join(await realpath(stateDir), "prs.git"))
    expect(await git(receiver.receiverPath, ["rev-parse", "--is-bare-repository"])).toBe("true")
    expect(await git(receiver.receiverPath, ["rev-parse", "refs/yrd/bases/main"])).toBe(baseSha)

    const hookBodies = await Promise.all(
      (["pre-receive", "post-receive"] as const).map(async (mode) => {
        const path = await hookPath(receiver.receiverPath, mode)
        const body = await readFile(path, "utf8")
        expect(body).toBe(receiverHookSource(mode))
        expect(body).not.toContain(root)
        expect((await stat(path)).mode & 0o111).not.toBe(0)
        return body
      }),
    )
    expect(hookBodies[0]).not.toBe(hookBodies[1])

    await git(receiver.receiverPath, ["update-ref", "refs/heads/preserved", baseSha])
    const reopened = await createGitPushReceiver({ mainRepo, stateDir })
    expect(await git(reopened.receiverPath, ["rev-parse", "refs/heads/preserved"])).toBe(baseSha)
    expect(await git(reopened.receiverPath, ["cat-file", "-e", `${baseSha}^{commit}`])).toBe("")

    const loaded = await loadGitPushReceiver(receiver.receiverPath)
    expect(loaded).toMatchObject({
      receiverPath: receiver.receiverPath,
      mainRepo: receiver.mainRepo,
      stateDir: receiver.stateDir,
      inboxDir: receiver.inboxDir,
    })
  })

  it("fails closed instead of overwriting an unmanaged receive hook", async () => {
    const { mainRepo, stateDir } = await fixture("receiver-hook")
    const receiver = await createGitPushReceiver({ mainRepo, stateDir })
    const hook = await hookPath(receiver.receiverPath, "pre-receive")
    await writeFile(hook, "#!/bin/sh\necho operator-hook\n", "utf8")

    await expect(createGitPushReceiver({ mainRepo, stateDir })).rejects.toThrow(/unmanaged pre-receive hook/)
    expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\necho operator-hook\n")
  })

  it("refuses to retarget a configured receiver to a different main repository", async () => {
    const first = await fixture("receiver-binding-a")
    const second = await fixture("receiver-binding-b")
    const receiver = await createGitPushReceiver({ mainRepo: first.mainRepo, stateDir: first.stateDir })
    await git(receiver.receiverPath, ["update-ref", "refs/heads/preserved", first.baseSha])

    await expect(createGitPushReceiver({ mainRepo: second.mainRepo, stateDir: first.stateDir })).rejects.toThrow(
      /already belongs to main repository/,
    )
    expect(await git(receiver.receiverPath, ["rev-parse", "refs/heads/preserved"])).toBe(first.baseSha)
    expect((await loadGitPushReceiver(receiver.receiverPath)).mainRepo).toBe(receiver.mainRepo)
  })

  it("accepts an authorized pinned push, queues it durably, and drains it through the Bay intake shape", async () => {
    const { root, mainRepo, stateDir, baseSha } = await fixture("receiver-push")
    const receiver = await createGitPushReceiver({ mainRepo, stateDir })
    await git(mainRepo, ["switch", "-qc", "task/good"])
    const headSha = await commit(mainRepo, "good.txt", "good\n")
    const env = await installTestHookHost(root, { "task/good": target(baseSha) })

    const pushed = await run(
      ["git", "-C", mainRepo, "push", receiver.receiverPath, "task/good:refs/heads/task/good"],
      mainRepo,
      env,
    )
    expect(pushed.code, pushed.stderr).toBe(0)
    expect(await git(receiver.receiverPath, ["rev-parse", "refs/heads/task/good"])).toBe(headSha)
    expect((await inboxFiles(receiver.inboxDir)).some((path) => path.startsWith("pending/"))).toBe(true)

    const deliveries: ReceiverReceipt[] = []
    const result = await drainReceiverInbox(receiver, {
      resolveTarget: async (branch) => (branch === "task/good" ? target(baseSha) : null),
      intake: async (receipt) => {
        deliveries.push(receipt)
      },
    })

    expect(result).toMatchObject({ delivered: [expect.any(String)], failed: [], ambiguous: [] })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      version: 1,
      branch: "task/good",
      ref: "refs/heads/task/good",
      oldSha: "0".repeat(40),
      headSha,
      intake: {
        bay: "B1",
        name: "receiver-test",
        branch: "task/good",
        base: "main",
        baseSha,
        headSha,
      },
    })
    expect(await inboxFiles(receiver.inboxDir)).toEqual([])
  })

  it("rejects unknown branches, deletes, and heads that do not descend from the authorized base pin", async () => {
    const { root, mainRepo, stateDir, baseSha } = await fixture("receiver-refuse")
    const receiver = await createGitPushReceiver({ mainRepo, stateDir })
    await git(mainRepo, ["switch", "--orphan", "task/unrelated"])
    await run(["git", "-C", mainRepo, "rm", "-qrf", "."], mainRepo)
    const unrelatedSha = await commit(mainRepo, "unrelated.txt", "unrelated\n")
    const env = await installTestHookHost(root, { "task/unrelated": target(baseSha) })

    const unrelated = await run(
      ["git", "-C", mainRepo, "push", receiver.receiverPath, "task/unrelated:refs/heads/task/unrelated"],
      mainRepo,
      env,
    )
    expect(unrelated.code).not.toBe(0)
    expect(unrelated.stderr).toContain("does not descend from pinned base")
    expect(unrelated.stderr).toContain(baseSha.slice(0, 12))
    expect(unrelated.stderr).toContain(unrelatedSha.slice(0, 12))
    expect((await run(["git", "--git-dir", receiver.receiverPath, "show-ref", "--verify", "refs/heads/task/unrelated"], root)).code).not.toBe(0)

    const wrongBaseEnv = await installTestHookHost(root, {
      "task/unrelated": target(unrelatedSha),
    })
    const wrongBase = await run(
      ["git", "-C", mainRepo, "push", receiver.receiverPath, "task/unrelated:refs/heads/task/unrelated"],
      mainRepo,
      wrongBaseEnv,
    )
    expect(wrongBase.code).not.toBe(0)
    expect(wrongBase.stderr).toContain("is not in the history of base branch 'main'")

    await git(mainRepo, ["switch", "-q", "main"])
    await git(mainRepo, ["switch", "-qc", "task/unknown"])
    await commit(mainRepo, "unknown.txt", "unknown\n")
    const unknown = await run(
      ["git", "-C", mainRepo, "push", receiver.receiverPath, "task/unknown:refs/heads/task/unknown"],
      mainRepo,
      env,
    )
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toContain("is not authorized for Yrd intake")

    await git(mainRepo, ["switch", "-q", "main"])
    const goodEnv = await installTestHookHost(root, { main: target(baseSha) })
    const first = await run(["git", "-C", mainRepo, "push", receiver.receiverPath, "main:refs/heads/main"], mainRepo, goodEnv)
    expect(first.code, first.stderr).toBe(0)
    const deletion = await run(["git", "-C", mainRepo, "push", receiver.receiverPath, ":refs/heads/main"], mainRepo, goodEnv)
    expect(deletion.code).not.toBe(0)
    expect(deletion.stderr).toContain("ref deletion is not accepted")
    expect(await git(receiver.receiverPath, ["rev-parse", "refs/heads/main"])).toBe(baseSha)
  })

  it("recovers an accepted push after post-receive loss and retries one stable receipt idempotently", async () => {
    const { mainRepo, stateDir, baseSha } = await fixture("receiver-recover")
    const receiver = await createGitPushReceiver({ mainRepo, stateDir })
    await git(mainRepo, ["switch", "-qc", "task/recover"])
    const headSha = await commit(mainRepo, "recover.txt", "recover\n")
    await git(receiver.receiverPath, ["fetch", "-q", mainRepo, `+${headSha}:refs/yrd/test/recover`])

    const update = `${"0".repeat(40)} ${headSha} refs/heads/task/recover\n`
    const prepared = await prepareReceiverUpdates(receiver, update, {
      resolveTarget: async () => target(baseSha),
    })
    expect(prepared).toHaveLength(1)
    await git(receiver.receiverPath, ["update-ref", "refs/heads/task/recover", headSha, "0".repeat(40)])

    const durablyApplied = new Set<string>()
    let calls = 0
    const first = await drainReceiverInbox(receiver, {
      resolveTarget: async () => target(baseSha),
      intake: async (receipt) => {
        calls++
        durablyApplied.add(receipt.id)
        throw new Error("simulated crash after durable intake")
      },
    })
    expect(first.delivered).toEqual([])
    expect(first.failed).toEqual([{ id: prepared[0]!.id, error: "simulated crash after durable intake" }])
    expect(await inboxFiles(receiver.inboxDir)).toEqual([`processing/${prepared[0]!.id}.json`])

    const second = await drainReceiverInbox(receiver, {
      resolveTarget: async () => target(baseSha),
      intake: async (receipt) => {
        calls++
        expect(durablyApplied.has(receipt.id)).toBe(true)
      },
    })
    expect(second).toMatchObject({ delivered: [prepared[0]!.id], failed: [], ambiguous: [] })
    expect(calls).toBe(2)
    expect(durablyApplied).toEqual(new Set([prepared[0]!.id]))
    expect(await inboxFiles(receiver.inboxDir)).toEqual([])
  })

  it("drains queued revisions in ref-update order even when receipt hashes sort in reverse", async () => {
    const { mainRepo, stateDir, baseSha } = await fixture("receiver-order")
    const receiver = await createGitPushReceiver({ mainRepo, stateDir })
    await git(mainRepo, ["switch", "-qc", "task/order-source"])
    const firstHead = await commit(mainRepo, "one.txt", "one\n")
    const secondHead = await commit(mainRepo, "two.txt", "two\n")
    await git(receiver.receiverPath, ["fetch", "-q", mainRepo, `+${secondHead}:refs/yrd/test/order`])

    const zero = "0".repeat(40)
    const hash = (ref: string, oldSha: string, newSha: string): string =>
      createHash("sha256").update(`${ref}\0${oldSha}\0${newSha}`, "utf8").digest("hex")
    const branch = Array.from({ length: 1_000 }, (_, index) => `task/order-${index}`).find((candidate) => {
      const ref = `refs/heads/${candidate}`
      return hash(ref, zero, firstHead) > hash(ref, firstHead, secondHead)
    })!
    const ref = `refs/heads/${branch}`
    const resolveTarget = async () => target(baseSha)

    await prepareReceiverUpdates(receiver, `${zero} ${firstHead} ${ref}\n`, { resolveTarget })
    await git(receiver.receiverPath, ["update-ref", ref, firstHead, zero])
    await finalizeReceiverUpdates(receiver, `${zero} ${firstHead} ${ref}\n`, { resolveTarget })
    await prepareReceiverUpdates(receiver, `${firstHead} ${secondHead} ${ref}\n`, { resolveTarget })
    await git(receiver.receiverPath, ["update-ref", ref, secondHead, firstHead])
    await finalizeReceiverUpdates(receiver, `${firstHead} ${secondHead} ${ref}\n`, { resolveTarget })

    const deliveredHeads: string[] = []
    const result = await drainReceiverInbox(receiver, {
      resolveTarget,
      intake: async (receipt) => {
        deliveredHeads.push(receipt.headSha)
      },
    })
    expect(result.failed).toEqual([])
    expect(deliveredHeads).toEqual([firstHead, secondHead])
  })

  it("keeps malformed inbox data for inspection and reports it instead of dropping later work", async () => {
    const { mainRepo, stateDir } = await fixture("receiver-corrupt")
    const receiver = await createGitPushReceiver({ mainRepo, stateDir })
    const corrupt = join(receiver.inboxDir, "processing", `${"a".repeat(64)}.json`)
    await writeFile(corrupt, "{not-json\n", "utf8")

    const result = await drainReceiverInbox(receiver, {
      resolveTarget: async () => null,
      intake: async () => {
        throw new Error("must not run")
      },
    })

    expect(result.delivered).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ id: "a".repeat(64) })
    expect(result.failed[0]!.error).toContain("invalid JSON")
    expect(await readFile(corrupt, "utf8")).toBe("{not-json\n")
  })
})
