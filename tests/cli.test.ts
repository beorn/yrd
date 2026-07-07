import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

/**
 * The M1 exit criterion, end to end at the process level (bead:
 * "one worker runs co → commit → push → merged with zero integration balls"):
 * a real repo, the real CLI via a `git-bay` PATH shim (so `git bay` works),
 * a real push through the bay-owned repo's pre/post-receive hooks.
 */

const BIN = new URL("../bin/git-bay.ts", import.meta.url).pathname

type Run = { code: number; stdout: string; stderr: string }

async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<Run> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: { ...process.env, ...env } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function must(cmd: string[], cwd: string, env: Record<string, string>): Promise<Run> {
  const res = await run(cmd, cwd, env)
  if (res.code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${res.code})\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
  }
  return res
}

describe("git bay CLI — M1 happy path (process-level)", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bay-cli-"))
    demo = join(root, "demo")

    // PATH shim: `git bay ...` dispatches to `git-bay` on PATH.
    const shimDir = join(root, "shim")
    await must(["mkdir", "-p", shimDir], root, {})
    const shim = join(shimDir, "git-bay")
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, "utf8")
    await chmod(shim, 0o755)

    env = {
      PATH: `${shimDir}:${process.env.PATH}`,
      BAY_ACTOR: "tester",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    }

    await must(["git", "init", "-q", "-b", "main", demo], root, env)
    await must(["git", "-C", demo, "commit", "-qm", "init", "--allow-empty"], root, env)
    await must(["git", "-C", demo, "config", "bay.check", "true"], root, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("init → co → commit → push → merged → status → doors closed", async () => {
    const init = await must(["git", "bay", "init"], demo, env)
    expect(init.stdout).toContain("bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)")

    const co = await must(["git", "bay", "co", "fix-readme", "--no-workitem"], demo, env)
    const bayPath = co.stdout.trim()
    expect(bayPath).toContain(".bay")

    const status = await must(["git", "bay", "status"], bayPath, env)
    expect(status.stdout).toMatch(/BAY\s+WORKITEM\s+STATE\s+AGE/)
    expect(status.stdout).toMatch(/bay1\s+fix-readme\s+leased\s+\d+s\s+← you/)

    await writeFile(join(bayPath, "README.md"), "hello\n", "utf8")
    await must(["git", "-C", bayPath, "add", "README.md"], bayPath, env)
    await must(["git", "-C", bayPath, "commit", "-qm", "docs: add readme"], bayPath, env)

    const push = await must(["git", "-C", bayPath, "push", "-o", "wait"], bayPath, env)
    const remote = push.stderr // git relays hook output on stderr as "remote: ..."
    expect(remote).toMatch(/remote: bay: changeset C-\S+ received — checks running/)
    expect(remote).toMatch(/remote: bay: C-\S+ merged onto main \(checks ✓\)/)

    // The mainline really moved.
    const log = await must(["git", "-C", demo, "log", "--oneline", "-2"], demo, env)
    expect(log.stdout).toContain("bay: merge C-")

    // Changeset verdict line.
    const id = remote.match(/changeset (C-\S+) received/)![1]!
    const one = await must(["git", "bay", "status", id], demo, env)
    expect(one.stdout).toMatch(new RegExp(`${id} merged [0-9a-f]+ onto main \\(checks: ✓\\)`))

    // Doors closed: the loan ended at merge; a re-push must refuse and teach.
    await must(["git", "-C", bayPath, "commit", "-qm", "wip", "--allow-empty"], bayPath, env)
    const again = await run(["git", "-C", bayPath, "push"], bayPath, env)
    expect(again.code).not.toBe(0)
    expect(again.stderr).toMatch(/remote: bay: doors closed — changeset C-\S+ .* already merged/)
    expect(again.stderr).toContain("git bay co <workitem>")
  })

  it("a failing check rejects and teaches, and requeue-after-fix merges", async () => {
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "config", "bay.check", "false"], demo, env) // always-red check
    const co = await must(["git", "bay", "co", "red-then-green", "--no-workitem"], demo, env)
    const bayPath = co.stdout.trim()

    await writeFile(join(bayPath, "f.txt"), "x\n", "utf8")
    await must(["git", "-C", bayPath, "add", "f.txt"], bayPath, env)
    await must(["git", "-C", bayPath, "commit", "-qm", "feat: f"], bayPath, env)
    const push = await must(["git", "-C", bayPath, "push", "-o", "wait"], bayPath, env)
    expect(push.stderr).toMatch(/remote: bay: C-\S+ rejected — check 'false' failed \(exit 1\)/)

    // Fix the check (no new commit → nothing to push): requeue is the resume
    // verb and re-runs the pipeline synchronously.
    await must(["git", "-C", demo, "config", "bay.check", "true"], demo, env)
    const id = push.stderr.match(/changeset (C-\S+) received/)![1]!
    const again = await must(["git", "bay", "requeue", id], bayPath, env)
    expect(again.stdout).toMatch(/bay: C-\S+ merged onto main \(checks ✓\)/)

    // And a fix WITH a new commit resubmits through plain git push.
    await must(["git", "-C", demo, "config", "bay.check", "false"], demo, env)
    const co2 = await must(["git", "bay", "co", "second", "--no-workitem"], demo, env)
    const bay2 = co2.stdout.trim()
    await writeFile(join(bay2, "g.txt"), "y\n", "utf8")
    await must(["git", "-C", bay2, "add", "g.txt"], bay2, env)
    await must(["git", "-C", bay2, "commit", "-qm", "feat: g"], bay2, env)
    const red = await must(["git", "-C", bay2, "push", "-o", "wait"], bay2, env)
    expect(red.stderr).toMatch(/rejected — check 'false' failed/)
    await must(["git", "-C", demo, "config", "bay.check", "true"], demo, env)
    await must(["git", "-C", bay2, "commit", "-qm", "fix", "--allow-empty"], bay2, env)
    const green = await must(["git", "-C", bay2, "push", "-o", "wait"], bay2, env)
    expect(green.stderr).toMatch(/remote: bay: C-\S+ merged onto main \(checks ✓\)/)
  })

  it("abandon on a dirty bay refuses at the door — lease stays live, then succeeds after cleanup", async () => {
    await must(["git", "bay", "init"], demo, env)
    const co = await must(["git", "bay", "co", "dirty-abandon", "--no-workitem"], demo, env)
    const bayPath = co.stdout.trim()
    await writeFile(join(bayPath, "scratch.txt"), "uncommitted\n", "utf8")

    const status = await must(["git", "bay", "status", "--json"], demo, env)
    const lease = [...status.stdout.matchAll(/"(L\d+)":/g)].at(-1)![1]!

    const refuse = await run(["git", "bay", "abandon", lease], demo, env)
    expect(refuse.code).toBe(1)
    expect(refuse.stderr).toContain("scratch.txt")
    expect(refuse.stderr).toContain("bay never deletes uncommitted work")

    // The refusal must happen BEFORE anything journals: the lease is still
    // open and the bay table still shows it (journal-first would otherwise
    // record lease.ended and leave state and disk divergent).
    const after = await must(["git", "bay", "status"], demo, env)
    expect(after.stdout).toContain("dirty-abandon")
    expect(after.stdout).toContain("leased")

    // Clean up the scratch file — the SAME abandon now retires the bay.
    await must(["rm", join(bayPath, "scratch.txt")], demo, env)
    await must(["git", "bay", "abandon", lease], demo, env)
    const final = await must(["git", "bay", "status"], demo, env)
    expect(final.stdout).not.toContain("dirty-abandon")
  })
})

