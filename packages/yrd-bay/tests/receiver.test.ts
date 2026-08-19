/**
 * @failure The PR receiver can accept unsafe refs, lose hook results, or duplicate intake after recovery.
 * @level l3
 * @consumer @yrd/bay Git push receiver
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess, type Process, type ProcessRequest } from "@yrd/process"
import {
  createGitPushReceiver,
  loadGitPushReceiver,
  receiverHookSource,
  submitRefSplits,
  type GitPushReceiver,
  type ReceiverResult,
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
  requests: ProcessRequest[]
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
  const requests: ProcessRequest[] = []
  const recordingProcess = {
    run(request: ProcessRequest) {
      requests.push(request)
      return process.run(request)
    },
  }
  // Anchor the managed hook at the yrd `installHookHost` will publish, so pushes
  // exercise a real (lightweight) receiver process instead of the full CLI entry.
  const hookEntry = join(root, "bin", "yrd")
  const receiver = await createGitPushReceiver({ mainRepo: main.path, stateDir, process: recordingProcess, hookEntry })
  return { root, mainRepo: main.path, stateDir, baseSha: main.head, receiver, process, requests, hookEntry }
}

function target(baseSha: string, overrides: Partial<ReceiverTarget> = {}): ReceiverTarget {
  return { bay: "B1", name: "receiver-test", base: "main", baseSha, ...overrides }
}

async function installHookHost(
  root: string,
  targets: Record<string, ReceiverTarget>,
  intakePolicy?: string,
): Promise<Env> {
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
      // A `refs/for` push has no branch to key on — the change is identified by
      // the ref itself — so the fake resolver keys those on the parsed intent,
      // exactly as the production resolver keys them on the bay it opens.
      "const resolveTarget = async (branch, update, intent) => targets[intent === undefined ? branch : `for:${intent.base}/${intent.name}`] ?? null",
      "await runReceiverHookFromEnvironment(mode, { process: runner, resolveTarget, intakePolicy: process.env.YRD_TEST_INTAKE_POLICY })",
      "",
    ].join("\n"),
  )
  await chmod(executable, 0o755)
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    YRD_TEST_TARGETS: targetFile,
    ...(intakePolicy === undefined ? {} : { YRD_TEST_INTAKE_POLICY: intakePolicy }),
  }
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
    expect(f.requests.length).toBeGreaterThan(0)
    expect(f.requests.every((request) => request.timeoutMs === 30_000)).toBe(true)
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

  it("initializes prs.git in an isolated directory without making the host repository bare", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-isolation-"))
    roots.push(root)
    const main = await createRepo(root, "host repo")
    const runner = createProcess()
    processes.push(runner)
    // Mirror the real layout: the receiver state dir lives inside the host's own git directory.
    const gitDir = await realpath(join(main.path, ".git"))
    const stateDir = join(gitDir, "yrd")
    const receiver = await createGitPushReceiver({ mainRepo: main.path, stateDir, process: runner })

    // `git init --bare` must target the isolated prs.git, strictly inside .git and never the host git dir.
    expect(receiver.receiverPath).toBe(join(gitDir, "yrd", "prs.git"))
    expect(receiver.receiverPath.startsWith(`${gitDir}/`)).toBe(true)
    expect(receiver.receiverPath).not.toBe(gitDir)
    expect(await git(receiver.receiverPath, "rev-parse", "--is-bare-repository")).toBe("true")

    // The host repository and its git directory must stay non-bare and usable after the receiver init.
    expect(await git(main.path, "rev-parse", "--is-bare-repository")).toBe("false")
    expect(await git(main.path, "rev-parse", "--show-toplevel")).toBe(await realpath(main.path))
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

  it("accepts an authorized pinned push and leaves a pending result for Bay intake", async () => {
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

    const delivered: ReceiverResult[] = []
    const drained = await f.receiver.drain({
      resolveTarget: async () => target(f.baseSha),
      intake: async (result) => void delivered.push(result),
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

  it("tells an unauthorized push what the intake actually requires, not just that it was refused", async () => {
    // P2 acceptance: "refused AT PUSH TIME, naming why". The refusal already
    // fired; what it said was 'branch X is not authorized for Yrd intake',
    // which names the verdict and neither the cause nor the remedy. The seat
    // reads that as a permissions problem and has nowhere to go.
    //
    // The receiver deliberately does NOT know why — authorization is
    // resolveTarget's to define, and its one production implementation admits
    // a branch iff an ACTIVE BAY tracks it. So the policy sentence travels
    // from whoever owns the policy, and the receiver only renders it.
    const f = await fixture("policy")
    await git(f.mainRepo, "switch", "-qc", "issue/no-bay")
    await commit(f.mainRepo, "no-bay.txt")

    const policy = "no active bay tracks it; open one with 'yrd bay open --bay <name>'"
    const withPolicy = await push(f, "issue/no-bay:refs/heads/issue/no-bay", await installHookHost(f.root, {}, policy))
    expect(withPolicy.code).not.toBe(0)
    expect(withPolicy.stderr).toContain("is not authorized for Yrd intake")
    expect(withPolicy.stderr).toContain(policy)

    // Absent a policy the refusal must stay exactly as it was — an optional
    // field that changes the no-policy message would be a silent behaviour
    // change for every other caller.
    const without = await push(f, "issue/no-bay:refs/heads/issue/no-bay", await installHookHost(f.root, {}))
    expect(without.code).not.toBe(0)
    expect(without.stderr).toContain("is not authorized for Yrd intake")
    expect(without.stderr).not.toContain("open one with")
  })

  it("recovers prepared results by ref and retries the same result id after ambiguous intake", async () => {
    const f = await fixture("recover")
    await git(f.mainRepo, "switch", "-qc", "issue/recover")
    const headSha = await commit(f.mainRepo, "recover.txt")
    await git(f.receiver.receiverPath, "fetch", "-q", f.mainRepo, `+${headSha}:refs/yrd/test/recover`)
    const update = `${zero} ${headSha} refs/heads/issue/recover\n`
    const [result] = await f.receiver.prepare(update, { resolveTarget: async () => target(f.baseSha) })
    expect(await inboxFiles(f.receiver)).toEqual([`${result!.id}.prepared.json`])
    expect(
      await f.receiver.drain({
        resolveTarget: async () => target(f.baseSha),
        intake: async () => {
          throw new Error("must not run before ref acceptance")
        },
      }),
    ).toEqual({ delivered: [], failed: [], ambiguous: [result!.id] })
    expect(await inboxFiles(f.receiver)).toEqual([`${result!.id}.prepared.json`])
    await git(f.receiver.receiverPath, "update-ref", "refs/heads/issue/recover", headSha, zero)

    const applied = new Set<string>()
    const failed = await f.receiver.drain({
      resolveTarget: async () => target(f.baseSha),
      intake: async (current) => {
        applied.add(current.id)
        throw new Error("crash after durable intake")
      },
    })
    expect(failed.failed).toEqual([{ id: result!.id, error: "crash after durable intake" }])
    expect(await inboxFiles(f.receiver)).toEqual([`${result!.id}.pending.json`])

    const retried: string[] = []
    const recovered = await f.receiver.drain({
      resolveTarget: async () => target(f.baseSha),
      intake: async (current) => {
        expect(applied.has(current.id)).toBe(true)
        retried.push(current.id)
      },
    })
    expect(recovered).toEqual({ delivered: [result!.id], failed: [], ambiguous: [] })
    expect(retried).toEqual([result!.id])
    expect(await inboxFiles(f.receiver)).toEqual([])
  })

  it("drains each branch in ref-update order rather than result-name order", async () => {
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
      intake: async (result) => void heads.push(result.headSha),
    })
    expect(result.failed).toEqual([])
    expect(heads).toEqual([first, second])
  })

  it("retains and reports malformed result data", async () => {
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

  // ── push IS submit ────────────────────────────────────────────────────────
  //
  // P2 criterion 1. Intake authorization is "an active bay tracks this branch",
  // and a push-is-submit push PREDATES its bay by construction, so under the
  // branch-only rule it can never be authorized — the "unrepresentability
  // clause" the deep-dive verdict names. `refs/for/<base>/<name>` makes a
  // bayless push representable: the namespace carries the intent, and admission
  // creates the bay instead of requiring one.
  //
  // The shape is Gerrit's own wire format (`refs/for/<branch>[/<topic>]`), per
  // the operator's git-layer compatibility ruling: a tool that only reads git
  // must find nothing surprising in a Yrd repo.

  it("admits a push to refs/for/<base>/<name> with no bay tracking the branch", async () => {
    const f = await fixture("submit-ref")
    await git(f.mainRepo, "switch", "-qc", "work")
    const headSha = await commit(f.mainRepo, "submitted.txt")

    // No entry keyed by any BRANCH — only by the parsed intent. A resolver that
    // could only answer branch questions would refuse this push, which is the
    // regression this case exists to catch.
    const env = await installHookHost(f.root, {
      "for:main/my-change": target(f.baseSha, { branch: "issue/my-change", issue: "my-change" }),
    })
    const result = await push(f, "work:refs/for/main/my-change", env)
    expect(result.stderr).not.toContain("only branch refs")
    expect(result.code).toBe(0)

    // Read the result by DRAINING rather than by parsing the inbox file: drain
    // re-validates it, so this also proves the stored result passes its own
    // identity check. A submit result used to fail that check outright, since
    // the invariant hardcoded refs/heads/<branch>.
    const delivered: ReceiverResult[] = []
    const drained = await f.receiver.drain({
      resolveTarget: async (_branch, _update, intent) =>
        intent === undefined ? null : target(f.baseSha, { branch: "issue/my-change", issue: "my-change" }),
      intake: async (result) => void delivered.push(result),
    })
    expect(drained).toMatchObject({ delivered: [expect.any(String)], failed: [], ambiguous: [] })
    expect(delivered).toEqual([
      expect.objectContaining({
        ref: "refs/for/main/my-change",
        // The carrier branch comes from the resolver; the ref names the CHANGE.
        branch: "issue/my-change",
        change: "my-change",
        oldSha: zero,
        headSha,
        // The issue rides through to intake. A push that carries an issue
        // reference and lands a PR with no issue has forgotten the only thing
        // the ref said beyond its commits.
        intake: expect.objectContaining({
          base: "main",
          branch: "issue/my-change",
          issue: "my-change",
          headSha,
          submit: true,
        }),
      }),
    ])
    expect(await inboxFiles(f.receiver)).toEqual([])
  })

  it("refuses a rewritten submit patchset before it can strand a receiver result", async () => {
    const f = await fixture("submit-rewrite")
    await git(f.mainRepo, "switch", "-qc", "work")
    const firstHead = await commit(f.mainRepo, "first.txt")
    const env = await installHookHost(f.root, {
      "for:main/my-change": target(f.baseSha, { branch: "issue/my-change", issue: "my-change" }),
    })
    expect((await push(f, "work:refs/for/main/my-change", env)).code).toBe(0)

    const firstDrain = await f.receiver.drain({
      resolveTarget: async (_branch, _update, intent) =>
        intent === undefined ? null : target(f.baseSha, { branch: "issue/my-change", issue: "my-change" }),
      intake: async () => {},
    })
    expect(firstDrain.failed).toEqual([])

    // Model the successful first result's carrier materialization. A later
    // patchset must contain this carrier; otherwise accepting the Git ref and
    // discovering the conflict during post-receive leaves an undrainable
    // result after the pusher has already seen success.
    await git(f.mainRepo, "update-ref", "refs/heads/issue/my-change", firstHead)
    await git(f.mainRepo, "switch", "-qc", "rewritten", f.baseSha)
    const rewrittenHead = await commit(f.mainRepo, "rewritten.txt")

    const result = await push(f, "+rewritten:refs/for/main/my-change", env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("carrier 'issue/my-change'")
    expect(result.stderr).toContain("does not descend")
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/for/main/my-change")).toBe(firstHead)
    expect(await inboxFiles(f.receiver)).toEqual([])
    expect(rewrittenHead).not.toBe(firstHead)
  })

  it("does not mistake a descendant ref for the exact submit carrier", async () => {
    const f = await fixture("submit-prefix")
    await git(f.mainRepo, "switch", "-qc", "work")
    const headSha = await commit(f.mainRepo, "prefix.txt")
    await git(f.mainRepo, "switch", "-qc", "descendant-ref", f.baseSha)
    const descendantHead = await commit(f.mainRepo, "descendant-only.txt")
    await git(f.mainRepo, "update-ref", "refs/heads/issue/my-change/child", descendantHead)
    await git(f.mainRepo, "switch", "work")
    const env = await installHookHost(f.root, {
      "for:main/my-change": target(f.baseSha, { branch: "issue/my-change", issue: "my-change" }),
    })

    const result = await push(f, "work:refs/for/main/my-change", env)
    expect(result.code).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/for/main/my-change")).toBe(headSha)
  })

  it("refuses at drain when the carrier branch moved since the push", async () => {
    const f = await fixture("submit-drift")
    await git(f.mainRepo, "switch", "-qc", "work")
    await commit(f.mainRepo, "drift.txt")
    const env = await installHookHost(f.root, {
      "for:main/my-change": target(f.baseSha, { branch: "issue/my-change" }),
    })
    expect((await push(f, "work:refs/for/main/my-change", env)).code).toBe(0)

    // A submit resolver DERIVES the carrier rather than reading it off the ref,
    // so the carrier is exactly the field that can move between the push and the
    // drain — and it was the one field the drift check never compared. Intake
    // would then have run against a branch nobody re-authorized. Everything else
    // here is deliberately identical, so only the branch can fail this.
    const result = await f.receiver.drain({
      resolveTarget: async (_branch, _update, intent) =>
        intent === undefined ? null : target(f.baseSha, { branch: "issue/somewhere-else" }),
      intake: async () => {
        throw new Error("must not run")
      },
    })
    expect(result.delivered).toEqual([])
    expect(result.failed).toEqual([{ id: expect.any(String), error: expect.stringContaining("authorization changed") }])
  })

  it("resolves the base by longest existing branch, so a slashed change name is not read as a base", async () => {
    const f = await fixture("submit-split")
    await git(f.mainRepo, "switch", "-qc", "work")
    await commit(f.mainRepo, "split.txt")

    // `main/@yrd/core/p2` splits four ways. Only `main` exists, so `main` is the
    // base and the whole remainder is the change name. A greedy first-slash
    // parse would read the base as `main` too — this passes only because the
    // NAME survives intact, which is what a bead-path issue reference needs.
    const env = await installHookHost(f.root, {
      "for:main/@yrd/core/p2": target(f.baseSha, { branch: "issue/p2" }),
    })
    const result = await push(f, "work:refs/for/main/@yrd/core/p2", env)
    expect(result.code).toBe(0)
  })

  it("refuses a refs/for push whose base is not a branch, naming the ref and the base it tried", async () => {
    const f = await fixture("submit-nobase")
    await git(f.mainRepo, "switch", "-qc", "work")
    await commit(f.mainRepo, "nobase.txt")

    const env = await installHookHost(f.root, { "for:nosuch/change": target(f.baseSha, { branch: "issue/c" }) })
    const result = await push(f, "work:refs/for/nosuch/change", env)
    expect(result.code).not.toBe(0)
    // Silent acceptance into an invisible state is the failure this whole phase
    // deletes, so the refusal must be at push time AND must name what it read.
    expect(result.stderr).toContain("refs/for/nosuch/change")
    expect(result.stderr).toContain("no base branch")
  })

  it("refuses a refs/for push that names a base but no change", async () => {
    const f = await fixture("submit-nochange")
    await git(f.mainRepo, "switch", "-qc", "work")
    await commit(f.mainRepo, "nochange.txt")

    const env = await installHookHost(f.root, {})
    const result = await push(f, "work:refs/for/main", env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("refs/for/main")
    // Asserting the SPECIFIC refusal, not merely that one happened: a bare
    // 'refs/for/main' is refused by the namespace check too, so a test that
    // only checked the exit code would pass without this path existing at all.
    expect(result.stderr).toContain("names no change")
    expect(result.stderr).toContain("refs/for/<base>/<change>")
  })

  it("refuses a refs/for push whose resolver returns no carrier branch", async () => {
    const f = await fixture("submit-nobranch")
    await git(f.mainRepo, "switch", "-qc", "work")
    await commit(f.mainRepo, "nobranch.txt")

    // A resolver that admits the change but names no branch would otherwise
    // produce a result whose `branch` is undefined — an invisible state one
    // layer down. It must fail loudly here instead.
    const env = await installHookHost(f.root, { "for:main/orphan": target(f.baseSha) })
    const result = await push(f, "work:refs/for/main/orphan", env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("carrier branch")
  })

  // Passes before this change as well as after, deliberately: opening one
  // namespace must not open the rest, and the only way to know that is a case
  // that was already green and has to stay green.
  it("keeps every other ref namespace refused", async () => {
    const f = await fixture("submit-other")
    await git(f.mainRepo, "switch", "-qc", "work")
    await commit(f.mainRepo, "other.txt")

    const env = await installHookHost(f.root, {})
    const tag = await push(f, "work:refs/tags/v1", env)
    expect(tag.code).not.toBe(0)
    expect(tag.stderr).toContain("refs/tags/v1")
  })
})

describe("submit ref parsing", () => {
  it("offers every base/name split, longest base first", () => {
    expect(submitRefSplits("refs/for/main/@yrd/core/p2")).toEqual([
      { base: "main/@yrd/core", name: "p2" },
      { base: "main/@yrd", name: "core/p2" },
      { base: "main", name: "@yrd/core/p2" },
    ])
  })

  it("offers nothing for a ref that names no change", () => {
    expect(submitRefSplits("refs/for/main")).toEqual([])
    expect(submitRefSplits("refs/for/")).toEqual([])
    expect(submitRefSplits("refs/for")).toEqual([])
  })

  it("offers nothing for a ref outside the submit namespace", () => {
    expect(submitRefSplits("refs/heads/main")).toEqual([])
    expect(submitRefSplits("refs/tags/v1")).toEqual([])
  })
})
