/**
 * @failure  `yrd issues <verb>` is the one reader of a project's issues declaration (bead 29644 slice R1; design
 *           issues-interface rev 6 § 4–§ 6, @cto ruling 0e9e794e). If it read the working tree, a seat's
 *           uncommitted edit would change what every caller runs; if it ignored a local origin, a worktree would
 *           run its own stale copy; if it shell-parsed a value, an issue title starting with `-` would become a
 *           provider option; and a misspelled verb or a write verb with no replay key would pass silently until
 *           the first caller needed it.
 * @level    l2 (temporary real Git repositories and a real provider process)
 * @testonly none
 * @consumer Yrd's issue reads (slice Y1, in-process) · Tent, staffing and tools through the CLI
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it } from "vitest"
import { runYrdProcess } from "../src/cli.ts"
import { runIssuesVerb } from "../src/issues/run.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const PROVIDER = resolve(import.meta.dirname, "support/fake-issues-provider.ts")
const BUN = process.execPath
const TMP = realpathSync(tmpdir())
const roots: string[] = []

afterAll(() => {
  for (const root of roots) safeRemoveSync(root, { within: TMP, allowedRoots: [TMP], allowMissing: true })
})

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-issues-")))
  roots.push(root)
  return root
}

/** YAML for a declaration: each verb maps to `bun <fake provider> <mode> ...rest`. JSON flow is valid YAML. */
function declare(verbs: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(verbs)
    .map(([verb, argv]) => `${verb}: ${JSON.stringify(argv)}`)
    .join("\n")
    .concat("\n")
}

const provider = (mode: string, ...rest: string[]): string[] => [BUN, PROVIDER, mode, ...rest]

/** A one-repository project whose `main` commits the given files. */
function project(files: Readonly<Record<string, string>>, dir = join(scratch(), "project")): string {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "--quiet", "--initial-branch=main")
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text)
  git(dir, "add", "-A")
  git(dir, "commit", "--quiet", "-m", "seed")
  return dir
}

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string }>

type Envelope = Readonly<{
  declaration: Readonly<{ repository: string; commit: string; path: string }>
  verb: string
  result: unknown
}>

const envelopeOf = (ran: Ran): Envelope => JSON.parse(ran.stdout) as Envelope

async function yrd(cwd: string, ...args: string[]): Promise<Ran> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    color: false,
    cwd,
    stderr(text) {
      stderr += text
    },
    stdout(text) {
      stdout += text
    },
  }
  const exitCode = await runYrdProcess([BUN, "/usr/local/bin/yrd", ...args], io)
  return { exitCode, stdout, stderr }
}

const ALL_READS = { view: provider("json", "<key>"), list: provider("json") }