describe("git bay CLI — flag hygiene (dogfood find: `enqueue --help` became changeset C-5f086e7b)", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bay-flags-"))
    demo = join(root, "demo")
    const shimDir = join(root, "shim")
    await must(["mkdir", "-p", shimDir], root, {})
    const shim = join(shimDir, "git-bay")
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, "utf8")
    await chmod(shim, 0o755)
    env = {
      PATH: `${shimDir}:${process.env.PATH}`,
      BAY_ACTOR: "tester",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    }
    await must(["git", "init", "-q", "-b", "main", demo], root, env)
    await must(["git", "-C", demo, "commit", "-qm", "init", "--allow-empty"], root, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("`enqueue --help` prints usage, exits 0, and enqueues NOTHING — even in an uninitialized repo", async () => {
    // No `git bay init` on purpose: help must never require (or create) state.
    const res = await run(["git", "bay", "enqueue", "--help"], demo, env)
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("usage: git bay")
    const { existsSync } = await import("node:fs")
    expect(existsSync(join(demo, ".bay"))).toBe(false)
  })

  it("`<verb> -h` works for every verb that reads a positional", async () => {
    for (const verb of ["co", "status", "enqueue", "requeue", "drain", "abandon", "adopt", "ping"]) {
      const res = await run(["git", "bay", verb, "-h"], demo, env)
      expect(res.code, `${verb} -h`).toBe(0)
      expect(res.stdout, `${verb} -h`).toContain("usage: git bay")
    }
  })

  it("an unknown flag is a teaching refusal, never a silent no-op or a positional", async () => {
    await must(["git", "bay", "init"], demo, env)
    // The silent-error case: a --watch typo must not fall through to a single drain.
    const drain = await run(["git", "bay", "drain", "--wach"], demo, env)
    expect(drain.code).toBe(1)
    expect(drain.stderr).toContain("unknown flag '--wach'")
    expect(drain.stderr).toContain("usage: git bay")
    // The positional case: a flag-shaped token must never become a merge target.
    const enq = await run(["git", "bay", "enqueue", "--halp"], demo, env)
    expect(enq.code).toBe(1)
    expect(enq.stderr).toContain("unknown flag '--halp'")
    const status = await must(["git", "bay", "status", "--json"], demo, env)
    expect(status.stdout).not.toContain("C-")
  })

  it("regression: bare `enqueue` still teaches that a target is required", async () => {
    await must(["git", "bay", "init"], demo, env)
    const res = await run(["git", "bay", "enqueue"], demo, env)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("a target (branch or SHA) is required")
  })
})

