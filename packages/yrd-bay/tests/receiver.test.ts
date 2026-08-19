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

// The BASE's own .yrd.yml (never a feature branch's) is scope-classification
// authority — readBaseBlob reads it off 'main' in f.mainRepo specifically, so
// fixture setup for a classification test must land it there, not on
// whatever branch is about to be pushed. Switches to main first (fixture()
// leaves the repo checked out there, but a caller may have moved on since);
// the caller is responsible for switching back to continue its own setup.
async function commitOnMain(f: Fixture, name: string, content: string): Promise<string> {
  await git(f.mainRepo, "switch", "-q", "main")
  await writeFile(join(f.mainRepo, name), content)
  await git(f.mainRepo, "add", name)
  await git(f.mainRepo, "commit", "-qm", `add ${name}`)
  return await git(f.mainRepo, "rev-parse", "HEAD")
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

type AutoConfig = { draft?: string[]; ignore?: string[]; submit?: string[] }
type AutoVerdict = "draft" | "submit" | "ignore"

// A plain glob evaluator over a JSON pattern block, not the real @yrd/cli
// schema/matcher — see installHookHost's own doc for why. The SAME logic is
// embedded as a string inside the generated hook script below (that half
// MUST run in a separate process); this in-process copy exists so a test's
// own direct `f.receiver.drain(...)` call — which never goes through the
// hook script — can wire an equivalent `classifyBranch`. Keep the two in
// sync; a receiver.drain() call that omits classifyBranch silently classifies
// nothing rather than failing loudly (additive-by-design, see
// ReceiverHookOptions.classifyBranch's doc), so a test that forgets this
// would pass for the wrong reason instead of failing — exactly the
// silent-false-negative trap a "writes nothing" assertion is vulnerable to.
function globMatch(pattern: string, text: string): boolean {
  const body = pattern
    .split("**")
    .map((seg) =>
      seg
        .split("*")
        .map((lit) => lit.replace(/[.+^${}()|[\]\\]/gu, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*")
  return new RegExp(`^${body}$`).test(text)
}

function fakeClassifier(autoConfig: AutoConfig): (yaml: string | undefined, branch: string) => AutoVerdict | undefined {
  return (yaml, branch) => {
    if (yaml === undefined) return undefined
    const matches = (patterns?: string[]) => (patterns ?? []).some((pattern) => globMatch(pattern, branch))
    if (matches(autoConfig.ignore)) return "ignore"
    if (matches(autoConfig.submit)) return "submit"
    if (matches(autoConfig.draft)) return "draft"
    return undefined
  }
}

async function installHookHost(
  root: string,
  targets: Record<string, ReceiverTarget>,
  intakePolicy?: string,
  // A marker string, not the real @yrd/cli schema: @yrd/bay's own tests must
  // not depend on @yrd/cli (the same cycle the production receiver avoids by
  // taking `validateConfig` as an injected callback rather than a schema
  // import — see validatePushedYrdConfig in @yrd/cli/config.ts, covered by
  // its own red/PR1337-shape and green tests there). This only proves the
  // RECEIVER'S plumbing: it reads the pushed head's `.yrd.yml`, hands it to
  // whatever validator the caller wired, and refuses the push before
  // acceptance when that validator throws.
  rejectConfigContaining?: string,
  // Same principle for classification: a plain glob evaluator over a JSON
  // pattern block, not the real @yrd/cli schema/matcher. This only proves the
  // RECEIVER'S plumbing — it reads the BASE's `.yrd.yml` (never the pushed
  // head's), hands (yaml, branch) to whatever classifier the caller wired,
  // and materializes exactly the ref the verdict says to. `yaml === undefined`
  // (the base's tree has no `.yrd.yml` at all) always classifies as
  // untracked, regardless of `autoConfig` — proving the receiver passes
  // absence through rather than treating "no file" as "match everything".
  autoConfig?: AutoConfig,
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
      "const marker = process.env.YRD_TEST_REJECT_CONFIG_CONTAINING",
      "const validateConfig = marker === undefined ? undefined : (yaml) => {",
      "  if (yaml !== undefined && yaml.includes(marker)) throw new Error(`yrd: config rejects marker '${marker}'`)",
      "}",
      "const autoConfigRaw = process.env.YRD_TEST_AUTO_CONFIG",
      "function globMatch(pattern, text) {",
      '  const body = pattern.split("**").map((seg) =>',
      '    seg.split("*").map((lit) => lit.replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&")).join("[^/]*"),',
      '  ).join(".*")',
      '  return new RegExp(`^${body}$`).test(text)',
      "}",
      "const classifyBranch = autoConfigRaw === undefined ? undefined : (yaml, branch) => {",
      "  if (yaml === undefined) return undefined",
      "  const auto = JSON.parse(autoConfigRaw)",
      "  const matches = (patterns) => (patterns ?? []).some((p) => globMatch(p, branch))",
      '  if (matches(auto.ignore)) return "ignore"',
      '  if (matches(auto.submit)) return "submit"',
      '  if (matches(auto.draft)) return "draft"',
      "  return undefined",
      "}",
      "await runReceiverHookFromEnvironment(mode, { process: runner, resolveTarget, intakePolicy: process.env.YRD_TEST_INTAKE_POLICY, validateConfig, classifyBranch })",
      "",
    ].join("\n"),
  )
  await chmod(executable, 0o755)
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    YRD_TEST_TARGETS: targetFile,
    ...(intakePolicy === undefined ? {} : { YRD_TEST_INTAKE_POLICY: intakePolicy }),
    ...(rejectConfigContaining === undefined ? {} : { YRD_TEST_REJECT_CONFIG_CONTAINING: rejectConfigContaining }),
    ...(autoConfig === undefined ? {} : { YRD_TEST_AUTO_CONFIG: JSON.stringify(autoConfig) }),
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

  it("rejects unknown branches and commits outside the pinned base", async () => {
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
  })

  /**
   * The queue's own submission/admission gate for `.yrd.yml` (@yrd/cli's
   * validatePushedYrdConfig, PR1337 2026-08-19): a pushed config the queue's
   * schema would refuse must be unlandable, refused at the push itself,
   * before it can ever reach `pr/pushed` or a base ref config read. This
   * proves the RECEIVER half — it reads the pushed head's OWN `.yrd.yml`
   * (never the base's, never a working-tree file) and refuses before
   * acceptance when the injected validator throws; @yrd/cli's own tests
   * prove the real schema catches the PR1337 shape.
   */
  it("refuses a push whose OWN .yrd.yml the injected config validator rejects", async () => {
    const f = await fixture("config-gate")
    await git(f.mainRepo, "switch", "-qc", "issue/bad-config")
    await writeFile(join(f.mainRepo, ".yrd.yml"), "checks: [typecheck]\nFORBIDDEN-marker: true\n")
    await git(f.mainRepo, "add", ".yrd.yml")
    // NOT the `commit()` fixture helper: it (re)writes its `name` argument's
    // CONTENT to be the filename itself, which would clobber the config text
    // just staged above. This test needs to commit exactly what was written.
    await git(f.mainRepo, "commit", "-qm", "bad config")
    const headSha = await git(f.mainRepo, "rev-parse", "HEAD")
    const env = await installHookHost(
      f.root,
      { "issue/bad-config": target(f.baseSha) },
      undefined,
      "FORBIDDEN-marker",
    )

    const refused = await push(f, "issue/bad-config:refs/heads/issue/bad-config", env)
    expect(refused.code, refused.stderr).not.toBe(0)
    expect(refused.stderr).toContain("yrd: config rejects marker 'FORBIDDEN-marker'")
    // Refused BEFORE acceptance: no ref, no inbox result — an admission gate
    // that only complained after accepting the push would already be too
    // late (the exact shape PR1337 fell through).
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/heads/issue/bad-config")).toBe("")
    expect(await inboxFiles(f.receiver)).toEqual([])

    // The commit differs only in its second line — this second push proves
    // the gate reads content, not just "does .yrd.yml exist": a clean config
    // at a DIFFERENT commit on the same branch is admitted normally.
    await git(f.mainRepo, "switch", "-q", "main")
    await git(f.mainRepo, "branch", "-qD", "issue/bad-config")
    await git(f.mainRepo, "switch", "-qc", "issue/bad-config")
    await writeFile(join(f.mainRepo, ".yrd.yml"), "checks: [typecheck]\n")
    await git(f.mainRepo, "add", ".yrd.yml")
    await git(f.mainRepo, "commit", "-qm", "clean config")
    const cleanHeadSha = await git(f.mainRepo, "rev-parse", "HEAD")
    expect(cleanHeadSha).not.toBe(headSha)
    const admitted = await push(f, "issue/bad-config:refs/heads/issue/bad-config", env)
    expect(admitted.code, admitted.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/heads/issue/bad-config")).toBe(cleanHeadSha)
  })

  it("admits a pushed tree with no .yrd.yml at all — the config validator sees undefined, not an empty string", async () => {
    const f = await fixture("config-gate-absent")
    await git(f.mainRepo, "switch", "-qc", "issue/no-config")
    const headSha = await commit(f.mainRepo, "no-config.txt")
    const env = await installHookHost(f.root, { "issue/no-config": target(f.baseSha) }, undefined, "FORBIDDEN-marker")

    const result = await push(f, "issue/no-config:refs/heads/issue/no-config", env)
    expect(result.code, result.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/heads/issue/no-config")).toBe(headSha)
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

  // ── branch-is-change: refs/yrd/submit/* and refs/yrd/archive/* ─────────────
  //
  // bead-branch-is-change phase 1. `refs/yrd/submit/<branch>` is the approval
  // fact — pushing it names the exact commit its author approves to land —
  // validated against the two structural facts the model doc names verbatim:
  // reachable from the branch's own tip, and not already landed on the base
  // ("a dangling sha and an already-landed sha are different refusals").
  // `refs/yrd/archive/*` is the shelf a deleted branch moves to, atomically,
  // so a branch deletion never just erases the change.

  it("accepts a push to refs/yrd/submit/<branch> naming a commit reachable from the branch's tip", async () => {
    const f = await fixture("submitref-ok")
    await git(f.mainRepo, "switch", "-qc", "issue/submit-ok")
    const headSha = await commit(f.mainRepo, "submit-ok.txt")
    const env = await installHookHost(f.root, { "issue/submit-ok": target(f.baseSha) })
    expect((await push(f, "issue/submit-ok:refs/heads/issue/submit-ok", env)).code).toBe(0)

    const result = await push(f, `${headSha}:refs/yrd/submit/issue/submit-ok`, env)
    expect(result.code, result.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/submit/issue/submit-ok")).toBe(headSha)
  })

  it("refuses a submit ref naming a commit not reachable from the branch's own tip (dangling)", async () => {
    const f = await fixture("submitref-dangling")
    await git(f.mainRepo, "switch", "-qc", "issue/submit-dangling")
    await commit(f.mainRepo, "submit-dangling.txt")
    const env = await installHookHost(f.root, { "issue/submit-dangling": target(f.baseSha) })
    expect((await push(f, "issue/submit-dangling:refs/heads/issue/submit-dangling", env)).code).toBe(0)

    // A commit that never touched issue/submit-dangling's history at all —
    // "dangling" in the model doc's own word, distinct from "already landed".
    await git(f.mainRepo, "switch", "--orphan", "unrelated-for-submit")
    await run(["git", "-C", f.mainRepo, "rm", "-qrf", "."], f.mainRepo)
    const unrelated = await commit(f.mainRepo, "unrelated-for-submit.txt")

    const result = await push(f, `${unrelated}:refs/yrd/submit/issue/submit-dangling`, env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("not reachable from branch 'issue/submit-dangling'")
    expect(result.stderr).not.toContain("already an ancestor")
  })

  it("refuses a submit ref for a branch with no ref in this repository at all", async () => {
    const f = await fixture("submitref-noref")
    await git(f.mainRepo, "switch", "-qc", "issue/never-pushed")
    const headSha = await commit(f.mainRepo, "never-pushed.txt")
    const env = await installHookHost(f.root, { "issue/never-pushed": target(f.baseSha) })

    // The branch itself was never pushed to this receiver — no tip to check
    // reachability against, a distinct cause from "pushed but unrelated".
    const result = await push(f, `${headSha}:refs/yrd/submit/issue/never-pushed`, env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("has no ref in this repository")
  })

  it("refuses a submit ref naming a commit already an ancestor of the base branch", async () => {
    const f = await fixture("submitref-landed")
    // No new commits: the branch sits exactly at the base tip, which is
    // trivially both reachable from itself AND already on 'main'.
    await git(f.mainRepo, "switch", "-qc", "issue/submit-landed")
    const env = await installHookHost(f.root, { "issue/submit-landed": target(f.baseSha) })
    expect((await push(f, "issue/submit-landed:refs/heads/issue/submit-landed", env)).code).toBe(0)

    const result = await push(f, `${f.baseSha}:refs/yrd/submit/issue/submit-landed`, env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("already an ancestor of base branch 'main'")
    expect(result.stderr).not.toContain("not reachable")
  })

  it("refuses a submit ref for a branch no active bay tracks", async () => {
    const f = await fixture("submitref-unauthorized")
    await git(f.mainRepo, "switch", "-qc", "issue/submit-unauth")
    const headSha = await commit(f.mainRepo, "submit-unauth.txt")
    expect(
      (
        await push(
          f,
          "issue/submit-unauth:refs/heads/issue/submit-unauth",
          await installHookHost(f.root, { "issue/submit-unauth": target(f.baseSha) }),
        )
      ).code,
    ).toBe(0)

    // A DIFFERENT env for the submit itself: no active bay tracks the branch
    // (closed since, or a submit attempted out of band) — the same policy a
    // branch push is refused under, reused rather than reinvented.
    const result = await push(f, `${headSha}:refs/yrd/submit/issue/submit-unauth`, await installHookHost(f.root, {}))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("is not authorized for Yrd intake")
  })

  it("accepts deleting a submit ref — unsubmit", async () => {
    const f = await fixture("submitref-unsubmit")
    await git(f.mainRepo, "switch", "-qc", "issue/unsubmit")
    const headSha = await commit(f.mainRepo, "unsubmit.txt")
    const env = await installHookHost(f.root, { "issue/unsubmit": target(f.baseSha) })
    expect((await push(f, "issue/unsubmit:refs/heads/issue/unsubmit", env)).code).toBe(0)
    expect((await push(f, `${headSha}:refs/yrd/submit/issue/unsubmit`, env)).code).toBe(0)

    const result = await push(f, ":refs/yrd/submit/issue/unsubmit", env)
    expect(result.code, result.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/submit/issue/unsubmit")).toBe("")
  })

  it("translates a refs/heads/ branch deletion into an atomic archival: archive created, branch gone, submit swept", async () => {
    const f = await fixture("archive-branch")
    await git(f.mainRepo, "switch", "-qc", "issue/archive-me")
    const headSha = await commit(f.mainRepo, "archive-me.txt")
    const env = await installHookHost(f.root, { "issue/archive-me": target(f.baseSha) })
    expect((await push(f, "issue/archive-me:refs/heads/issue/archive-me", env)).code).toBe(0)
    // Submit it first, so the deletion has something live to sweep — the
    // "atomically" claim is only meaningful with all three refs in play.
    expect((await push(f, `${headSha}:refs/yrd/submit/issue/archive-me`, env)).code).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/submit/issue/archive-me")).toBe(headSha)

    const result = await push(f, ":refs/heads/issue/archive-me", env)
    expect(result.code, result.stderr).toBe(0)

    // All three post-states, the model doc's own inventory for one branch.
    // The archive ref's own path now embeds the FULL sha as a child segment
    // (review-panel revision, amending phase 1a's `-shortsha` suffix).
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/heads/issue/archive-me")).toBe("")
    expect(await git(f.receiver.receiverPath, "rev-parse", `refs/yrd/archive/issue/archive-me/${headSha}`)).toBe(
      headSha,
    )
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/submit/issue/archive-me")).toBe("")
  })

  it("re-archiving a branch resurrected at the identical sha is accepted — a legal newest-wins move, not a collision", async () => {
    // The collision class @yrd/queue/candidate-refs.ts's header (22332) fixed
    // by naming refs off composed content instead of a pre-evidence id — the
    // review panel's revision to this ref's shape (full sha as a path child,
    // not a shortsha suffix) goes one step further: since the archive ref's
    // own path now EMBEDS the exact content, a resurrection at the identical
    // sha targets the exact same ref at the exact same value on purpose, and
    // writing that again is explicitly legal (a no-op), never a refusal.
    const f = await fixture("archive-resurrect-legal")
    await git(f.mainRepo, "switch", "-qc", "issue/archive-twice")
    const headSha = await commit(f.mainRepo, "archive-twice.txt")
    const env = await installHookHost(f.root, { "issue/archive-twice": target(f.baseSha) })
    expect((await push(f, "issue/archive-twice:refs/heads/issue/archive-twice", env)).code).toBe(0)
    expect((await push(f, ":refs/heads/issue/archive-twice", env)).code).toBe(0)
    const archiveRef = `refs/yrd/archive/issue/archive-twice/${headSha}`
    expect(await git(f.receiver.receiverPath, "rev-parse", archiveRef)).toBe(headSha)

    // Resurrect the branch at the EXACT same sha (its object already lives in
    // the receiver's own store from the first, successful push) the way this
    // file's fixtures always simulate out-of-band ref state — a direct
    // update-ref, never a push — then archive it again.
    await git(f.receiver.receiverPath, "update-ref", "refs/heads/issue/archive-twice", headSha)
    const result = await push(f, ":refs/heads/issue/archive-twice", env)
    expect(result.code, result.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/heads/issue/archive-twice")).toBe("")
    expect(await git(f.receiver.receiverPath, "rev-parse", archiveRef)).toBe(headSha)
  })

  it("refuses to archive a branch no active bay tracks, leaving it untouched", async () => {
    const f = await fixture("archive-unauthorized")
    await git(f.mainRepo, "switch", "-qc", "issue/archive-unauth")
    const headSha = await commit(f.mainRepo, "archive-unauth.txt")
    expect(
      (
        await push(
          f,
          "issue/archive-unauth:refs/heads/issue/archive-unauth",
          await installHookHost(f.root, { "issue/archive-unauth": target(f.baseSha) }),
        )
      ).code,
    ).toBe(0)

    // Refused at PRE-RECEIVE, before git deletes anything — a branch that
    // fails authorization for archival must never vanish either.
    const result = await push(f, ":refs/heads/issue/archive-unauth", await installHookHost(f.root, {}))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("is not authorized for Yrd intake")
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/heads/issue/archive-unauth")).toBe(headSha)
  })

  it("refuses a direct write to the archive shelf, create or delete", async () => {
    const f = await fixture("archive-direct-write")
    await git(f.mainRepo, "switch", "-qc", "work")
    const headSha = await commit(f.mainRepo, "direct.txt")
    const env = await installHookHost(f.root, { work: target(f.baseSha) })
    const archiveRef = `refs/yrd/archive/some-branch/${headSha}`
    // An ordinary accepted push first — an object must actually exist in the
    // RECEIVER's own store (not just f.mainRepo's) before a low-level
    // update-ref against receiverPath can name it below; a push a pre-receive
    // hook refuses never transfers its objects out of quarantine at all.
    expect((await push(f, "work:refs/heads/work", env)).code).toBe(0)

    const created = await push(f, `${headSha}:${archiveRef}`, env)
    expect(created.code).not.toBe(0)
    expect(created.stderr).toContain("archive shelf")
    expect(created.stderr).toContain("never by a direct push")
    expect(await git(f.receiver.receiverPath, "for-each-ref", archiveRef)).toBe("")

    // A pre-existing shelf entry, written directly against the receiver's own
    // repo the way fixture setup always does elsewhere in this file (never
    // through a push) — proving the refusal reaches deletion too, not merely
    // "you can't create one".
    await git(f.receiver.receiverPath, "update-ref", archiveRef, headSha)
    const deleted = await push(f, `:${archiveRef}`, env)
    expect(deleted.code).not.toBe(0)
    expect(deleted.stderr).toContain("archive shelf")
    expect(await git(f.receiver.receiverPath, "rev-parse", archiveRef)).toBe(headSha)
  })

  it("re-points refs/yrd/submit/<branch> at the pushed tip on every refs/for push, creating then updating it", async () => {
    const f = await fixture("submit-dual-write")
    await git(f.mainRepo, "switch", "-qc", "work")
    const firstHead = await commit(f.mainRepo, "first.txt")
    const env = await installHookHost(f.root, {
      "for:main/dual-write": target(f.baseSha, { branch: "issue/dual-write", issue: "dual-write" }),
    })
    expect((await push(f, "work:refs/for/main/dual-write", env)).code).toBe(0)
    expect(
      (
        await f.receiver.drain({
          resolveTarget: async (_branch, _update, intent) =>
            intent === undefined ? null : target(f.baseSha, { branch: "issue/dual-write", issue: "dual-write" }),
          intake: async () => {},
        })
      ).failed,
    ).toEqual([])
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/submit/issue/dual-write")).toBe(firstHead)

    // Model the first result's carrier materialization (see "refuses a
    // rewritten submit patchset" above for why a SECOND refs/for push needs
    // this), then add a commit that descends from it — "every refs/for push
    // RE-submits", not just the first.
    await git(f.mainRepo, "update-ref", "refs/heads/issue/dual-write", firstHead)
    const secondHead = await commit(f.mainRepo, "second.txt")
    expect((await push(f, "work:refs/for/main/dual-write", env)).code).toBe(0)
    expect(
      (
        await f.receiver.drain({
          resolveTarget: async (_branch, _update, intent) =>
            intent === undefined ? null : target(f.baseSha, { branch: "issue/dual-write", issue: "dual-write" }),
          intake: async () => {},
        })
      ).failed,
    ).toEqual([])
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/submit/issue/dual-write")).toBe(secondHead)
  })

  // ── branch-is-change phase 1b: scope (draft/ignore) + auto classification ──
  //
  // bead-branch-is-change "Scope — auto-draft by pattern, explicit draft by
  // act". Two more instance-override namespaces (draft/ignore, mutually
  // exclusive per branch) plus the receiver evaluating a base-authored `auto:`
  // block once, synchronously, at branch creation.

  it("refuses a draft or ignore ref for a branch with no ref in this repository", async () => {
    const f = await fixture("scope-noref")
    const env = await installHookHost(f.root, {})
    const draftResult = await push(f, `${f.baseSha}:refs/yrd/draft/issue/never-pushed`, env)
    expect(draftResult.code).not.toBe(0)
    expect(draftResult.stderr).toContain("has no ref in this repository")

    const ignoreResult = await push(f, `${f.baseSha}:refs/yrd/ignore/issue/never-pushed`, env)
    expect(ignoreResult.code).not.toBe(0)
    expect(ignoreResult.stderr).toContain("has no ref in this repository")
  })

  it("draft and ignore are mutually exclusive per branch: writing one sweeps the other, in both directions, and either can be plainly deleted", async () => {
    const f = await fixture("scope-mutual-exclusion")
    await git(f.mainRepo, "switch", "-qc", "issue/scope")
    const headSha = await commit(f.mainRepo, "scope.txt")
    const env = await installHookHost(f.root, { "issue/scope": target(f.baseSha) })
    expect((await push(f, "issue/scope:refs/heads/issue/scope", env)).code).toBe(0)

    expect((await push(f, `${headSha}:refs/yrd/ignore/issue/scope`, env)).code).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/ignore/issue/scope")).toBe(headSha)

    const draftResult = await push(f, `${headSha}:refs/yrd/draft/issue/scope`, env)
    expect(draftResult.code, draftResult.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/draft/issue/scope")).toBe(headSha)
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/ignore/issue/scope")).toBe("")

    // And back the other way.
    const ignoreResult = await push(f, `${headSha}:refs/yrd/ignore/issue/scope`, env)
    expect(ignoreResult.code, ignoreResult.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/ignore/issue/scope")).toBe(headSha)
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/draft/issue/scope")).toBe("")

    // Plain deletion (unignore) is a direct, unconditional accept — no sweep
    // of the opposite namespace, which is already empty here.
    const unignoreResult = await push(f, ":refs/yrd/ignore/issue/scope", env)
    expect(unignoreResult.code, unignoreResult.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/ignore/issue/scope")).toBe("")
  })

  it("sweeps draft, ignore, and submit refs together — not just submit — when a branch is archived", async () => {
    const f = await fixture("archive-sweeps-scope")
    await git(f.mainRepo, "switch", "-qc", "issue/archive-scope")
    const headSha = await commit(f.mainRepo, "archive-scope.txt")
    const env = await installHookHost(f.root, { "issue/archive-scope": target(f.baseSha) })
    expect((await push(f, "issue/archive-scope:refs/heads/issue/archive-scope", env)).code).toBe(0)
    // draft and submit are NOT mutually exclusive (only draft/ignore are), so
    // both can be live at once — proving the sweep is unconditional across
    // ALL THREE namespaces, not merely "whichever one happens to be set".
    expect((await push(f, `${headSha}:refs/yrd/draft/issue/archive-scope`, env)).code).toBe(0)
    expect((await push(f, `${headSha}:refs/yrd/submit/issue/archive-scope`, env)).code).toBe(0)

    const result = await push(f, ":refs/heads/issue/archive-scope", env)
    expect(result.code, result.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/draft/issue/archive-scope")).toBe("")
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/submit/issue/archive-scope")).toBe("")
    expect(await git(f.receiver.receiverPath, "rev-parse", `refs/yrd/archive/issue/archive-scope/${headSha}`)).toBe(
      headSha,
    )
  })

  it("auto-classifies a branch at creation by the base's auto: block, precedence ignore over an overlapping submit match", async () => {
    const f = await fixture("auto-classify-precedence")
    await commitOnMain(f, ".yrd.yml", "checks: [typecheck]\n")
    // Deliberately overlapping: this branch's name matches BOTH ignore and
    // submit. Only the precedence rule decides the outcome.
    const autoConfig = { ignore: ["task/straight-*"], submit: ["task/straight-*"], draft: ["task/**"] }
    const env = await installHookHost(f.root, { "task/straight-1": target(f.baseSha) }, undefined, undefined, autoConfig)
    await git(f.mainRepo, "switch", "-qc", "task/straight-1")
    const headSha = await commit(f.mainRepo, "work.txt")
    expect((await push(f, "task/straight-1:refs/heads/task/straight-1", env)).code).toBe(0)
    expect(
      (
        await f.receiver.drain({
          resolveTarget: async () => target(f.baseSha),
          intake: async () => {},
          classifyBranch: fakeClassifier(autoConfig),
        })
      ).failed,
    ).toEqual([])
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/ignore/task/straight-1")).toBe(headSha)
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/submit/task/straight-1")).toBe("")
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/draft/task/straight-1")).toBe("")
  })

  it("writes nothing at creation for a draft-matched or wholly unmatched branch — draft is the default, untracked is untracked", async () => {
    const f = await fixture("auto-no-write")
    await commitOnMain(f, ".yrd.yml", "checks: [typecheck]\n")
    const autoConfig = { draft: ["task/**"], ignore: ["task/wip-*"], submit: ["task/straight-*"] }
    // A canary alongside the two "nothing written" branches: task/wip-1
    // DOES match ignore. Without it, this test cannot tell "the classifier
    // ran and correctly found no match" apart from "the classifier never ran
    // at all" — both look identical (nothing written) from the outside.
    const env = await installHookHost(
      f.root,
      {
        "task/plain": target(f.baseSha),
        "issue/unmatched": target(f.baseSha),
        "task/wip-1": target(f.baseSha),
      },
      undefined,
      undefined,
      autoConfig,
    )
    const resolveTarget = async () => target(f.baseSha)
    const classifyBranch = fakeClassifier(autoConfig)

    await git(f.mainRepo, "switch", "-qc", "task/plain")
    await commit(f.mainRepo, "plain.txt")
    expect((await push(f, "task/plain:refs/heads/task/plain", env)).code).toBe(0)

    await git(f.mainRepo, "switch", "-q", "main")
    await git(f.mainRepo, "switch", "-qc", "issue/unmatched")
    await commit(f.mainRepo, "unmatched.txt")
    expect((await push(f, "issue/unmatched:refs/heads/issue/unmatched", env)).code).toBe(0)

    await git(f.mainRepo, "switch", "-q", "main")
    await git(f.mainRepo, "switch", "-qc", "task/wip-1")
    const canaryHead = await commit(f.mainRepo, "wip.txt")
    expect((await push(f, "task/wip-1:refs/heads/task/wip-1", env)).code).toBe(0)

    expect((await f.receiver.drain({ resolveTarget, intake: async () => {}, classifyBranch })).failed).toEqual([])
    for (const branch of ["task/plain", "issue/unmatched"]) {
      expect(await git(f.receiver.receiverPath, "for-each-ref", `refs/yrd/draft/${branch}`)).toBe("")
      expect(await git(f.receiver.receiverPath, "for-each-ref", `refs/yrd/ignore/${branch}`)).toBe("")
      expect(await git(f.receiver.receiverPath, "for-each-ref", `refs/yrd/submit/${branch}`)).toBe("")
    }
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/ignore/task/wip-1")).toBe(canaryHead)
  })

  it("classifies nothing when the base has no .yrd.yml at all — absence is not 'match everything', proven against the SAME pattern once the base gets one", async () => {
    const f = await fixture("auto-config-absent")
    // No .yrd.yml on main YET — the fixture's own single commit (README.md)
    // is main's whole tree. This pattern WOULD match if the config were
    // consulted at all.
    const autoConfig = { ignore: ["task/**"] }
    const env = await installHookHost(
      f.root,
      { "task/would-match": target(f.baseSha), "task/would-match-2": target(f.baseSha) },
      undefined,
      undefined,
      autoConfig,
    )
    const resolveTarget = async () => target(f.baseSha)
    const classifyBranch = fakeClassifier(autoConfig)

    await git(f.mainRepo, "switch", "-qc", "task/would-match")
    await commit(f.mainRepo, "would-match.txt")
    expect((await push(f, "task/would-match:refs/heads/task/would-match", env)).code).toBe(0)
    expect((await f.receiver.drain({ resolveTarget, intake: async () => {}, classifyBranch })).failed).toEqual([])
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/ignore/task/would-match")).toBe("")

    // The discriminating half: give main a config NOW, and create a SECOND
    // branch, name-shaped identically, AFTER it exists. If the first
    // assertion passed only because the classifier was never consulted at
    // all (the exact false-negative this receiver's own additive design
    // invites — see ReceiverAutoClassifier's doc), this one exposes it: the
    // classifier plumbing is proven live, on the very same pattern.
    await commitOnMain(f, ".yrd.yml", "checks: [typecheck]\n")
    await git(f.mainRepo, "switch", "-qc", "task/would-match-2")
    const secondHeadSha = await commit(f.mainRepo, "would-match-2.txt")
    expect((await push(f, "task/would-match-2:refs/heads/task/would-match-2", env)).code).toBe(0)
    expect((await f.receiver.drain({ resolveTarget, intake: async () => {}, classifyBranch })).failed).toEqual([])
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/ignore/task/would-match-2")).toBe(secondHeadSha)
  })

  it("an auto-submit-classified branch re-submits on every later plain push — the lane persists", async () => {
    const f = await fixture("auto-submit-lane")
    await commitOnMain(f, ".yrd.yml", "checks: [typecheck]\n")
    const autoConfig = { submit: ["task/straight-*"] }
    const env = await installHookHost(f.root, { "task/straight-2": target(f.baseSha) }, undefined, undefined, autoConfig)
    const resolveTarget = async () => target(f.baseSha)
    const classifyBranch = fakeClassifier(autoConfig)
    await git(f.mainRepo, "switch", "-qc", "task/straight-2")
    const firstHead = await commit(f.mainRepo, "one.txt")
    expect((await push(f, "task/straight-2:refs/heads/task/straight-2", env)).code).toBe(0)
    expect((await f.receiver.drain({ resolveTarget, intake: async () => {}, classifyBranch })).failed).toEqual([])
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/submit/task/straight-2")).toBe(firstHead)

    // A second, ORDINARY plain push (not refs/for) to the SAME branch — the
    // lane keeps re-submitting because the name still matches, not because a
    // submit ref happens to already exist.
    const secondHead = await commit(f.mainRepo, "two.txt")
    expect((await push(f, "task/straight-2:refs/heads/task/straight-2", env)).code).toBe(0)
    expect((await f.receiver.drain({ resolveTarget, intake: async () => {}, classifyBranch })).failed).toEqual([])
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/submit/task/straight-2")).toBe(secondHead)
  })

  it("a manually submitted branch never becomes an auto-submit lane — a later plain push does not re-submit it, contrasted against a real lane in the same push", async () => {
    const f = await fixture("manual-submit-not-a-lane")
    await commitOnMain(f, ".yrd.yml", "checks: [typecheck]\n")
    // auto.submit matches straight-* branches; issue/manual's name never
    // does. task/straight-canary DOES match — proving in the SAME test that
    // the lane mechanism is genuinely live (and would re-submit the canary),
    // so issue/manual's stillness cannot be "nothing ran at all".
    const autoConfig = { submit: ["task/straight-*"] }
    const env = await installHookHost(
      f.root,
      { "issue/manual": target(f.baseSha), "task/straight-canary": target(f.baseSha) },
      undefined,
      undefined,
      autoConfig,
    )
    const resolveTarget = async () => target(f.baseSha)
    const classifyBranch = fakeClassifier(autoConfig)
    await git(f.mainRepo, "switch", "-qc", "issue/manual")
    const firstHead = await commit(f.mainRepo, "one.txt")
    expect((await push(f, "issue/manual:refs/heads/issue/manual", env)).code).toBe(0)
    // A MANUAL submit — direct push to the submit-ref namespace, not derived
    // from any pattern match.
    expect((await push(f, `${firstHead}:refs/yrd/submit/issue/manual`, env)).code).toBe(0)

    await git(f.mainRepo, "switch", "-q", "main")
    await git(f.mainRepo, "switch", "-qc", "task/straight-canary")
    await commit(f.mainRepo, "canary-one.txt")
    expect((await push(f, "task/straight-canary:refs/heads/task/straight-canary", env)).code).toBe(0)

    await git(f.mainRepo, "switch", "-q", "issue/manual")
    const secondHead = await commit(f.mainRepo, "two.txt")
    expect((await push(f, "issue/manual:refs/heads/issue/manual", env)).code).toBe(0)

    await git(f.mainRepo, "switch", "-q", "task/straight-canary")
    const canarySecondHead = await commit(f.mainRepo, "canary-two.txt")
    expect((await push(f, "task/straight-canary:refs/heads/task/straight-canary", env)).code).toBe(0)

    expect((await f.receiver.drain({ resolveTarget, intake: async () => {}, classifyBranch })).failed).toEqual([])
    // The canary DID get re-submitted — the lane mechanism is live.
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/submit/task/straight-canary")).toBe(
      canarySecondHead,
    )
    // issue/manual is still at the FIRST head: lane-ness is derived from the
    // pattern match, never from the submit ref's mere existence, so the plain
    // push did not re-submit on the manually-submitted branch's behalf.
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/submit/issue/manual")).toBe(firstHead)
    expect(secondHead).not.toBe(firstHead)
  })

  // ── review-panel deltas on top of 1a+1b (five changes; see the phase-1b
  // commit for the full list) ─────────────────────────────────────────────

  it("refuses to ignore a branch while a live submit exists on it — submitted work can never be hidden", async () => {
    const f = await fixture("ignore-live-submit")
    await git(f.mainRepo, "switch", "-qc", "issue/live-submit")
    const headSha = await commit(f.mainRepo, "live.txt")
    const env = await installHookHost(f.root, { "issue/live-submit": target(f.baseSha) })
    expect((await push(f, "issue/live-submit:refs/heads/issue/live-submit", env)).code).toBe(0)
    expect((await push(f, `${headSha}:refs/yrd/submit/issue/live-submit`, env)).code).toBe(0)

    const result = await push(f, `${headSha}:refs/yrd/ignore/issue/live-submit`, env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("submitted work can never be hidden")
    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/ignore/issue/live-submit")).toBe("")
  })

  it("accepts ignoring a branch whose only submit already landed on main — merged is not live, contrasted against a still-live submit in the same test", async () => {
    const f = await fixture("ignore-merged-submit")
    const env = await installHookHost(f.root, {
      "issue/merged-submit": target(f.baseSha),
      "issue/still-live": target(f.baseSha),
    })

    await git(f.mainRepo, "switch", "-qc", "issue/merged-submit")
    const mergedHead = await commit(f.mainRepo, "merged.txt")
    expect((await push(f, "issue/merged-submit:refs/heads/issue/merged-submit", env)).code).toBe(0)
    expect((await push(f, `${mergedHead}:refs/yrd/submit/issue/merged-submit`, env)).code).toBe(0)

    // A sibling branch whose submit stays live throughout — the discriminating
    // contrast: without it, "merged accepted" would be indistinguishable from
    // "the live-submit gate never ran at all".
    await git(f.mainRepo, "switch", "-q", "main")
    await git(f.mainRepo, "switch", "-qc", "issue/still-live")
    const liveHead = await commit(f.mainRepo, "live.txt")
    expect((await push(f, "issue/still-live:refs/heads/issue/still-live", env)).code).toBe(0)
    expect((await push(f, `${liveHead}:refs/yrd/submit/issue/still-live`, env)).code).toBe(0)

    // Simulate the queue's own merge for ONLY the first branch: advance
    // mainRepo's "main" to include mergedHead, so ITS submit becomes an
    // ancestor of main — "merged", per the model doc's own derivation, no
    // longer live. issue/still-live's submit is a sibling, never on main.
    await git(f.mainRepo, "switch", "-q", "main")
    await git(f.mainRepo, "merge", "-q", "--ff-only", "issue/merged-submit")

    const merged = await push(f, `${mergedHead}:refs/yrd/ignore/issue/merged-submit`, env)
    expect(merged.code, merged.stderr).toBe(0)
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/ignore/issue/merged-submit")).toBe(mergedHead)

    const stillLive = await push(f, `${liveHead}:refs/yrd/ignore/issue/still-live`, env)
    expect(stillLive.code).not.toBe(0)
    expect(stillLive.stderr).toContain("submitted work can never be hidden")
  })

  it("materializes birth classification atomically with the creation push itself — no drain() or intake anywhere in this test", async () => {
    const f = await fixture("auto-classify-atomic")
    await commitOnMain(f, ".yrd.yml", "checks: [typecheck]\n")
    const autoConfig = { ignore: ["task/wip-*"] }
    const env = await installHookHost(
      f.root,
      { "task/wip-atomic": target(f.baseSha) },
      undefined,
      undefined,
      autoConfig,
    )
    await git(f.mainRepo, "switch", "-qc", "task/wip-atomic")
    const headSha = await commit(f.mainRepo, "atomic.txt")
    const result = await push(f, "task/wip-atomic:refs/heads/task/wip-atomic", env)
    expect(result.code, result.stderr).toBe(0)
    // The classification is already materialized from the push alone: proves
    // it rides the post-receive step that accepts the branch-creation push,
    // not a later drain()/intake this test deliberately never calls.
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/ignore/task/wip-atomic")).toBe(headSha)
  })

  it("does not materialize a submit ref at creation when the new branch's tip is already an ancestor of the base — contrasted against a sibling with genuinely new content, neither using drain()", async () => {
    const f = await fixture("auto-submit-noop-creation")
    await commitOnMain(f, ".yrd.yml", "checks: [typecheck]\n")
    const autoConfig = { submit: ["task/straight-*"] }
    const env = await installHookHost(
      f.root,
      { "task/straight-old": target(f.baseSha), "task/straight-new": target(f.baseSha) },
      undefined,
      undefined,
      autoConfig,
    )
    // Created at EXACTLY main's own current tip (no new commit) — trivially
    // already an ancestor of main, the same "nothing left to submit" shape
    // validateSubmitRefValue refuses outright for a direct submit push. A
    // branch creation must never be refused for this — only silently skip
    // the classification write.
    await git(f.mainRepo, "switch", "-qc", "task/straight-old")
    expect((await push(f, "task/straight-old:refs/heads/task/straight-old", env)).code).toBe(0)

    // A sibling with genuinely NEW content, created from the same starting
    // point — the discriminating contrast: without it, "old gets nothing"
    // would be indistinguishable from "classification never ran at all"
    // (neither test call here goes through drain()/intake).
    await git(f.mainRepo, "switch", "-q", "main")
    await git(f.mainRepo, "switch", "-qc", "task/straight-new")
    const newHead = await commit(f.mainRepo, "new.txt")
    expect((await push(f, "task/straight-new:refs/heads/task/straight-new", env)).code).toBe(0)

    expect(await git(f.receiver.receiverPath, "for-each-ref", "refs/yrd/submit/task/straight-old")).toBe("")
    expect(await git(f.receiver.receiverPath, "rev-parse", "refs/yrd/submit/task/straight-new")).toBe(newHead)
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