describe("yrd issues", () => {
  it("view prints one envelope naming the root and main's commit (rules: discovery, envelope)", async () => {
    const root = project({ "issues.yml": declare(ALL_READS) })
    const ran = await yrd(root, "issues", "view", "29644")
    expect(ran.exitCode, ran.stderr).toBe(0)
    expect(ran.stdout.endsWith("\n")).toBe(true)
    expect(ran.stdout.trimEnd().split("\n")).toHaveLength(1)
    expect(envelopeOf(ran)).toEqual({
      declaration: { repository: root, commit: git(root, "rev-parse", "main"), path: "issues.yml" },
      verb: "view",
      result: { argv: ["29644"] },
    })
    // The provider's stderr passes through; stdout carries only the envelope.
    expect(ran.stderr).toContain("fake provider: applied")
  })

  it("reads the committed declaration, never the working tree (rule: commit read, no working-tree read)", async () => {
    const root = project({ "issues.yml": declare(ALL_READS) })
    writeFileSync(join(root, "issues.yml"), declare({ view: provider("text", "<key>") }))
    const ran = await yrd(root, "issues", "view", "k")
    expect(ran.exitCode, ran.stderr).toBe(0)
    expect(envelopeOf(ran).result).toEqual({ argv: ["k"] })
  })

  it.each([
    ["an absolute path", (path: string) => path],
    ["a file:// URL", (path: string) => pathToFileURL(path).href],
  ])("reads a local origin named by %s, and names it (rule: origin-local resolution)", async (_label, spell) => {
    const base = scratch()
    const seed = project(
      { "issues.yml": declare({ view: provider("json", "from-origin", "<key>") }) },
      join(base, "seed"),
    )
    const bare = join(base, "origin.git")
    git(base, "clone", "--quiet", "--bare", seed, bare)
    const root = project(
      { "issues.yml": declare({ view: provider("json", "from-root", "<key>") }) },
      join(base, "root"),
    )
    git(root, "remote", "add", "origin", spell(bare))
    const ran = await yrd(root, "issues", "view", "k")
    expect(ran.exitCode, ran.stderr).toBe(0)
    const envelope = envelopeOf(ran)
    expect(envelope.declaration).toEqual({
      repository: bare,
      commit: git(bare, "rev-parse", "main"),
      path: "issues.yml",
    })
    expect(envelope.result).toEqual({ argv: ["from-origin", "k"] })
  })

  it("refuses an unknown top-level key by name, listing the verbs (rule: keys are verbs)", async () => {
    const root = project({ "issues.yml": declare({ ...ALL_READS, veiw: provider("json") }) })
    const ran = await yrd(root, "issues", "view", "k")
    expect(ran.exitCode).toBe(1)
    expect(ran.stdout).toBe("")
    expect(ran.stderr).toContain("yrd-issues-declaration-invalid")
    expect(ran.stderr).toContain('"veiw"')
    expect(ran.stderr).toContain("view, list, create, comment, close, reopen, assign, unassign")
  })

  it("refuses a write verb without <id>, even when another verb is called (rule: writes carry <id>)", async () => {
    const root = project({ "issues.yml": declare({ ...ALL_READS, comment: provider("json", "<key>", "<text>") }) })
    const ran = await yrd(root, "issues", "view", "k")
    expect(ran.exitCode).toBe(1)
    expect(ran.stderr).toContain("write verb comment lacks <id>; add <id> where the provider takes its replay key")
  })

  it("refuses a placeholder the verb does not take, and one embedded in an element (rule: whole-element placeholders)", async () => {
    const wrong = project({ "issues.yml": declare({ view: provider("json", "<key>", "<seat>") }) })
    const wrongRan = await yrd(wrong, "issues", "view", "k")
    expect(wrongRan.exitCode).toBe(1)
    expect(wrongRan.stderr).toContain("view carries placeholder <seat>, which view does not take")
    const embedded = project({ "issues.yml": declare({ reopen: provider("json", "<key>", "--id=<id>") }) })
    const embeddedRan = await yrd(embedded, "issues", "view", "k")
    expect(embeddedRan.exitCode).toBe(1)
    expect(embeddedRan.stderr).toContain('reopen element "--id=<id>" embeds <id>')
  })

  it("fails loudly for a verb the file does not declare (rule: absent verb is unsupported)", async () => {
    const root = project({ "issues.yml": declare({ view: provider("json", "<key>") }) })
    const ran = await yrd(root, "issues", "list")
    expect(ran.exitCode).toBe(1)
    expect(ran.stderr).toContain(
      `list is not declared in ${root}@${git(root, "rev-parse", "main")}:issues.yml (unsupported)`,
    )
  })

  it("names <repository>@<commit>:issues.yml when the file is absent (rule: missing declaration)", async () => {
    const root = project({ "README.md": "no declaration\n" })
    const ran = await yrd(root, "issues", "list")
    expect(ran.exitCode).toBe(1)
    expect(ran.stderr).toContain(`yrd-issues-declaration-missing: ${root}@${git(root, "rev-parse", "main")}:issues.yml`)
  })

  it("refuses outside a repository naming the cwd, and honours --project-root from there (rule: discovery)", async () => {
    const outside = scratch()
    const refused = await yrd(outside, "issues", "list")
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain(`yrd-issues-not-a-repository: ${outside}`)
    const root = project({ "issues.yml": declare(ALL_READS) })
    const ran = await yrd(outside, "issues", "list", "--project-root", root)
    expect(ran.exitCode, ran.stderr).toBe(0)
    expect(envelopeOf(ran).declaration.repository).toBe(root)
  })

  it("names the command when the provider is not installed (rule: ENOENT)", async () => {
    const root = project({ "issues.yml": declare({ list: ["yrd-issues-no-such-provider", "list"] }) })
    const ran = await yrd(root, "issues", "list")
    expect(ran.exitCode).toBe(1)
    expect(ran.stderr).toContain("yrd-issues-provider-missing: list yrd-issues-no-such-provider list")
  })

  it("fails naming verb, command and exit code when stdout is not JSON (rule: stdout is JSON)", async () => {
    const root = project({ "issues.yml": declare({ list: provider("text") }) })
    const ran = await yrd(root, "issues", "list")
    expect(ran.exitCode).toBe(1)
    expect(ran.stdout).toBe("")
    expect(ran.stderr).toContain(`yrd-issues-provider-not-json: list ${BUN} ${PROVIDER} text: exit 0`)
  })

  it("fails naming verb, command and exit code when the provider exits non-zero (rule: provider failure)", async () => {
    const root = project({ "issues.yml": declare({ list: provider("exit3") }) })
    const ran = await yrd(root, "issues", "list")
    expect(ran.exitCode).toBe(1)
    expect(ran.stderr).toContain("fake provider refused")
    expect(ran.stderr).toContain(
      `yrd-issues-provider-failed: list ${BUN} ${PROVIDER} exit3: provider ended with exit 3`,
    )
  })

  it("refuses a close reason outside completed|not-planned with exit 2 (rule: bad arguments)", async () => {
    const root = project({ "issues.yml": declare({ close: provider("json", "<key>", "<reason>", "<id>") }) })
    const ran = await yrd(root, "issues", "close", "k", "drop", "--id", "ev1")
    expect(ran.exitCode).toBe(2)
    expect(ran.stderr).toContain("reason must be completed or not-planned")
  })

  it("refuses a write verb without --id with exit 2, naming it (rule: bad arguments)", async () => {
    const root = project({ "issues.yml": declare({ reopen: provider("json", "<key>", "<id>") }) })
    const ran = await yrd(root, "issues", "reopen", "k")
    expect(ran.exitCode).toBe(2)
    expect(ran.stderr).toContain("--id <id> is required")
  })

  it("refuses a missing operand and --id on a read with exit 2 (rule: bad arguments)", async () => {
    const root = project({ "issues.yml": declare(ALL_READS) })
    expect((await yrd(root, "issues", "view")).exitCode).toBe(2)
    expect((await yrd(root, "issues", "view", "k", "--id", "x")).exitCode).toBe(2)
  })

  it("keeps a value with spaces and a leading - as one argv element (rule: one placeholder, one element)", async () => {
    const root = project({ "issues.yml": declare({ comment: provider("json", "<key>", "--text", "<text>", "<id>") }) })
    const ran = await yrd(root, "issues", "comment", "--id", "ev 1", "k", "--", "-rf $HOME; echo hi")
    expect(ran.exitCode, ran.stderr).toBe(0)
    expect(envelopeOf(ran).result).toEqual({ argv: ["k", "--text", "-rf $HOME; echo hi", "ev 1"] })
  })

  it("kills a provider past the in-process timeout and names it (rule: bounded in-process call)", async () => {
    const root = project({ "issues.yml": declare({ list: provider("sleep") }) })
    const outcome = await runIssuesVerb({ verb: "list", args: [], cwd: root, timeoutMs: 300, stderr: () => {} })
    expect(outcome).toMatchObject({ ok: false, exitCode: 1, code: "yrd-issues-provider-timed-out" })
  })
})