describe("git bay CLI — state survives host hygiene (the 2026-07-07 .bay wipe incident)", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bay-state-"))
    demo = join(root, "demo")
    const shimDir = join(root, "shim")
    await must(["mkdir", "-p", shimDir], root, {})
    const shim = join(shimDir, "git-bay")
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, "utf8")
    await chmod(shim, 0o755)
    env = {
      PATH: `${shimDir}:${process.env.PATH}`,
      BAY_ACTOR: "tester",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    }
    await must(["git", "init", "-q", "-b", "main", demo], root, env)
    await must(["git", "-C", demo, "commit", "-qm", "init", "--allow-empty"], root, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("init puts state inside the git dir, not the working tree", async () => {
    const { existsSync } = await import("node:fs")
    const init = await must(["git", "bay", "init"], demo, env)
    expect(init.stdout).toContain("journal: .git/bay/journal.jsonl")
    expect(existsSync(join(demo, ".git", "bay", "journal.jsonl"))).toBe(true)
    expect(existsSync(join(demo, ".bay"))).toBe(false)
  })

  it("a hygiene clean sweep cannot delete the journal — the exact production incident", async () => {
    await must(["git", "bay", "init"], demo, env)
    const id = (await must(["git", "bay", "enqueue", "main"], demo, env)).stdout.trim()
    expect(id).toMatch(/^C-/)

    // The hygiene sweep that wiped the hh pilot's first journal at 12:4x:
    // remove-untracked-and-ignored, forced, in the demo's own temp repo.
    const flags = "-" + ["x", "d", "f", "f"].join("")
    await must(["git", "-C", demo, "clean", flags], demo, env)

    const status = await must(["git", "bay", "status", id], demo, env)
    expect(status.stdout).toContain(id) // state intact: the changeset is still known
  })

  it("a missing/wiped bay teaches init instead of pretending to be empty", async () => {
    // No init: every state-reading verb must refuse loudly, not report a
    // healthy-looking empty bay (the silent-fallback failure mode).
    const status = await run(["git", "bay", "status"], demo, env)
    expect(status.code).toBe(1)
    expect(status.stderr).toContain("no bay state")
    expect(status.stderr).toContain("git bay init")
  })

  it("a legacy <root>/.bay is still honored, with a migration warning", async () => {
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(demo, ".bay"), { recursive: true })
    await writeFile(join(demo, ".bay", "journal.jsonl"), "", "utf8")
    const status = await run(["git", "bay", "status"], demo, env)
    expect(status.code).toBe(0)
    expect(status.stderr).toContain("legacy")
    expect(status.stderr).toContain(".bay")
  })
})
