import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

/**
 * The exit criterion, end to end at the process level (bead: "one worker runs
 * new → commit → push → merged with zero integration balls"): a real repo, the
 * real CLI via a `git-bay` PATH shim (so `git bay` works), a real push through
 * the bay-owned repo's pre/post-receive hooks.
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

async function makeFixture(prefix: string): Promise<{ root: string; demo: string; env: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const demo = join(root, "demo")

  // PATH shim: `git bay ...` dispatches to `git-bay` on PATH.
  const shimDir = join(root, "shim")
  await must(["mkdir", "-p", shimDir], root, {})
  const shim = join(shimDir, "git-bay")
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, "utf8")
  await chmod(shim, 0o755)

  const env = {
    PATH: `${shimDir}:${process.env.PATH}`,
    NO_COLOR: "1", // plain help/error text for assertions
    BAY_ACTOR: "tester",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  }

  await must(["git", "init", "-q", "-b", "main", demo], root, env)
  await must(["git", "-C", demo, "commit", "-qm", "init", "--allow-empty"], root, env)
  return { root, demo, env }
}

describe("git bay CLI — happy path (process-level)", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-cli-"))
    await must(["git", "-C", demo, "config", "bay.check", "true"], root, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("init → new → commit → push → merged → ls → doors closed", async () => {
    const init = await must(["git", "bay", "init"], demo, env)
    expect(init.stdout).toContain("bay: initialized (store: sqlite, journal: .git/bay/journal.jsonl)")

    const opened = await must(["git", "bay", "new", "fix-readme"], demo, env)
    const wtPath = opened.stdout.trim()
    expect(wtPath).toContain(".bays/wt1")

    const ls = await must(["git", "bay", "ls"], wtPath, env)
    expect(ls.stdout).toMatch(/WORKTREE\s+NAME\s+STATE\s+AGE\s+IDLE/)
    expect(ls.stdout).toMatch(/wt1\s+fix-readme\s+open\s+\d+s\s+\d+s\s+← you/)

    await writeFile(join(wtPath, "README.md"), "hello\n", "utf8")
    await must(["git", "-C", wtPath, "add", "README.md"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "docs: add readme"], wtPath, env)

    const push = await must(["git", "-C", wtPath, "push", "-o", "wait"], wtPath, env)
    const remote = push.stderr // git relays hook output on stderr as "remote: ..."
    expect(remote).toMatch(/remote: bay: PR1 received — checks running/)
    expect(remote).toMatch(/remote: bay: PR1 merged onto main \(checks ✓\)/)

    // The mainline really moved.
    const log = await must(["git", "-C", demo, "log", "--oneline", "-2"], demo, env)
    expect(log.stdout).toContain("bay: merge PR1")

    // PR verdict line — by number AND by wt-id (dual addressing on ls).
    const one = await must(["git", "bay", "ls", "PR1"], demo, env)
    expect(one.stdout).toMatch(/^PR1 merged [0-9a-f]+ onto main \(checks: ✓\)/)

    // Doors closed: the worktree closed at merge; a re-push must refuse and teach.
    await must(["git", "-C", wtPath, "commit", "-qm", "wip", "--allow-empty"], wtPath, env)
    const again = await run(["git", "-C", wtPath, "push"], wtPath, env)
    expect(again.code).not.toBe(0)
    expect(again.stderr).toMatch(/remote: bay: doors closed — PR1 .* already merged/)
    expect(again.stderr).toContain("git bay new <name>")
  })

  it("a failing check rejects and teaches; retry-after-fix keeps the PR number", async () => {
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "config", "bay.check", "false"], demo, env) // always-red check
    const opened = await must(["git", "bay", "new", "red-then-green"], demo, env)
    const wtPath = opened.stdout.trim()

    await writeFile(join(wtPath, "f.txt"), "x\n", "utf8")
    await must(["git", "-C", wtPath, "add", "f.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: f"], wtPath, env)
    const push = await must(["git", "-C", wtPath, "push", "-o", "wait"], wtPath, env)
    expect(push.stderr).toMatch(/remote: bay: (PR\d+) rejected — check 'false' failed \(exit 1\)/)
    const id = push.stderr.match(/bay: (PR\d+) received/)![1]!

    // Fix the check (no new commit → nothing to push): retry is the resume
    // verb and re-runs the pipeline synchronously. Same PR number.
    await must(["git", "-C", demo, "config", "bay.check", "true"], demo, env)
    const again = await must(["git", "bay", "retry", id], wtPath, env)
    expect(again.stdout).toContain(`bay: ${id} received — checks running`)
    expect(again.stdout).toContain(`bay: ${id} merged onto main (checks ✓)`)

    // And a fix WITH a new commit resubmits through plain git push — the PR
    // keeps its number across the retry and the revision increments.
    await must(["git", "-C", demo, "config", "bay.check", "false"], demo, env)
    const opened2 = await must(["git", "bay", "new", "second"], demo, env)
    const wt2 = opened2.stdout.trim()
    await writeFile(join(wt2, "g.txt"), "y\n", "utf8")
    await must(["git", "-C", wt2, "add", "g.txt"], wt2, env)
    await must(["git", "-C", wt2, "commit", "-qm", "feat: g"], wt2, env)
    const red = await must(["git", "-C", wt2, "push", "-o", "wait"], wt2, env)
    expect(red.stderr).toMatch(/rejected — check 'false' failed/)
    const redId = red.stderr.match(/bay: (PR\d+) received/)![1]!

    await must(["git", "-C", demo, "config", "bay.check", "true"], demo, env)
    await must(["git", "-C", wt2, "commit", "-qm", "fix", "--allow-empty"], wt2, env)
    const green = await must(["git", "-C", wt2, "push", "-o", "wait"], wt2, env)
    expect(green.stderr).toContain(`remote: bay: ${redId} received — checks running`) // same number
    expect(green.stderr).toContain(`remote: bay: ${redId} merged onto main (checks ✓)`)

    // revision incremented on the re-push (same id, next revision).
    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as { prs: Record<string, { revision: number }> }
    expect(state.prs[redId]!.revision).toBe(2)
  })

  it("close on a dirty worktree refuses at the door — still open, then closes after cleanup (by name)", async () => {
    await must(["git", "bay", "init"], demo, env)
    const opened = await must(["git", "bay", "new", "dirty-close"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "scratch.txt"), "uncommitted\n", "utf8")

    const refuse = await run(["git", "bay", "close", "dirty-close"], demo, env)
    expect(refuse.code).toBe(1)
    expect(refuse.stderr).toContain("refusing to close wt1")
    expect(refuse.stderr).toContain("scratch.txt")
    expect(refuse.stderr).toContain("bay never deletes uncommitted work")

    // The refusal must happen BEFORE anything journals: the worktree is still
    // open and the table still shows it (journal-first would otherwise record
    // lease.ended and leave state and disk divergent).
    const after = await must(["git", "bay", "ls"], demo, env)
    expect(after.stdout).toContain("dirty-close")
    expect(after.stdout).toContain("open")

    // Clean up the scratch file — the SAME close (by wt-id this time) retires it.
    await must(["rm", join(wtPath, "scratch.txt")], demo, env)
    await must(["git", "bay", "close", "wt1"], demo, env)
    const final = await must(["git", "bay", "ls"], demo, env)
    expect(final.stdout).not.toContain("dirty-close")
    expect(final.stdout).toContain("no open worktrees")
  })

  it("new refuses a name that shadows a minted id (PR7 / wt3)", async () => {
    await must(["git", "bay", "init"], demo, env)
    for (const name of ["PR7", "pr7", "wt3", "WT3"]) {
      const res = await run(["git", "bay", "new", name], demo, env)
      expect(res.code, name).toBe(1)
      expect(res.stderr, name).toContain("looks like an id, not a name")
      expect(res.stderr, name).toContain("pick a descriptive name")
    }
  })
})

describe("git bay CLI — PR numbers are sequential and addressable by name", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-ids-"))
    await must(["git", "bay", "init"], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("two submits mint PR1 then PR2", async () => {
    await must(["git", "-C", demo, "branch", "task/a"], demo, env)
    await must(["git", "-C", demo, "branch", "task/b"], demo, env)
    const first = await must(["git", "bay", "submit", "task/a"], demo, env)
    expect(first.stdout.trim()).toBe("PR1")
    const second = await must(["git", "bay", "submit", "task/b"], demo, env)
    expect(second.stdout.trim()).toBe("PR2")
  })

  it("land by unique name resolves; land by ambiguous name refuses listing the candidates", async () => {
    await must(["git", "-C", demo, "branch", "b1"], demo, env)
    await must(["git", "-C", demo, "branch", "b2"], demo, env)
    await must(["git", "-C", demo, "branch", "b3"], demo, env)
    await must(["git", "bay", "submit", "b1", "--workitem", "dup"], demo, env) // PR1
    await must(["git", "bay", "submit", "b2", "--workitem", "dup"], demo, env) // PR2
    await must(["git", "bay", "submit", "b3", "--workitem", "uniq"], demo, env) // PR3

    const ambiguous = await run(["git", "bay", "land", "dup"], demo, env)
    expect(ambiguous.code).toBe(1)
    expect(ambiguous.stderr).toContain("'dup' is ambiguous")
    expect(ambiguous.stderr).toContain("PR1 (queued)")
    expect(ambiguous.stderr).toContain("PR2 (queued)")

    // Unique name lands exactly that PR (a red merge command still proves the
    // name resolved to PR3 — the verdict lines carry the number).
    const landed = await run(["git", "bay", "land", "uniq"], demo, { ...env, BAY_MERGE_COMMAND: "false" })
    expect(landed.stdout).toContain("bay: PR3 queued → merging")
    expect(landed.stdout).toContain("bay: PR3 merging → rejected — exit 1")

    const absent = await run(["git", "bay", "land", "no-such-name"], demo, env)
    expect(absent.code).toBe(1)
    expect(absent.stderr).toContain("bay: no PR or worktree named 'no-such-name'")
  })

  it("bare land with an empty queue says so instead of exiting silently", async () => {
    const res = await must(["git", "bay", "land"], demo, env)
    expect(res.stdout).toContain("bay: queue empty — nothing to land")
  })
})

describe("git bay CLI — bay.tracker validation at new", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-tracker-"))
    await must(["git", "bay", "init"], demo, env)
    const tracker = join(root, "tracker.sh")
    await writeFile(
      tracker,
      `#!/bin/sh\n[ "$1" = "good-name" ] && exit 0\necho "no such ticket: $1" >&2\nexit 3\n`,
      "utf8",
    )
    await chmod(tracker, 0o755)
    await must(["git", "-C", demo, "config", "bay.tracker", `${tracker} {name}`], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("a name the tracker accepts opens a worktree", async () => {
    const res = await must(["git", "bay", "new", "good-name"], demo, env)
    expect(res.stdout.trim()).toContain(".bays/wt1")
  })

  it("a name the tracker refuses is a teaching refusal carrying the tracker's stderr", async () => {
    const res = await run(["git", "bay", "new", "bogus-name"], demo, env)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("the tracker does not accept 'bogus-name'")
    expect(res.stderr).toContain("no such ticket: bogus-name")
    expect(res.stderr).toContain("git config bay.tracker none")
    const ls = await must(["git", "bay", "ls"], demo, env)
    expect(ls.stdout).toContain("no open worktrees") // nothing opened
  })

  it("bay.tracker none skips the check", async () => {
    await must(["git", "-C", demo, "config", "bay.tracker", "none"], demo, env)
    const res = await must(["git", "bay", "new", "anything-goes"], demo, env)
    expect(res.stdout.trim()).toContain(".bays/wt1")
  })
})

describe("git bay CLI — every pre-rename verb still works, unadvertised", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-alias-"))
    await must(["git", "bay", "init"], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("co / status / ping / abandon / enqueue / requeue / drain / prime resolve to the new verbs", async () => {
    // co → new (with the legacy --no-workitem spelling)
    const co = await must(["git", "bay", "co", "old-style", "--no-workitem"], demo, env)
    expect(co.stdout.trim()).toContain(".bays/wt1")
    // status → ls
    const status = await must(["git", "bay", "status"], demo, env)
    expect(status.stdout).toContain("wt1")
    expect(status.stdout).toContain("old-style")
    // ping → refresh (hidden verb, still addressable by wt-id)
    await must(["git", "bay", "ping", "wt1"], demo, env)
    // abandon → close
    await must(["git", "bay", "abandon", "wt1"], demo, env)
    expect((await must(["git", "bay", "status"], demo, env)).stdout).toContain("no open worktrees")
    // enqueue → submit
    await must(["git", "-C", demo, "branch", "task/legacy"], demo, env)
    const enq = await must(["git", "bay", "enqueue", "task/legacy"], demo, env)
    expect(enq.stdout.trim()).toBe("PR2") // PR1 was burned by the closed worktree
    // requeue → retry (teaching refusal proves the alias routes to retry)
    const requeue = await run(["git", "bay", "requeue", "PR99"], demo, env)
    expect(requeue.code).toBe(1)
    expect(requeue.stderr).toContain("bay: no PR or worktree named 'PR99'")
    // drain / merge → land
    const drain = await run(["git", "bay", "drain", "PR2"], demo, { ...env, BAY_MERGE_COMMAND: "false" })
    expect(drain.stdout).toContain("bay: PR2 queued → merging")
    const merge = await run(["git", "bay", "merge"], demo, env)
    expect(merge.stdout).toContain("bay: queue empty — nothing to land")
    // prime → guide
    const prime = await must(["git", "bay", "prime"], demo, env)
    expect(prime.stdout).toContain("git bay — local pull requests for this repository")
  })

  it("help advertises exactly one spelling per verb — no aliases anywhere", async () => {
    const help = await run(["git", "bay"], demo, env) // bare invocation prints help
    expect(help.code).toBe(0)
    for (const advertised of ["guide", "init", "new <name>", "close <wt|name>", "gc", "ls", "submit <branch|name>", "land", "retry <PR|name>", "audit"]) {
      expect(help.stdout, advertised).toContain(advertised)
    }
    for (const hidden of ["prime", "co", "checkout", "abandon", "return", "refresh", "ping", "status", "enqueue", "adopt", "merge", "drain", "requeue", "receive-pre", "receive-post"]) {
      expect(help.stdout, hidden).not.toMatch(new RegExp(`^\\s*${hidden}\\b`, "m"))
    }
    // and the per-command usage line advertises one spelling too
    const landHelp = await run(["git", "bay", "land", "-h"], demo, env)
    expect(landHelp.stdout).toContain("Usage: git bay land [options] [PR|name]")
    expect(landHelp.stdout).not.toContain("land|merge")
  })
})

describe("git bay CLI — flag hygiene (dogfood find: `enqueue --help` became a changeset)", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-flags-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("`submit --help` prints usage, exits 0, and opens NOTHING — even in an uninitialized repo", async () => {
    // No `git bay init` on purpose: help must never require (or create) state.
    const res = await run(["git", "bay", "submit", "--help"], demo, env)
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("Usage: git bay submit")
    const { existsSync } = await import("node:fs")
    expect(existsSync(join(demo, ".git", "bay"))).toBe(false)
  })

  it("`<verb> -h` works for every verb that reads a positional — new names and old aliases", async () => {
    for (const verb of ["new", "ls", "submit", "land", "retry", "close", "refresh", "co", "status", "enqueue", "requeue", "drain", "abandon", "ping"]) {
      const res = await run(["git", "bay", verb, "-h"], demo, env)
      expect(res.code, `${verb} -h`).toBe(0)
      expect(res.stdout, `${verb} -h`).toContain("Usage: git bay")
    }
  })

  it("an unknown flag is a teaching refusal, never a silent no-op or a positional", async () => {
    await must(["git", "bay", "init"], demo, env)
    // The silent-error case: a --watch typo must not fall through to a single land.
    const land = await run(["git", "bay", "land", "--wach"], demo, env)
    expect(land.code).toBe(1)
    expect(land.stderr).toContain("unknown option '--wach'")
    expect(land.stderr).toContain("(Did you mean --watch?)") // teaching: typo suggestion
    expect(land.stderr).toContain("Usage: git bay land")
    // The positional case: a flag-shaped token must never become a merge target.
    const sub = await run(["git", "bay", "submit", "--halp"], demo, env)
    expect(sub.code).toBe(1)
    expect(sub.stderr).toContain("unknown option '--halp'")
    const ls = await must(["git", "bay", "ls", "--json"], demo, env)
    expect(ls.stdout).not.toContain("PR1")
  })

  it("regression: bare `submit` still teaches that a target is required", async () => {
    await must(["git", "bay", "init"], demo, env)
    const res = await run(["git", "bay", "submit"], demo, env)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("missing required argument 'branch|name'")
    expect(res.stderr).toContain("Usage: git bay submit") // showHelpAfterError keeps it teaching
  })

  it("unadvertised prefixes resolve — `au` is audit, ambiguity teaches with the canonical names", async () => {
    await must(["git", "bay", "init"], demo, env)
    const audit = await must(["git", "bay", "au"], demo, env)
    expect(audit.stdout).toContain("bay: clean")
    const amb = await run(["git", "bay", "l"], demo, env)
    expect(amb.code).toBe(1)
    expect(amb.stderr).toContain("'l' is ambiguous")
    expect(amb.stderr).toContain("land, ls")
    // `st` (old status muscle memory) still resolves: status is a hidden alias
    // of ls and no other verb starts with "st".
    const st = await must(["git", "bay", "st"], demo, env)
    expect(st.stdout).toContain("no open worktrees")
    // A one-letter prefix spanning verbs refuses with CANONICAL names, never
    // alias spellings ("s" prefixes both submit and the status alias of ls).
    const s = await run(["git", "bay", "s"], demo, env)
    expect(s.code).toBe(1)
    expect(s.stderr).toContain("'s' is ambiguous")
    expect(s.stderr).toContain("ls, submit")
  })
})

describe("git bay CLI — state survives host hygiene (the 2026-07-07 .bay wipe incident)", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-state-"))
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
    const id = (await must(["git", "bay", "submit", "main"], demo, env)).stdout.trim()
    expect(id).toBe("PR1")

    // The hygiene sweep that wiped the hh pilot's first journal at 12:4x:
    // remove-untracked-and-ignored, forced, in the demo's own temp repo.
    const flags = "-" + ["x", "d", "f", "f"].join("")
    await must(["git", "-C", demo, "clean", flags], demo, env)

    const ls = await must(["git", "bay", "ls", id], demo, env)
    expect(ls.stdout).toContain(id) // state intact: the PR is still known
  })

  it("a missing/wiped bay teaches init instead of pretending to be empty", async () => {
    // No init: every state-reading verb must refuse loudly, not report a
    // healthy-looking empty bay (the silent-fallback failure mode).
    const ls = await run(["git", "bay", "ls"], demo, env)
    expect(ls.code).toBe(1)
    expect(ls.stderr).toContain("no bay state")
    expect(ls.stderr).toContain("git bay init")
  })

  it("a legacy <root>/.bay is still honored, with a migration warning", async () => {
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(demo, ".bay"), { recursive: true })
    await writeFile(join(demo, ".bay", "journal.jsonl"), "", "utf8")
    const ls = await run(["git", "bay", "ls"], demo, env)
    expect(ls.code).toBe(0)
    expect(ls.stderr).toContain("legacy")
    expect(ls.stderr).toContain(".bay")
  })

  it("submit refuses an unresolvable target at the door and suggests the near-miss branch", async () => {
    // The live-demo confusion: the user submitted a NAME; the real branch was
    // task/<name>. The old behavior queued it happily and let the merge worker
    // reject it minutes later.
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "branch", "task/demo-readme2"], demo, env)
    const res = await run(["git", "bay", "submit", "demo-readme2"], demo, env)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("does not resolve to a commit and no worktree carries that name")
    expect(res.stderr).toContain("Did you mean: task/demo-readme2")
    const ls = await must(["git", "bay", "ls", "--json"], demo, env)
    expect(ls.stdout).not.toContain("PR1") // nothing was queued
  })

  it("bare ls shows every non-merged PR — a rejected one is never invisible", async () => {
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "branch", "task/x"], demo, env)
    const id = (await must(["git", "bay", "submit", "task/x"], demo, env)).stdout.trim()
    await run(["git", "bay", "land"], demo, { ...env, BAY_MERGE_COMMAND: "false" })
    const ls = await must(["git", "bay", "ls"], demo, env)
    expect(ls.stdout).toContain(id)
    expect(ls.stdout).toContain("rejected")
    expect(ls.stdout).toContain("exit 1")
  })
})
