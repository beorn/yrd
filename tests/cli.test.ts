import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"

/**
 * The exit criterion, end to end at the process level (bead: "one worker runs
 * new → commit → push → merged with zero integration balls"): a real repo, the
 * real CLI via a `git-bay` PATH shim (so `git bay` works), a real push through
 * the bay-owned repo's pre/post-receive hooks.
 */

const GIT_BAY_BIN = new URL("../bin/git-bay", import.meta.url).pathname
const YRD_BIN = new URL("../bin/yrd", import.meta.url).pathname
const PROCESS_TEST_TIMEOUT_MS = 15_000

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

async function runUntilOutput(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  pattern: RegExp,
  timeoutMs = PROCESS_TEST_TIMEOUT_MS,
): Promise<Run> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: { ...process.env, ...env } })
    let stdout = ""
    let stderr = ""
    let matched = false
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`${cmd.join(" ")} did not print ${pattern} within ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, timeoutMs)
    const observe = (): void => {
      if (!matched && pattern.test(`${stdout}\n${stderr}`)) {
        matched = true
        child.kill("SIGTERM")
      }
    }
    child.stdout.on("data", (c) => {
      stdout += c
      observe()
    })
    child.stderr.on("data", (c) => {
      stderr += c
      observe()
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (!matched) {
        reject(new Error(`${cmd.join(" ")} exited before printing ${pattern}\nstdout: ${stdout}\nstderr: ${stderr}`))
        return
      }
      resolve({ code: code ?? -1, stdout, stderr })
    })
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
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${GIT_BAY_BIN}" "$@"\n`, "utf8")
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

async function branchWithFiles(
  repo: string,
  env: Record<string, string>,
  branch: string,
  files: Record<string, string>,
): Promise<void> {
  await must(["git", "-C", repo, "switch", "-qc", branch, "main"], repo, env)
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body, "utf8")
  }
  await must(["git", "-C", repo, "add", "-A"], repo, env)
  await must(["git", "-C", repo, "commit", "-qm", branch], repo, env)
  await must(["git", "-C", repo, "switch", "-q", "main"], repo, env)
}

async function openBranchAsSubmittedPr(repo: string, env: Record<string, string>, branch: string, name: string): Promise<string> {
  const opened = await must(["git", "bay", "open", name, "--from", branch], repo, env)
  const wtPath = opened.stdout.trim()
  await must(["git", "-C", wtPath, "push"], wtPath, env)
  const ls = await must(["git", "bay", "ls", name, "--json"], repo, env)
  const data = JSON.parse(ls.stdout) as { pr: { id: string } }
  await must(["git", "bay", "submit", name], repo, env)
  return data.pr.id
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
    expect(init.stdout).toContain("bay: initialized (store: sqlite, events: .git/bay/events.jsonl)")

    const opened = await must(["git", "bay", "open", "fix-readme"], demo, env)
    const wtPath = opened.stdout.trim()
    expect(wtPath).toContain(".bays/wt1")

    const ls = await must(["git", "bay", "ls"], wtPath, env)
    expect(ls.stdout).toMatch(/WORKTREE\s+BAY\s+STATE\s+AGE\s+IDLE/)
    expect(ls.stdout).toMatch(/wt1\s+fix-readme\s+active\s+\d+s\s+\d+s\s+← you/)

    await writeFile(join(wtPath, "README.md"), "hello\n", "utf8")
    await must(["git", "-C", wtPath, "add", "README.md"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "docs: add readme"], wtPath, env)

    // -o wait fuses create+submit+pipeline in one push — the happy path's
    // whole point is "push and the PR lands", so this test uses the fused
    // form; the two-step (bare push, then `git bay submit`) flow is its own
    // describe block below.
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
    expect(again.stderr).toContain("git bay open <name>")
  })

  it("a failing check rejects and teaches; retry-after-fix keeps the PR number", async () => {
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "config", "bay.check", "false"], demo, env) // always-red check
    const opened = await must(["git", "bay", "open", "red-then-green"], demo, env)
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
    const opened2 = await must(["git", "bay", "open", "second"], demo, env)
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
  }, PROCESS_TEST_TIMEOUT_MS)

  it("close on a dirty worktree refuses at the door — still open, then closes after cleanup (by name)", async () => {
    await must(["git", "bay", "init"], demo, env)
    const opened = await must(["git", "bay", "open", "dirty-close"], demo, env)
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
    expect(after.stdout).toContain("active")

    // Clean up the scratch file — the SAME close (by wt-id this time) retires it.
    await must(["rm", join(wtPath, "scratch.txt")], demo, env)
    await must(["git", "bay", "close", "wt1"], demo, env)
    const final = await must(["git", "bay", "ls"], demo, env)
    expect(final.stdout).not.toContain("dirty-close")
    expect(final.stdout).toContain("no open worktrees")
  })

  it("open refuses a name that shadows a minted id (PR7 / wt3)", async () => {
    await must(["git", "bay", "init"], demo, env)
    for (const name of ["PR7", "pr7", "wt3", "WT3"]) {
      const res = await run(["git", "bay", "open", name], demo, env)
      expect(res.code, name).toBe(1)
      expect(res.stderr, name).toContain("looks like an id, not a name")
      expect(res.stderr, name).toContain("pick a descriptive name")
    }
  })

  it("open --from attaches a bay name to an existing source branch", async () => {
    await must(["git", "bay", "init"], demo, env)
    await branchWithFiles(demo, env, "task/existing", { "legacy.txt": "old\n" })

    const opened = await must(["git", "bay", "open", "repair-existing", "--from", "task/existing"], demo, env)
    const wtPath = opened.stdout.trim()
    expect((await must(["git", "-C", wtPath, "branch", "--show-current"], wtPath, env)).stdout.trim()).toBe("task/existing")
    expect(await readFile(join(wtPath, "legacy.txt"), "utf8")).toBe("old\n")

    await writeFile(join(wtPath, "repair.txt"), "fixed\n", "utf8")
    await must(["git", "-C", wtPath, "add", "repair.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "fix: repair existing"], wtPath, env)
    const pushed = await must(["git", "-C", wtPath, "push"], wtPath, env)
    expect(pushed.stderr).toContain("remote: bay: PR1 opened — git bay submit PR1 when ready")

    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as {
      leases: Record<string, { workitem: string | null; branch: string; changeId: string }>
      prs: Record<string, { name: string | null; state: string }>
      line: { items: { pr: string; target: string }[] }
    }
    const lease = Object.values(state.leases)[0]!
    expect(lease).toMatchObject({ workitem: "repair-existing", branch: "task/existing", changeId: "PR1" })
    expect(state.prs.PR1).toMatchObject({ name: "repair-existing", state: "pushed" })
  })

  it("open --from refuses missing or already-tracked source branches before opening a bay", async () => {
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "branch", "task/near-miss"], demo, env)
    await must(["git", "-C", demo, "branch", "task/other"], demo, env)

    const mismatch = await run(["git", "bay", "open", "bad-head", "--from", "task/near-miss", "--head", "task/other"], demo, env)
    expect(mismatch.code).toBe(1)
    expect(mismatch.stderr).toContain("--from and --head name different branches")

    const missing = await run(["git", "bay", "open", "missing", "--from", "near"], demo, env)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("--from 'near' is not a local branch")
    expect(missing.stderr).toContain("Did you mean: task/near-miss")

    await branchWithFiles(demo, env, "task/tracked", { "tracked.txt": "tracked\n" })
    await must(["git", "bay", "submit", "task/tracked"], demo, env)
    const tracked = await run(["git", "bay", "open", "tracked-again", "--from", "task/tracked"], demo, env)
    expect(tracked.code).toBe(1)
    expect(tracked.stderr).toContain("'task/tracked' is already tracked by PR1")

    const ls = await must(["git", "bay", "ls"], demo, env)
    expect(ls.stdout).toContain("no open worktrees")
  })
})

describe("git bay CLI — PR numbers are sequential and addressable by name", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-ids-"))
    await must(["git", "bay", "init"], demo, env)
    // This block exercises submit/check/merge/integrate as separate atomic
    // steps, so autoMerge is off — otherwise submit's own default
    // auto-integrate would race ahead of the manual steps under test.
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("two adopts mint PR1 then PR2", async () => {
    await must(["git", "-C", demo, "branch", "task/a"], demo, env)
    await must(["git", "-C", demo, "branch", "task/b"], demo, env)
    const first = await must(["git", "bay", "adopt", "task/a"], demo, env)
    expect(first.stdout.trim()).toBe("PR1")
    const second = await must(["git", "bay", "adopt", "task/b"], demo, env)
    expect(second.stdout.trim()).toBe("PR2")
  })

  it("integrate by unique name resolves; integrate by ambiguous name refuses listing the candidates", async () => {
    await must(["git", "-C", demo, "branch", "b1"], demo, env)
    await must(["git", "-C", demo, "branch", "b2"], demo, env)
    await must(["git", "-C", demo, "branch", "b3"], demo, env)
    await must(["git", "bay", "adopt", "b1", "--workitem", "dup"], demo, env) // PR1, pushed
    await must(["git", "bay", "adopt", "b2", "--workitem", "dup"], demo, env) // PR2, pushed
    await must(["git", "bay", "adopt", "b3", "--workitem", "uniq"], demo, env) // PR3, pushed
    // submit (ask to merge) is what makes them visible to integrate.
    await must(["git", "bay", "submit", "PR1"], demo, env)
    await must(["git", "bay", "submit", "PR2"], demo, env)
    await must(["git", "bay", "submit", "PR3"], demo, env)

    const ambiguous = await run(["git", "bay", "integrate", "dup"], demo, env)
    expect(ambiguous.code).toBe(1)
    expect(ambiguous.stderr).toContain("'dup' is ambiguous")
    expect(ambiguous.stderr).toContain("PR1 (submitted)")
    expect(ambiguous.stderr).toContain("PR2 (submitted)")

    // Unique name integrates exactly that PR (a red merge command still proves
    // the name resolved to PR3 — the verdict lines carry the number). No
    // bay.check configured in this block, so the check half auto-passes.
    const integrated = await run(["git", "bay", "integrate", "uniq"], demo, { ...env, BAY_MERGE: "false" })
    expect(integrated.stdout).toContain("bay: PR3 submitted → checking")
    expect(integrated.stdout).toContain("bay: PR3 checking → checked")
    expect(integrated.stdout).toContain("bay: PR3 checked → merging")
    expect(integrated.stdout).toContain("bay: PR3 merging → rejected — exit 1")

    const absent = await run(["git", "bay", "integrate", "no-such-name"], demo, env)
    expect(absent.code).toBe(1)
    expect(absent.stderr).toContain("bay: no PR or worktree named 'no-such-name'")
  })

  it("bare integrate with an empty queue says so instead of exiting silently", async () => {
    const res = await must(["git", "bay", "integrate"], demo, env)
    expect(res.stdout).toContain("bay: queue empty — nothing to integrate")
  })

  it("check then merge, atomically, lands the same PR as one integrate call", async () => {
    await must(["git", "-C", demo, "branch", "task/atomic"], demo, env)
    const id = (await must(["git", "bay", "adopt", "task/atomic"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", id], demo, env)

    const checked = await must(["git", "bay", "check", id], demo, env)
    expect(checked.stdout).toContain(`bay: ${id} submitted → checking`)
    expect(checked.stdout).toContain(`bay: ${id} checking → checked`)
    const json1 = await must(["git", "bay", "ls", "--json"], demo, env)
    expect((JSON.parse(json1.stdout) as { prs: Record<string, { state: string }> }).prs[id]!.state).toBe("checked")

    // merge refuses a not-yet-checked PR, and check refuses an already-checked one.
    await must(["git", "-C", demo, "branch", "task/not-checked"], demo, env)
    const id2 = (await must(["git", "bay", "adopt", "task/not-checked"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", id2], demo, env)
    const earlyMerge = await run(["git", "bay", "merge", id2], demo, env)
    expect(earlyMerge.code).toBe(1)
    expect(earlyMerge.stderr).toContain(`${id2} hasn't been checked yet`)
    const doubleCheck = await run(["git", "bay", "check", id], demo, env)
    expect(doubleCheck.code).toBe(1)
    expect(doubleCheck.stderr).toContain(`${id} is already checked`)

    const merged = await must(["git", "bay", "merge", id], demo, { ...env, BAY_MERGE: "true" })
    expect(merged.stdout).toContain(`bay: ${id} checked → merging`)
    expect(merged.stdout).toContain(`bay: ${id} merging → merged`)
    const json2 = await must(["git", "bay", "ls", "--json"], demo, env)
    expect((JSON.parse(json2.stdout) as { prs: Record<string, { state: string }> }).prs[id]!.state).toBe("merged")
  })
})

describe("yrd CLI — line projection", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("yrd-line-"))
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "config", "bay.check", "true"], demo, env)
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("line status marks stale checks and merge rejects them", async () => {
    await must(
      [
        "git",
        "-C",
        demo,
        "config",
        "bay.check",
        "printf 'check stdout\\n'; printf 'check stderr\\n' >&2",
      ],
      demo,
      env,
    )
    await branchWithFiles(demo, env, "task/line-work", { "line.txt": "ok\n" })
    const adopted = await must(["git", "bay", "adopt", "task/line-work", "--workitem", "line-work"], demo, env)
    const pr = adopted.stdout.trim()
    await must(["git", "bay", "submit", pr], demo, env)

    const checked = await must([process.execPath, YRD_BIN, "line", "integrate", pr, "--steps", "check"], demo, env)
    expect(checked.stdout).toContain(`bay: ${pr} submitted → checking`)
    expect(checked.stdout).toContain(`bay: ${pr} checking → checked`)

    const lineStatus = await must([process.execPath, YRD_BIN, "line", "status", "--json"], demo, env)
    const line = JSON.parse(lineStatus.stdout) as {
      line: {
        items: {
          pr: string
          state: string
          stale: boolean
          staleReasons: string[]
          steps: { check?: { ok: boolean; baseSha?: string; headSha?: string; artifacts?: unknown[] } }
        }[]
      }
    }
    const lineItem = line.line.items.find((item) => item.pr === pr)!
    expect(lineItem.state).toBe("checked")
    expect(lineItem.stale).toBe(false)
    expect(lineItem.steps.check).toMatchObject({ ok: true })
    expect(lineItem.steps.check?.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(lineItem.steps.check?.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(lineItem.steps.check?.artifacts).toHaveLength(2)

    const humanStatus = await must([process.execPath, YRD_BIN, "line", "status"], demo, env)
    expect(humanStatus.stdout).toContain("line ")
    expect(humanStatus.stdout).toContain("@")
    expect(humanStatus.stdout).toContain(`${pr} checked target=`)
    expect(humanStatus.stdout).toContain("check=ok")
    expect(humanStatus.stdout).toContain("merge=-")

    await must(["git", "-C", demo, "commit", "-qm", "base move", "--allow-empty"], demo, env)
    const staleStatus = await must([process.execPath, YRD_BIN, "line", "status", "--json"], demo, env)
    const staleLine = JSON.parse(staleStatus.stdout) as typeof line
    const staleItem = staleLine.line.items.find((item) => item.pr === pr)!
    expect(staleItem.stale).toBe(true)
    expect(staleItem.staleReasons).toContain("base changed since check")
    const staleHumanStatus = await must([process.execPath, YRD_BIN, "line", "status"], demo, env)
    expect(staleHumanStatus.stdout).toContain("stale=base changed since check")

    const staleMerge = await must([process.execPath, YRD_BIN, "line", "integrate", pr, "--steps", "merge"], demo, env)
    expect(staleMerge.stdout).toContain(`bay: ${pr} checked → merging`)
    expect(staleMerge.stdout).toContain(`bay: ${pr} merging → rejected — stale check: base changed since check`)

    const rejectedStatus = await must([process.execPath, YRD_BIN, "line", "status", pr, "--json"], demo, env)
    const rejected = JSON.parse(rejectedStatus.stdout) as {
      line: { state: string; steps: { merge?: { ok?: boolean; error?: { code?: string; message?: string } } } }
    }
    expect(rejected.line.state).toBe("rejected")
    expect(rejected.line.steps.merge).toMatchObject({
      ok: false,
      error: { code: "stale-check", message: expect.stringContaining("base changed since check") },
    })

    const journal = await readFile(join(demo, ".git/bay/events.jsonl"), "utf8")
    const rows = journal
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            name: string
            data: {
              step?: string
              ok?: boolean
              exitCode?: number
              durationMs?: number
              error?: { code?: string }
              artifacts?: { name: string; path: string; bytes: number }[]
            }
          },
      )
    expect(rows.filter((row) => row.name === "line/step/started").map((row) => row.data.step)).toEqual(["check", "merge"])
    expect(rows.filter((row) => row.name === "line/step/finished").map((row) => row.data.step)).toEqual(["check", "merge"])
    const checkFinished = rows.find((row) => row.name === "line/step/finished" && row.data.step === "check")!
    expect(checkFinished.data.ok).toBe(true)
    expect(checkFinished.data.exitCode).toBe(0)
    expect(checkFinished.data.durationMs).toEqual(expect.any(Number))
    expect(checkFinished.data.artifacts?.map((artifact) => artifact.name).sort()).toEqual(["stderr", "stdout"])
    const stdout = checkFinished.data.artifacts!.find((artifact) => artifact.name === "stdout")!
    const stderr = checkFinished.data.artifacts!.find((artifact) => artifact.name === "stderr")!
    expect(stdout.path).toContain(".git/bay/artifacts/")
    expect(stderr.path).toContain(".git/bay/artifacts/")
    expect(stdout.bytes).toBeGreaterThan(0)
    expect(stderr.bytes).toBeGreaterThan(0)
    expect(await readFile(stdout.path, "utf8")).toBe("check stdout\n")
    expect(await readFile(stderr.path, "utf8")).toBe("check stderr\n")
    const mergeFinished = rows.find((row) => row.name === "line/step/finished" && row.data.step === "merge")!
    expect(mergeFinished.data.ok).toBe(false)
    expect(mergeFinished.data.error).toMatchObject({ code: "stale-check" })
  })

  it("line integrate can deploy after merge and record deploy step artifacts", async () => {
    await must(
      [
        "git",
        "-C",
        demo,
        "config",
        "bay.deploy",
        "printf 'deploy {pr} {base} {sha}\\n' > deploy.log; printf 'deploy stdout\\n'",
      ],
      demo,
      env,
    )
    await branchWithFiles(demo, env, "task/deploy-line", { "deploy.txt": "ship\n" })
    const pr = (await must(["git", "bay", "adopt", "task/deploy-line", "--workitem", "deploy-line"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", pr], demo, env)

    const integrated = await must([process.execPath, YRD_BIN, "line", "integrate", pr, "--steps", "check,merge,deploy"], demo, env)
    expect(integrated.stdout).toContain(`bay: ${pr} submitted → checking`)
    expect(integrated.stdout).toContain(`bay: ${pr} merging → merged`)
    expect(integrated.stdout).toContain(`bay: ${pr} deploy → deployed — deploy stdout`)
    expect(await readFile(join(demo, "deploy.log"), "utf8")).toMatch(new RegExp(`^deploy ${pr} main [0-9a-f]{40}\\n$`))

    const journal = await readFile(join(demo, ".git/bay/events.jsonl"), "utf8")
    const rows = journal
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            name: string
            data: {
              pr?: string
              step?: string
              ok?: boolean
              configHash?: string
              skipped?: boolean
              baseSha?: string
              headSha?: string
              artifacts?: { name: string; path: string; bytes: number }[]
            }
          },
      )
    expect(rows.filter((row) => row.name === "line/step/finished").map((row) => row.data.step)).toEqual(["check", "merge", "deploy"])
    const deployFinished = rows.find((row) => row.name === "line/step/finished" && row.data.step === "deploy")!
    expect(deployFinished.data).toMatchObject({ pr, ok: true })
    expect(deployFinished.data.configHash).toMatch(/^[0-9a-f]{64}$/)
    expect(deployFinished.data.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(deployFinished.data.headSha).toBe(deployFinished.data.baseSha)
    const deployStdout = deployFinished.data.artifacts!.find((artifact) => artifact.name === "stdout")!
    expect(await readFile(deployStdout.path, "utf8")).toBe("deploy stdout\n")

    const terminalStatus = await must([process.execPath, YRD_BIN, "line", "status", pr, "--json"], demo, env)
    const terminal = JSON.parse(terminalStatus.stdout) as {
      line: {
        pr: string
        state: string
        steps: { check?: { ok: boolean }; merge?: { ok: boolean }; deploy?: { ok: boolean; artifacts?: unknown[] } }
      }
    }
    expect(terminal.line).toMatchObject({
      pr,
      state: "merged",
      steps: { check: { ok: true }, merge: { ok: true }, deploy: { ok: true } },
    })
    expect(terminal.line.steps.deploy?.artifacts).toHaveLength(1)
    const terminalHumanStatus = await must([process.execPath, YRD_BIN, "line", "status", pr], demo, env)
    expect(terminalHumanStatus.stdout).toContain(`${pr} merged target=`)
    expect(terminalHumanStatus.stdout).toContain("check=ok")
    expect(terminalHumanStatus.stdout).toContain("merge=ok")
    expect(terminalHumanStatus.stdout).toContain("deploy=ok")

    await must(["git", "-C", demo, "config", "--unset", "bay.deploy"], demo, env)
    const skipped = await must([process.execPath, YRD_BIN, "line", "integrate", pr, "--steps", "deploy"], demo, env)
    expect(skipped.stdout).toContain(`bay: ${pr} deploy → skipped — deploy skipped`)
  })

  it("line watch can deploy each PR it merges", async () => {
    await must(
      [
        "git",
        "-C",
        demo,
        "config",
        "bay.deploy",
        "printf 'watch deploy {pr} {base}\\n' >> deploy-watch.log; printf 'watch deployed {pr}\\n'",
      ],
      demo,
      env,
    )
    await branchWithFiles(demo, env, "task/deploy-watch", { "deploy-watch.txt": "ship\n" })
    const pr = (await must(["git", "bay", "adopt", "task/deploy-watch", "--workitem", "deploy-watch"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", pr], demo, env)

    const watched = await runUntilOutput(
      [process.execPath, YRD_BIN, "line", "integrate", "--steps", "check,merge,deploy", "--watch", "--interval", "0.05"],
      demo,
      env,
      new RegExp(`bay: ${pr} deploy → deployed`),
    )
    expect(watched.stdout).toContain(`bay: ${pr} submitted → checking`)
    expect(watched.stdout).toContain(`bay: ${pr} merging → merged`)
    expect(watched.stdout).toContain(`bay: ${pr} deploy → deployed — watch deployed ${pr}`)
    expect(await readFile(join(demo, "deploy-watch.log"), "utf8")).toBe(`watch deploy ${pr} main\n`)
  })

  it("a failed deploy exits nonzero without unmerging the PR", async () => {
    await must(["git", "-C", demo, "config", "bay.deploy", "echo deploy bad >&2; exit 9"], demo, env)
    await branchWithFiles(demo, env, "task/deploy-red", { "deploy-red.txt": "ship\n" })
    const pr = (await must(["git", "bay", "adopt", "task/deploy-red", "--workitem", "deploy-red"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", pr], demo, env)

    const deployed = await run([process.execPath, YRD_BIN, "line", "integrate", pr, "--steps", "check,merge,deploy"], demo, env)
    expect(deployed.code).toBe(1)
    expect(deployed.stdout).toContain(`bay: ${pr} merging → merged`)
    expect(deployed.stdout).toContain(`bay: ${pr} deploy → failed`)
    expect(deployed.stdout).toContain("deploy 'echo deploy bad >&2; exit 9' failed (exit 9): deploy bad")

    const ls = await must(["git", "bay", "ls", pr, "--json"], demo, env)
    expect((JSON.parse(ls.stdout) as { pr: { state: string } }).pr.state).toBe("merged")

    const journal = await readFile(join(demo, ".git/bay/events.jsonl"), "utf8")
    const rows = journal
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; data: { step?: string; ok?: boolean; error?: { code?: string; exitCode?: number } } })
    const deployFinished = rows.find((row) => row.name === "line/step/finished" && row.data.step === "deploy")!
    expect(deployFinished.data).toMatchObject({ ok: false, error: { code: "deploy-failed", exitCode: 9 } })
  })

  it("line status JSON includes normalized error metadata for failed steps", async () => {
    await must(["git", "-C", demo, "config", "bay.check", "echo nope >&2; exit 7"], demo, env)
    await branchWithFiles(demo, env, "task/red-line", { "red.txt": "bad\n" })
    const pr = (await must(["git", "bay", "adopt", "task/red-line", "--workitem", "red-line"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", pr], demo, env)

    const checked = await run([process.execPath, YRD_BIN, "line", "integrate", pr, "--steps", "check"], demo, env)
    expect(checked.code).toBe(0)
    expect(checked.stdout).toContain(`bay: ${pr} checking → rejected`)

    const status = await must([process.execPath, YRD_BIN, "line", "status", "--json"], demo, env)
    const line = JSON.parse(status.stdout) as {
      line: {
        items: {
          pr: string
          steps: { check?: { error?: { code: string; message: string; exitCode?: number } } }
        }[]
      }
    }
    const item = line.line.items.find((candidate) => candidate.pr === pr)!
    expect(item.steps.check?.error).toMatchObject({
      code: "check-failed",
      message: expect.stringContaining("check 'echo nope >&2; exit 7' failed (exit 7): nope"),
      exitCode: 7,
    })
  })

  it("line integrate can park and finish a remote check while draining runnable PRs", async () => {
    await must(["git", "-C", demo, "config", "bay.check.runner", "waiting"], demo, env)
    await must(
      [
        "git",
        "-C",
        demo,
        "config",
        "bay.check",
        `printf '%s\\n' '{"token":"remote-1","url":"https://ci.invalid/run/1","detail":"queued remote","artifacts":{"launcher-log":"https://ci.invalid/run/1/log"}}'`,
      ],
      demo,
      env,
    )
    await branchWithFiles(demo, env, "task/remote-check", { "remote-check.txt": "park\n" })
    const pr = await openBranchAsSubmittedPr(demo, env, "task/remote-check", "remote-check")

    const parked = await must([process.execPath, YRD_BIN, "line", "integrate", pr, "--steps", "check"], demo, env)
    expect(parked.stdout).toContain(`bay: ${pr} submitted → checking`)
    expect(parked.stdout).toContain(`bay: ${pr} check → waiting — queued remote (https://ci.invalid/run/1)`)
    expect(parked.stdout).not.toContain(`${pr} checking → checked`)

    const status = await must([process.execPath, YRD_BIN, "line", "status", pr, "--json"], demo, env)
    const line = JSON.parse(status.stdout) as {
      line: {
        pr: string
        state: string
        steps: {
          check?: {
            waiting?: boolean
            detail?: string
            token?: string
            url?: string
            exitCode?: number
            configHash?: string
            artifacts?: { name?: string; url?: string }[]
            baseSha?: string
            headSha?: string
          }
        }
      }
    }
    expect(line.line.state).toBe("checking")
    expect(line.line.steps.check).toMatchObject({
      waiting: true,
      detail: "queued remote",
      token: "remote-1",
      url: "https://ci.invalid/run/1",
      exitCode: 0,
    })
    expect(line.line.steps.check?.configHash).toMatch(/^[0-9a-f]{64}$/)
    expect(line.line.steps.check?.artifacts).toHaveLength(2)
    expect(line.line.steps.check?.artifacts).toContainEqual(
      expect.objectContaining({ name: "launcher-log", url: "https://ci.invalid/run/1/log" }),
    )
    expect(line.line.steps.check?.baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(line.line.steps.check?.headSha).toMatch(/^[0-9a-f]{40}$/)

    const human = await must([process.execPath, YRD_BIN, "line", "status", pr], demo, env)
    expect(human.stdout).toContain("check=waiting")
    expect(human.stdout).toContain("url=https://ci.invalid/run/1")

    const wrongToken = await run([process.execPath, YRD_BIN, "line", "finish", pr, "--ok", "--token", "wrong"], demo, env)
    expect(wrongToken.code).toBe(1)
    expect(wrongToken.stderr).toContain(`token mismatch for ${pr}`)

    const journal = await readFile(join(demo, ".git/bay/events.jsonl"), "utf8")
    const rows = journal
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row) as { name: string; data: { pr?: string; step?: string; token?: string } })
    expect(rows.find((row) => row.name === "line/step/waiting" && row.data.pr === pr && row.data.step === "check")?.data.token).toBe(
      "remote-1",
    )
    expect(rows.some((row) => row.name === "line/step/finished" && row.data.pr === pr && row.data.step === "check")).toBe(false)

    await must(["git", "-C", demo, "config", "bay.check.runner", "local"], demo, env)
    await must(["git", "-C", demo, "config", "bay.check", "true"], demo, env)
    await branchWithFiles(demo, env, "task/after-park", { "after-park.txt": "go\n" })
    const next = await openBranchAsSubmittedPr(demo, env, "task/after-park", "after-park")

    const drained = await must([process.execPath, YRD_BIN, "line", "integrate"], demo, env)
    expect(drained.stdout).toContain(`bay: ${next} submitted → checking`)
    expect(drained.stdout).toContain(`bay: ${next} merging → merged`)
    expect(drained.stdout).not.toContain(`${pr} checking → checked`)

    const finished = await must(
      [
        process.execPath,
        YRD_BIN,
        "line",
        "finish",
        pr,
        "--step",
        "check",
        "--ok",
        "--token",
        "remote-1",
        "--detail",
        "remote green",
        "--duration-ms",
        "1234",
        "--url",
        "https://ci.invalid/run/1",
        "--artifact",
        "junit=https://ci.invalid/run/1/junit.xml",
      ],
      demo,
      env,
    )
    expect(finished.stdout).toContain(`bay: ${pr} check → passed — remote green`)
    expect(finished.stdout).toContain(`bay: ${pr} checking → checked`)

    const finishedStatus = await must([process.execPath, YRD_BIN, "line", "status", pr, "--json"], demo, env)
    const checked = JSON.parse(finishedStatus.stdout) as {
      line: {
        state: string
        stale?: boolean
        staleReasons?: string[]
        steps: {
          check?: {
            artifacts?: { name?: string; url?: string }[]
            ok?: boolean
            waiting?: boolean
            token?: string
            url?: string
            durationMs?: number
          }
        }
      }
    }
    expect(checked.line.state).toBe("checked")
    expect(checked.line.stale).toBe(true)
    expect(checked.line.staleReasons).toContain("base changed since check")
    expect(checked.line.steps.check).toMatchObject({
      ok: true,
      token: "remote-1",
      url: "https://ci.invalid/run/1",
      durationMs: 1234,
    })
    expect(checked.line.steps.check?.artifacts).toEqual([
      expect.objectContaining({ name: "junit", url: "https://ci.invalid/run/1/junit.xml" }),
    ])
    expect(checked.line.steps.check?.waiting).toBeUndefined()

    const staleMerge = await must([process.execPath, YRD_BIN, "line", "integrate"], demo, env)
    expect(staleMerge.stdout).toContain(`bay: ${pr} checked → merging`)
    expect(staleMerge.stdout).toContain(`bay: ${pr} merging → rejected — stale check: base changed since check`)

    const retried = await must([process.execPath, YRD_BIN, "line", "integrate", pr, "--retry"], demo, env)
    expect(retried.stdout).toContain(`bay: ${pr} received — checks running`)
    expect(retried.stdout).toContain(`bay: ${pr} merged onto main (checks ✓)`)

    await must(["git", "-C", demo, "config", "bay.check.runner", "waiting"], demo, env)
    await must(
      [
        "git",
        "-C",
        demo,
        "config",
        "bay.check",
        `printf '%s\\n' '{"token":"remote-2","detail":"queued red"}'`,
      ],
      demo,
      env,
    )
    await branchWithFiles(demo, env, "task/remote-red", { "remote-red.txt": "red\n" })
    const red = await openBranchAsSubmittedPr(demo, env, "task/remote-red", "remote-red")
    await must([process.execPath, YRD_BIN, "line", "integrate", red, "--steps", "check"], demo, env)

    const failed = await must(
      [process.execPath, YRD_BIN, "line", "finish", red, "--fail", "--token", "remote-2", "--detail", "remote red", "--exit-code", "8"],
      demo,
      env,
    )
    expect(failed.stdout).toContain(`bay: ${red} check → failed — remote red`)
    expect(failed.stdout).toContain(`bay: ${red} checking → rejected — remote red`)

    const failedStatus = await must([process.execPath, YRD_BIN, "line", "status", "--json"], demo, env)
    const failedLine = JSON.parse(failedStatus.stdout) as {
      line: { items: { pr: string; state: string; steps: { check?: { error?: { code?: string; exitCode?: number } } } }[] }
    }
    const failedItem = failedLine.line.items.find((item) => item.pr === red)!
    expect(failedItem.state).toBe("rejected")
    expect(failedItem.steps.check?.error).toMatchObject({ code: "check-failed", exitCode: 8 })
  }, PROCESS_TEST_TIMEOUT_MS)

  it("line status accepts multiple targeted selectors in order", async () => {
    await branchWithFiles(demo, env, "task/multi-a", { "multi-a.txt": "a\n" })
    const prA = (await must(["git", "bay", "adopt", "task/multi-a", "--workitem", "multi-a"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", prA], demo, env)
    await must([process.execPath, YRD_BIN, "line", "integrate", prA, "--steps", "check"], demo, env)

    await branchWithFiles(demo, env, "task/multi-b", { "multi-b.txt": "b\n" })
    const prB = (await must(["git", "bay", "adopt", "task/multi-b", "--workitem", "multi-b"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", prB], demo, env)

    const json = await must([process.execPath, YRD_BIN, "line", "status", prB, prA, "--json"], demo, env)
    const status = JSON.parse(json.stdout) as {
      targets: {
        selector: string
        line: { pr: string; state: string; steps?: { check?: { ok: boolean } } }
      }[]
    }
    expect(status.targets.map((target) => target.selector)).toEqual([prB, prA])
    expect(status.targets.map((target) => target.line.pr)).toEqual([prB, prA])
    expect(status.targets.map((target) => target.line.state)).toEqual(["submitted", "checked"])
    expect(status.targets[1]!.line.steps?.check).toMatchObject({ ok: true })

    const human = await must([process.execPath, YRD_BIN, "line", "status", prB, prA], demo, env)
    const lines = human.stdout.trim().split("\n")
    expect(lines[0]).toContain(`${prB} submitted target=`)
    expect(lines[1]).toContain(`${prA} checked target=`)
    expect(lines[1]).toContain("check=ok")
  })

  it("line status projects to the bay state and unsupported steps teach", async () => {
    const help = await must([process.execPath, YRD_BIN, "--help"], demo, env)
    expect(help.stdout).toContain("Installed projections: bay, line, task, contest")

    const taskHelp = await must([process.execPath, YRD_BIN, "task", "--help"], demo, env)
    expect(taskHelp.stdout).toContain('--agents "ag codex/claude"')
    expect(taskHelp.stdout).toContain("Built-in contest agents: codex, claude")
    expect(taskHelp.stdout).toContain("Agent lists use ag-style provider-list syntax")
    expect(taskHelp.stdout).not.toContain("claude-opus")

    const status = await must([process.execPath, YRD_BIN, "line", "status"], demo, env)
    expect(status.stdout).toContain("line ")
    expect(status.stdout).toContain("@")
    expect(status.stdout).toContain("no open PRs")

    const deploy = await run([process.execPath, YRD_BIN, "line", "integrate", "--steps", "deploy"], demo, env)
    expect(deploy.code).toBe(2)
    expect(deploy.stderr).toContain("line integrate --steps deploy requires a PR or name")
  })
})

describe("yrd CLI — contest projection", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("yrd-contest-"))
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("competes in multiple bays, records metrics/evals, selects, and promotes the winner", async () => {
    const alpha =
      `printf '%s\\n' '{"usage":{"input_tokens":10,"output_tokens":5},"cost_usd":0.01}'; ` +
      `printf 'alpha\\n' > result.txt; git add result.txt; git commit -qm 'feat: alpha'`
    const beta =
      `printf '%s\\n' '{"usage":{"input_tokens":8,"output_tokens":4},"cost_usd":0.02}'; ` +
      `printf 'beta\\n' > result.txt; git add result.txt; git commit -qm 'feat: beta'`

    const competed = await must(
      [
        process.execPath,
        YRD_BIN,
        "task",
        "compete",
        "demo-task",
        "--agents",
        "ag fake-alpha/fake-beta",
        "--bays",
        "2",
        "--agent-cmd",
        `fake-alpha=${alpha}`,
        "--agent-cmd",
        `fake-beta=${beta}`,
        "--eval",
        "test -f result.txt",
        "--json",
      ],
      demo,
      env,
    )

    const record = JSON.parse(competed.stdout) as {
      id: string
      attempts: {
        id: string
        agent: string
        bayName: string
        bayPath: string
        exitCode: number
        logs: { stdout: string; stderr: string }
        metrics: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number }
        git: { committed: boolean; changedFiles: string[] }
        evals: { exitCode: number }[]
      }[]
      winner?: string
    }
    expect(record.id).toBe("C1")
    expect(record.attempts).toHaveLength(2)
    const alphaAttempt = record.attempts.find((attempt) => attempt.agent === "fake-alpha")!
    const betaAttempt = record.attempts.find((attempt) => attempt.agent === "fake-beta")!
    expect(alphaAttempt.exitCode).toBe(0)
    expect(alphaAttempt.metrics).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01 })
    expect(alphaAttempt.git.committed).toBe(true)
    expect(alphaAttempt.git.changedFiles).toContain("result.txt")
    expect(alphaAttempt.evals[0]!.exitCode).toBe(0)
    expect(await readFile(alphaAttempt.logs.stdout, "utf8")).toContain('"input_tokens":10')

    const shown = await must([process.execPath, YRD_BIN, "contest", "show", record.id, "--json"], demo, env)
    const shownRecord = JSON.parse(shown.stdout) as typeof record
    expect(shownRecord.attempts.map((attempt) => attempt.agent)).toEqual(["fake-alpha", "fake-beta"])

    const selected = await must([process.execPath, YRD_BIN, "contest", "select", record.id, "--winner", betaAttempt.id], demo, env)
    expect(selected.stdout).toContain(`yrd: ${record.id} winner ${betaAttempt.id}`)

    const promoted = await must([process.execPath, YRD_BIN, "contest", "promote", record.id], demo, env)
    expect(promoted.stdout).toMatch(new RegExp(`yrd: ${record.id} promoted ${betaAttempt.id} as PR\\d+`))

    const state = await must(["git", "bay", "ls", "--json"], demo, env)
    const prs = (JSON.parse(state.stdout) as { prs: Record<string, { name: string | null; state: string }> }).prs
    const submitted = Object.values(prs).find((pr) => pr.name === betaAttempt.bayName)
    expect(submitted?.state).toBe("submitted")
  }, 15_000)
})

describe("git bay CLI — issue tracking inbound: bay.issue at open AND adopt", () => {
  let root: string
  let demo: string
  let env: Record<string, string>
  let tracker: string

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-tracker-"))
    await must(["git", "bay", "init"], demo, env)
    tracker = join(root, "tracker.sh")
    await writeFile(
      tracker,
      `#!/bin/sh\n[ "$1" = "good-name" ] && exit 0\necho "no such ticket: $1" >&2\nexit 3\n`,
      "utf8",
    )
    await chmod(tracker, 0o755)
    await must(["git", "-C", demo, "config", "bay.issue", `${tracker} {name}`], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("a name the tracker accepts opens a worktree", async () => {
    const res = await must(["git", "bay", "open", "good-name"], demo, env)
    expect(res.stdout.trim()).toContain(".bays/wt1")
  })

  it("a name the tracker refuses is a teaching refusal carrying the tracker's stderr and the modern remedy", async () => {
    const res = await run(["git", "bay", "open", "bogus-name"], demo, env)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("the tracker does not accept 'bogus-name'")
    expect(res.stderr).toContain("no such ticket: bogus-name")
    expect(res.stderr).toContain("git config bay.issue none")
    const ls = await must(["git", "bay", "ls"], demo, env)
    expect(ls.stdout).toContain("no open worktrees") // nothing opened
  })

  it("retired bay.tracker is ignored; bay.issue is the only inbound validation key", async () => {
    await must(["git", "-C", demo, "config", "--unset", "bay.issue"], demo, env)
    await must(["git", "-C", demo, "config", "bay.tracker", `${tracker} {name}`], demo, env)
    const ignored = await must(["git", "bay", "open", "ignored-tracker"], demo, env)
    expect(ignored.stdout.trim()).toContain(".bays/wt1")
    await must(["git", "bay", "close", "ignored-tracker"], demo, env)

    await must(["git", "-C", demo, "config", "bay.issue", `${tracker} {name}`], demo, env)
    const refused = await run(["git", "bay", "open", "bogus-name"], demo, env)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("no such ticket: bogus-name")
  })

  it("bay.issue none skips the check", async () => {
    await must(["git", "-C", demo, "config", "bay.issue", "none"], demo, env)
    const res = await must(["git", "bay", "open", "anything-goes"], demo, env)
    expect(res.stdout.trim()).toContain(".bays/wt1")
  })

  it("adopt --workitem validates at the same front door; a nameless adopt stays the audit-warned ramp", async () => {
    await must(["git", "-C", demo, "switch", "-qc", "task/legacy", "main"], demo, env)
    await writeFile(join(demo, "legacy.txt"), "x\n", "utf8")
    await must(["git", "-C", demo, "add", "legacy.txt"], demo, env)
    await must(["git", "-C", demo, "commit", "-qm", "legacy work"], demo, env)
    await must(["git", "-C", demo, "switch", "-q", "main"], demo, env)

    // A refused workitem never mints a PR (acceptance: co/ENQUEUE both validate).
    const refused = await run(["git", "bay", "adopt", "task/legacy", "--workitem", "bogus-name"], demo, env)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("bay: adopt: the tracker does not accept 'bogus-name'")
    const before = await must(["git", "bay", "ls", "--json"], demo, env)
    expect(Object.keys((JSON.parse(before.stdout) as { prs: Record<string, unknown> }).prs)).toHaveLength(0)

    // An accepted workitem adopts; a NAMELESS adopt skips validation entirely
    // (the reconciliation ramp — audit owns the warning, not this door).
    const adopted = await must(["git", "bay", "adopt", "task/legacy", "--workitem", "good-name"], demo, env)
    expect(adopted.stdout.trim()).toBe("PR1")
  })
})

describe("git bay CLI — issue tracking outbound: bay.issue.on-* commands run and their outcomes are journaled", () => {
  let root: string
  let demo: string
  let env: Record<string, string>
  let log: string

  async function journalEvents(): Promise<{ name: string; data: Record<string, unknown> }[]> {
    const raw = await readFile(join(demo, ".git", "bay", "events.jsonl"), "utf8")
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { name: string; data: Record<string, unknown> })
  }

  async function openCommitPush(name: string): Promise<string> {
    const opened = await must(["git", "bay", "open", name], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, `${name}.txt`), "x\n", "utf8")
    await must(["git", "-C", wtPath, "add", "-A"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", `feat: ${name}`], wtPath, env)
    await must(["git", "-C", wtPath, "push"], wtPath, env)
    return (await must(["git", "-C", wtPath, "rev-parse", "HEAD"], wtPath, env)).stdout.trim()
  }

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-notify-"))
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "config", "bay.check", "true"], demo, env)
    await must(["git", "-C", demo, "config", "bay.merge", "git merge --no-ff {target}"], demo, env)
    log = join(root, "notified.log")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("a merged PR runs on-merged with {name}/{pr}/{sha} — {sha} is the verified landed tip, and the outcome is journaled", async () => {
    await must(
      ["git", "-C", demo, "config", "bay.issue.on-merged", `echo "merged {name} {pr} {sha}" >> ${log}`],
      demo,
      env,
    )
    const tipSha = await openCommitPush("feat-a")
    const submit = await must(["git", "bay", "submit", "PR1"], demo, env)
    expect(submit.stdout).toContain("bay: PR1 merging → merged")
    expect(submit.stdout).toContain("bay: issue 'feat-a' notified (merged)")

    const notified = await readFile(log, "utf8")
    expect(notified.trim()).toBe(`merged feat-a PR1 ${tipSha}`)

    const events = await journalEvents()
    const outcome = events.filter((e) => e.name === "issues/notified")
    expect(outcome).toHaveLength(1)
    expect(outcome[0]!.data).toMatchObject({ pr: "PR1", name: "feat-a", on: "merged", code: 0 })
    const merged = events.find((e) => e.name === "pr/changed" && e.data.to === "merged")
    expect(merged!.data.sha).toBe(tipSha) // machine-truth on the event itself, not detail prose
  })

  it("a rejected PR runs on-rejected with {code}/{detail}", async () => {
    await must(["git", "-C", demo, "config", "bay.check", "false"], demo, env)
    await must(["git", "-C", demo, "config", "bay.issue.on-rejected", `echo "rejected {name} {pr} {code}" >> ${log}`], demo, env)
    await openCommitPush("feat-red")
    const submit = await must(["git", "bay", "submit", "PR1"], demo, env)
    expect(submit.stdout).toContain("bay: issue 'feat-red' notified (rejected)")
    const notified = await readFile(log, "utf8")
    expect(notified.trim()).toBe("rejected feat-red PR1 check-failed")
  })

  it("a failing notify command NEVER fails the verb — the merge stands, stderr is loud, the exit code is journaled", async () => {
    await must(
      ["git", "-C", demo, "config", "bay.issue.on-merged", `echo "tracker down" >&2; exit 5`],
      demo,
      env,
    )
    await openCommitPush("feat-b")
    const submit = await run(["git", "bay", "submit", "PR1"], demo, env)
    expect(submit.code).toBe(0) // the verb's outcome is the MERGE, not the notification
    expect(submit.stdout).toContain("bay: PR1 merging → merged")
    expect(submit.stderr).toContain("bay: issue notify FAILED for 'feat-b' (merged) — exit 5: tracker down")

    const events = await journalEvents()
    const outcome = events.find((e) => e.name === "issues/notified")
    expect(outcome!.data).toMatchObject({ on: "merged", code: 5 })
    const ls = await must(["git", "bay", "ls", "PR1"], demo, env)
    expect(ls.stdout).toContain("PR1 merged")
  })

  it("an unnamed PR notifies nothing — there is no issue to notify", async () => {
    await must(["git", "-C", demo, "config", "bay.issue.on-merged", `echo "merged {name}" >> ${log}`], demo, env)
    await must(["git", "-C", demo, "switch", "-qc", "task/anon", "main"], demo, env)
    await writeFile(join(demo, "anon.txt"), "x\n", "utf8")
    await must(["git", "-C", demo, "add", "anon.txt"], demo, env)
    await must(["git", "-C", demo, "commit", "-qm", "anon work"], demo, env)
    await must(["git", "-C", demo, "switch", "-q", "main"], demo, env)
    await must(["git", "bay", "adopt", "task/anon"], demo, env)
    const submit = await must(["git", "bay", "submit", "PR1"], demo, env)
    expect(submit.stdout).toContain("bay: PR1 merging → merged")
    expect(submit.stdout).not.toContain("notified")
    expect(existsSync(log)).toBe(false)
  })
})

describe("git bay CLI — every pre-rename verb still works, unadvertised", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-alias-"))
    await must(["git", "bay", "init"], demo, env)
    // submit's own default auto-integrate would otherwise land PR2 before the
    // drain step below gets to demonstrate it as a separate step.
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("co / status / ping / abandon / enqueue / requeue / drain / land / prime resolve to the new verbs", async () => {
    // co → open (with the legacy --no-workitem spelling)
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
    // enqueue → adopt (lands `pushed`); submit (queue) makes it visible to
    // integrate/drain.
    await must(["git", "-C", demo, "branch", "task/legacy"], demo, env)
    const enq = await must(["git", "bay", "enqueue", "task/legacy"], demo, env)
    expect(enq.stdout.trim()).toBe("PR2") // PR1 was burned by the closed worktree
    await must(["git", "bay", "submit", "PR2"], demo, env)
    // requeue → retry (teaching refusal proves the alias routes to retry)
    const requeue = await run(["git", "bay", "requeue", "PR99"], demo, env)
    expect(requeue.code).toBe(1)
    expect(requeue.stderr).toContain("bay: no PR or worktree named 'PR99'")
    // drain → integrate: walks the whole pipeline (no bay.check configured,
    // so check auto-passes; a red merge command rejects it).
    const drain = await run(["git", "bay", "drain", "PR2"], demo, { ...env, BAY_MERGE: "false" })
    expect(drain.stdout).toContain("bay: PR2 submitted → checking")
    expect(drain.stdout).toContain("bay: PR2 checking → checked")
    expect(drain.stdout).toContain("bay: PR2 checked → merging")
    expect(drain.stdout).toContain("bay: PR2 merging → rejected — exit 1")
    // land → integrate (PR2 is now rejected, not submitted/checked — queue is empty)
    const land = await run(["git", "bay", "land"], demo, env)
    expect(land.stdout).toContain("bay: queue empty — nothing to integrate")
    // prime → guide
    const prime = await must(["git", "bay", "prime"], demo, env)
    expect(prime.stdout).toContain("git bay is a small continuous-integration server for this repository")
  })

  it("help advertises exactly one spelling per verb — no aliases anywhere", async () => {
    const help = await run(["git", "bay"], demo, env) // bare invocation prints help
    expect(help.code).toBe(0)
    for (const advertised of [
      "guide",
      "init",
      "open [options] <name>",
      "close [options] <wt|name>", // --withdraw gives it an [options] slot, like ls/integrate/audit
      "gc",
      "ls",
      "submit [options] <PR|name|branch>",
      "check <PR|name>",
      "merge <PR|name>",
      "integrate",
      "retry <PR|name>",
      "audit",
    ]) {
      expect(help.stdout, advertised).toContain(advertised)
    }
    const commandLine = (name: string) => new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m")
    for (const hidden of [
      "prime",
      "new",
      "co",
      "checkout",
      "install",
      "setup",
      "adopt",
      "abandon",
      "return",
      "refresh",
      "ping",
      "status",
      "enqueue",
      "queue",
      "in",
      "int",
      "land",
      "drain",
      "requeue",
      "receive-pre",
      "receive-post",
    ]) {
      expect(help.stdout, hidden).not.toMatch(commandLine(hidden))
    }
    // and the per-command usage line advertises one spelling too, even when
    // invoked through a legacy alias
    const integrateHelp = await run(["git", "bay", "land", "-h"], demo, env)
    expect(integrateHelp.stdout).toContain("Usage: git bay integrate [options] [PR|name]")
    expect(integrateHelp.stdout).not.toContain("integrate|land")
    const openHelp = await must(["git", "bay", "open", "--help"], demo, env)
    expect(openHelp.stdout).toContain("--from <branch>")
    expect(openHelp.stdout).toContain("--head <branch>")
    // `merge` is now its OWN advertised verb, not an integrate alias
    const mergeHelp = await must(["git", "bay", "merge", "-h"], demo, env)
    expect(mergeHelp.stdout).toContain("Usage: git bay merge [options] <PR|name>")
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
    for (const verb of ["open", "new", "ls", "adopt", "submit", "queue", "check", "merge", "integrate", "retry", "close", "refresh", "co", "status", "enqueue", "requeue", "drain", "abandon", "ping"]) {
      const res = await run(["git", "bay", verb, "-h"], demo, env)
      expect(res.code, `${verb} -h`).toBe(0)
      expect(res.stdout, `${verb} -h`).toContain("Usage: git bay")
    }
  })

  it("an unknown flag is a teaching refusal, never a silent no-op or a positional", async () => {
    await must(["git", "bay", "init"], demo, env)
    // The silent-error case: a --watch typo must not fall through to a single integrate.
    const integrate = await run(["git", "bay", "integrate", "--wach"], demo, env)
    expect(integrate.code).toBe(1)
    expect(integrate.stderr).toContain("unknown option '--wach'")
    expect(integrate.stderr).toContain("(Did you mean --watch?)") // teaching: typo suggestion
    expect(integrate.stderr).toContain("Usage: git bay integrate")
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
    expect(res.stderr).toContain("missing required argument 'PR|name|branch'")
    expect(res.stderr).toContain("Usage: git bay submit") // showHelpAfterError keeps it teaching
  })

  it("regression: bare `adopt` still teaches that a branch is required", async () => {
    await must(["git", "bay", "init"], demo, env)
    const res = await run(["git", "bay", "adopt"], demo, env)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("missing required argument 'branch'")
    expect(res.stderr).toContain("Usage: git bay adopt") // showHelpAfterError keeps it teaching
  })

  it("unadvertised prefixes resolve — `au` is audit, ambiguity teaches with the canonical names", async () => {
    await must(["git", "bay", "init"], demo, env)
    const audit = await must(["git", "bay", "au"], demo, env)
    expect(audit.stdout).toContain("bay: clean")
    const amb = await run(["git", "bay", "l"], demo, env)
    expect(amb.code).toBe(1)
    expect(amb.stderr).toContain("'l' is ambiguous")
    expect(amb.stderr).toContain("integrate, ls") // "land" (alias) resolves to canonical "integrate"
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

  it("`in`/`int` are exact aliases of integrate (never ambiguity refusals); `i` alone stays genuinely ambiguous with init; `init` itself always resolves as the exact name", async () => {
    await must(["git", "bay", "init"], demo, env)
    // Otherwise submit's own default auto-integrate would land the PR before
    // the explicit `in`/`int` integrate call below gets a chance to run.
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
    await must(["git", "-C", demo, "branch", "task/x"], demo, env)
    const id1 = (await must(["git", "bay", "adopt", "task/x"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", id1], demo, env) // pushed → submitted

    // Exact alias match wins BEFORE prefix matching — `in` is never treated as
    // an ambiguous prefix of `init`, even though it IS one character short of it.
    // No bay.check configured, so the check half auto-passes before the red
    // merge command rejects it.
    const inRun = await run(["git", "bay", "in", id1], demo, { ...env, BAY_MERGE: "false" })
    expect(inRun.code).toBe(0)
    expect(inRun.stdout).toContain(`bay: ${id1} submitted → checking`)
    expect(inRun.stdout).toContain(`bay: ${id1} checked → merging`)

    // `int` is likewise an exact alias, not a prefix.
    await must(["git", "-C", demo, "branch", "task/y"], demo, env)
    const id2 = (await must(["git", "bay", "adopt", "task/y"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", id2], demo, env)
    const intRun = await run(["git", "bay", "int", id2], demo, { ...env, BAY_MERGE: "false" })
    expect(intRun.code).toBe(0)
    expect(intRun.stdout).toContain(`bay: ${id2} submitted → checking`)
    expect(intRun.stdout).toContain(`bay: ${id2} checked → merging`)

    // `i` alone matches no exact name/alias — it's a genuine prefix collision
    // between `init` (exact name) and `integrate` (via the `in`/`int` aliases).
    const i = await run(["git", "bay", "i"], demo, env)
    expect(i.code).toBe(1)
    expect(i.stderr).toContain("'i' is ambiguous")
    expect(i.stderr).toContain("init, integrate")

    // `init` itself is an exact name match — never rewritten by the prefix
    // resolver, and safe to run again (init is idempotent).
    const initAgain = await run(["git", "bay", "init"], demo, env)
    expect(initAgain.code).toBe(0)
    expect(initAgain.stdout).toContain("bay: initialized")
  })

  it("`o` resolves uniquely to open — no other verb or alias starts with 'o'", async () => {
    await must(["git", "bay", "init"], demo, env)
    const res = await must(["git", "bay", "o", "prefix-open"], demo, env)
    expect(res.stdout.trim()).toContain(".bays/wt1")
  })

  it("`install`/`setup` are hidden aliases of init and do not widen the 'i' ambiguity", async () => {
    const root2 = await must(["git", "bay", "install"], demo, env)
    expect(root2.stdout).toContain("bay: initialized")
    const root3 = await must(["git", "bay", "setup"], demo, env)
    expect(root3.stdout).toContain("bay: initialized")
    // Both resolve to the SAME canonical verb as `init`, so the 'i' prefix
    // ambiguity set stays exactly {init, integrate} — install/setup add no
    // new candidate.
    const i = await run(["git", "bay", "i"], demo, env)
    expect(i.code).toBe(1)
    expect(i.stderr).toContain("init, integrate")
  })
})

describe("git bay CLI — batch integration from queue.batch-size", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-batch-cli-"))
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "config", "bay.queue.batch-size", "2"], demo, env)
    // Rest submitted PRs at `submitted` so the batch composer sees a queue —
    // the default autoMerge would land each PR individually at submit time.
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
    await must(
      [
        "git",
        "-C",
        demo,
        "config",
        "bay.merge",
        "git -c user.name=t -c user.email=t@example.invalid merge --no-ff -q {target}",
      ],
      demo,
      env,
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("composes compatible queued PRs into one batch candidate and lands the member PRs together", async () => {
    await branchWithFiles(demo, env, "task/a", { "a.txt": "a\n" })
    await branchWithFiles(demo, env, "task/b", { "b.txt": "b\n" })
    expect((await must(["git", "bay", "adopt", "task/a"], demo, env)).stdout.trim()).toBe("PR1")
    expect((await must(["git", "bay", "adopt", "task/b"], demo, env)).stdout.trim()).toBe("PR2")
    await must(["git", "bay", "submit", "PR1"], demo, env)
    await must(["git", "bay", "submit", "PR2"], demo, env)

    const integrated = await must(["git", "bay", "integrate"], demo, env)
    expect(integrated.stdout).toContain("bay: batch PR3 built — members: PR1, PR2")
    expect(integrated.stdout).toContain("bay: PR3 submitted → checking")
    expect(integrated.stdout).toContain("bay: PR3 merging → merged")

    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as { prs: Record<string, { state: string }> }
    expect(state.prs.PR1!.state).toBe("merged")
    expect(state.prs.PR2!.state).toBe("merged")
    expect(state.prs.PR3!.state).toBe("merged")

    const batchStatus = await must(["git", "bay", "ls", "PR3"], demo, env)
    expect(batchStatus.stdout).toContain("batch PR3 merged — members: PR1, PR2")
  })

  it("ejects a build-conflict member, lands the clean remainder, and surfaces the ejection in status", async () => {
    await branchWithFiles(demo, env, "task/file", { dir: "file blocks directory\n" })
    await branchWithFiles(demo, env, "task/nested", { "dir/file.txt": "nested\n" })
    await must(["git", "bay", "adopt", "task/file"], demo, env)
    await must(["git", "bay", "adopt", "task/nested"], demo, env)
    await must(["git", "bay", "submit", "PR1"], demo, env)
    await must(["git", "bay", "submit", "PR2"], demo, env)

    const integrated = await must(["git", "bay", "integrate"], demo, env)
    expect(integrated.stdout).toContain("bay: PR2 ejected from batch PR3")
    expect(integrated.stdout).toContain("bay: batch PR3 built — members: PR1; ejected: PR2")
    expect(integrated.stdout).toContain("bay: PR3 merging → merged")

    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as { prs: Record<string, { state: string }> }
    expect(state.prs.PR1!.state).toBe("merged")
    expect(state.prs.PR2!.state).toBe("rejected")
    expect(state.prs.PR3!.state).toBe("merged")

    const ejected = await must(["git", "bay", "ls", "PR2"], demo, env)
    expect(ejected.stdout).toContain("PR2 rejected — bay: PR2 ejected from batch PR3")
    expect(ejected.stdout).not.toContain("train")
  })

  it("bisects a red batch gate, ejects the faulting member, rebuilds, and lands the remainder", async () => {
    const merge = join(root, "merge-if-clean.sh")
    const gate = join(root, "gate-no-bad.sh")
    await writeFile(
      merge,
      `#!/bin/sh
target="$1"
if git cat-file -e "$target:bad.txt" 2>/dev/null; then
  echo "bad batch" >&2
  exit 7
fi
git -c user.name=t -c user.email=t@example.invalid merge --no-ff -q "$target"
`,
      "utf8",
    )
    await writeFile(gate, `#!/bin/sh\ntest ! -f bad.txt\n`, "utf8")
    await chmod(merge, 0o755)
    await chmod(gate, 0o755)
    await must(["git", "-C", demo, "config", "bay.merge", `${merge} {target}`], demo, env)
    await must(["git", "-C", demo, "config", "bay.check", gate], demo, env)

    await branchWithFiles(demo, env, "task/good", { "good.txt": "ok\n" })
    await branchWithFiles(demo, env, "task/bad", { "bad.txt": "breaks batch\n" })
    await must(["git", "bay", "adopt", "task/good"], demo, env)
    await must(["git", "bay", "adopt", "task/bad"], demo, env)
    await must(["git", "bay", "submit", "PR1"], demo, env)
    await must(["git", "bay", "submit", "PR2"], demo, env)

    const integrated = await must(["git", "bay", "integrate"], demo, env)
    expect(integrated.stdout).toContain("bay: batch PR3 built — members: PR1, PR2")
    // The candidate's check runs against the CANDIDATE's tree (bad.txt aboard),
    // so the batch goes red at the check stage — the merge command's exit-7
    // belt never needs to catch it.
    expect(integrated.stdout).toContain("bay: PR3 checking → rejected — check")
    expect(integrated.stdout).toContain("bay: PR2 ejected from batch PR3 — first red batch prefix")
    expect(integrated.stdout).toContain("bay: batch PR4 built — members: PR1")
    expect(integrated.stdout).toContain("bay: PR4 merging → merged")
    // Settle journals the member's own outcome (LE-5) and the drain prints it.
    expect(integrated.stdout).toContain("bay: PR1 checking → merged — merged via batch PR4")

    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as { prs: Record<string, { state: string }> }
    expect(state.prs.PR1!.state).toBe("merged")
    expect(state.prs.PR2!.state).toBe("rejected")
    expect(state.prs.PR3!.state).toBe("rejected")
    expect(state.prs.PR4!.state).toBe("merged")

    const ejected = await must(["git", "bay", "ls", "PR2"], demo, env)
    expect(ejected.stdout).toContain("first red batch prefix")
    expect(ejected.stdout).not.toMatch(/\b(train|culprit|bisect)\b/u)
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
    expect(init.stdout).toContain("events: .git/bay/events.jsonl")
    expect(existsSync(join(demo, ".git", "bay", "events.jsonl"))).toBe(true)
    expect(existsSync(join(demo, ".git", "bay", "index.sqlite"))).toBe(true)
    expect(existsSync(join(demo, ".git", "bay", "prs.git"))).toBe(true)
    expect(existsSync(join(demo, ".git", "bay", "journal.jsonl"))).toBe(false)
    expect(existsSync(join(demo, ".git", "bay", "bay.db"))).toBe(false)
    expect(existsSync(join(demo, ".git", "bay", "repo.git"))).toBe(false)
    expect(existsSync(join(demo, ".bay"))).toBe(false)
  })

  it("a hygiene clean sweep cannot delete the journal — the exact production incident", async () => {
    await must(["git", "bay", "init"], demo, env)
    const id = (await must(["git", "bay", "adopt", "main"], demo, env)).stdout.trim()
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

  it("adopt refuses an unresolvable target at the door and suggests the near-miss branch", async () => {
    // The live-demo confusion: the user adopted a NAME; the real branch was
    // task/<name>. The old behavior queued it happily and let the merge worker
    // reject it minutes later.
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "branch", "task/demo-readme2"], demo, env)
    const res = await run(["git", "bay", "adopt", "demo-readme2"], demo, env)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("does not resolve to a commit and no worktree carries that name")
    expect(res.stderr).toContain("Did you mean: task/demo-readme2")
    const ls = await must(["git", "bay", "ls", "--json"], demo, env)
    expect(ls.stdout).not.toContain("PR1") // nothing was created
  })

  it("submit accepts an existing branch directly and rests at submitted when autoMerge is off", async () => {
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
    await branchWithFiles(demo, env, "task/some-branch", { "some.txt": "some\n" })
    const res = await must(["git", "bay", "submit", "task/some-branch"], demo, env)
    expect(res.stdout).toContain("bay: PR1 submitted — git bay integrate PR1 to land it")
    const ls = await must(["git", "bay", "ls", "PR1"], demo, env)
    expect(ls.stdout).toContain("PR1 submitted")
  })

  it("bare ls shows every non-merged PR — a rejected one is never invisible", async () => {
    await must(["git", "bay", "init"], demo, env)
    // Otherwise submit's own default auto-integrate would land the PR before
    // the explicit integrate call below gets to reject it with BAY_MERGE=false.
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
    await must(["git", "-C", demo, "branch", "task/x"], demo, env)
    const id = (await must(["git", "bay", "adopt", "task/x"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", id], demo, env) // pushed → submitted
    await run(["git", "bay", "integrate"], demo, { ...env, BAY_MERGE: "false" })
    const ls = await must(["git", "bay", "ls"], demo, env)
    expect(ls.stdout).toContain(id)
    expect(ls.stdout).toContain("rejected")
    expect(ls.stdout).toContain("exit 1")
  })
})

describe("git bay CLI — close --withdraw (v0.3: a bay's PR must be dispositioned before closing)", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-withdraw-"))
    await must(["git", "bay", "init"], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("close refuses while the bay's PR is still live (rejected, not yet retried); --withdraw teaches then closes", async () => {
    await must(["git", "-C", demo, "config", "bay.check", "false"], demo, env) // always-red check
    const opened = await must(["git", "bay", "open", "flaky"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "f.txt"), "x\n", "utf8")
    await must(["git", "-C", wtPath, "add", "f.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: f"], wtPath, env)
    const push = await must(["git", "-C", wtPath, "push", "-o", "wait"], wtPath, env)
    const id = push.stderr.match(/bay: (PR\d+) received/)![1]!
    expect(push.stderr).toContain(`${id} rejected`)

    const refuse = await run(["git", "bay", "close", "flaky"], demo, env)
    expect(refuse.code).toBe(1)
    expect(refuse.stderr).toContain(`${id} is rejected`)
    expect(refuse.stderr).toContain(`git bay integrate ${id}`)
    expect(refuse.stderr).toContain(`git bay retry ${id}`)
    expect(refuse.stderr).toContain("git bay close --withdraw")

    // Still open — the refusal is a returned+journaled event, not a crash;
    // state and disk never diverged.
    const stillOpen = await must(["git", "bay", "ls"], demo, env)
    expect(stillOpen.stdout).toContain("flaky")

    // --withdraw teaches nothing more — it withdraws the PR (→ closed) and closes.
    await must(["git", "bay", "close", "--withdraw", "flaky"], demo, env)
    const after = await must(["git", "bay", "ls"], demo, env)
    expect(after.stdout).not.toContain("flaky")
    expect(after.stdout).toContain("no open worktrees")

    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as { prs: Record<string, { state: string }> }
    expect(state.prs[id]!.state).toBe("closed")
  })

  it("close (no --withdraw) proceeds normally once the bay's PR is merged", async () => {
    const opened = await must(["git", "bay", "open", "clean-merge"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "f.txt"), "x\n", "utf8")
    await must(["git", "-C", wtPath, "add", "f.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: f"], wtPath, env)
    // The merge itself closes the bay (via: merged) — so by the time anyone
    // could run `close`, the worktree is already gone. This just proves the
    // merged path never needed --withdraw in the first place.
    await must(["git", "-C", wtPath, "push", "-o", "wait"], wtPath, env)
    const ls = await must(["git", "bay", "ls"], demo, env)
    expect(ls.stdout).toContain("no open worktrees")
  })

  it("close --withdraw on a still-`pushed` (never submitted) PR: pushed → closed", async () => {
    const opened = await must(["git", "bay", "open", "never-submitted"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "f.txt"), "x\n", "utf8")
    await must(["git", "-C", wtPath, "add", "f.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: f"], wtPath, env)
    await must(["git", "-C", wtPath, "push"], wtPath, env) // bare push — PR1 lands `pushed`, nothing else runs

    const refuse = await run(["git", "bay", "close", "never-submitted"], demo, env)
    expect(refuse.code).toBe(1)
    expect(refuse.stderr).toContain("PR1 is pushed")
    expect(refuse.stderr).toContain("git bay close --withdraw")

    await must(["git", "bay", "close", "--withdraw", "never-submitted"], demo, env)
    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as { prs: Record<string, { state: string }> }
    expect(state.prs.PR1!.state).toBe("closed")
  })
})

describe("git bay CLI — push creates (pushed); submit asks to merge and auto-integrates by default (bay.autoMerge)", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-create-submit-"))
    await must(["git", "bay", "init"], demo, env)
    await must(["git", "-C", demo, "config", "bay.check", "true"], demo, env)
    await must(["git", "-C", demo, "config", "bay.merge", "git merge --no-ff {target}"], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("a bare push creates the PR in `pushed` and stops — no checks run, nothing merges", async () => {
    const opened = await must(["git", "bay", "open", "bare-push"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "f.txt"), "x\n", "utf8")
    await must(["git", "-C", wtPath, "add", "f.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: f"], wtPath, env)

    const push = await must(["git", "-C", wtPath, "push"], wtPath, env)
    expect(push.stderr).toMatch(/remote: bay: PR1 opened — git bay submit PR1 when ready/)

    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as { prs: Record<string, { state: string }> }
    expect(state.prs.PR1!.state).toBe("pushed")
  })

  it("git bay submit <PR> auto-integrates by default — one call reaches `merged` (pushed → submitted → ... → merged)", async () => {
    const opened = await must(["git", "bay", "open", "two-step"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "f.txt"), "x\n", "utf8")
    await must(["git", "-C", wtPath, "add", "f.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: f"], wtPath, env)
    await must(["git", "-C", wtPath, "push"], wtPath, env) // creates PR1, pushed

    const submit = await must(["git", "bay", "submit", "PR1"], demo, env)
    expect(submit.stdout).toContain("bay: PR1 submitted → checking")
    expect(submit.stdout).toContain("bay: PR1 checking → checked")
    expect(submit.stdout).toContain("bay: PR1 checked → merging")
    expect(submit.stdout).toContain("bay: PR1 merging → merged")

    const ls = await must(["git", "bay", "ls", "PR1"], demo, env)
    expect(ls.stdout).toContain("PR1 merged")
  })

  it("bay.autoMerge=false rests submit at `submitted` — a separate git bay integrate lands it", async () => {
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
    const opened = await must(["git", "bay", "open", "manual-mode"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "f.txt"), "x\n", "utf8")
    await must(["git", "-C", wtPath, "add", "f.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: f"], wtPath, env)
    await must(["git", "-C", wtPath, "push"], wtPath, env) // creates PR1, pushed

    const submit = await must(["git", "bay", "submit", "PR1"], demo, env)
    expect(submit.stdout).toContain("bay: PR1 submitted — git bay integrate PR1 to land it")

    const integrate = await must(["git", "bay", "integrate"], demo, env)
    expect(integrate.stdout).toContain("bay: PR1 submitted → checking")
    expect(integrate.stdout).toContain("bay: PR1 checking → checked")
    expect(integrate.stdout).toContain("bay: PR1 checked → merging")
    expect(integrate.stdout).toContain("bay: PR1 merging → merged")

    const ls = await must(["git", "bay", "ls", "PR1"], demo, env)
    expect(ls.stdout).toContain("PR1 merged")
  })

  it("git bay submit <branch> --wait forces integration even when bay.autoMerge is false", async () => {
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
    await branchWithFiles(demo, env, "task/waited", { "waited.txt": "waited\n" })

    const submit = await must(["git", "bay", "submit", "task/waited", "--wait"], demo, env)
    expect(submit.stdout).toContain("bay: PR1 submitted → checking")
    expect(submit.stdout).toContain("bay: PR1 checking → checked")
    expect(submit.stdout).toContain("bay: PR1 checked → merging")
    expect(submit.stdout).toContain("bay: PR1 merging → merged")

    const ls = await must(["git", "bay", "ls", "PR1"], demo, env)
    expect(ls.stdout).toContain("PR1 merged")
  })

  it("-o submit fuses create+queue in one push — a red check rejects it directly from the push", async () => {
    await must(["git", "-C", demo, "config", "bay.check", "false"], demo, env)
    const opened = await must(["git", "bay", "open", "fused-red"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "g.txt"), "y\n", "utf8")
    await must(["git", "-C", wtPath, "add", "g.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: g"], wtPath, env)

    const push = await must(["git", "-C", wtPath, "push", "-o", "submit"], wtPath, env)
    expect(push.stderr).toMatch(/remote: bay: PR1 received — checks running/)
    expect(push.stderr).toMatch(/remote: bay: PR1 rejected — check 'false' failed \(exit 1\)/)
  })

  it("retired bay.autoQueue is ignored; use bay.autoSubmit or -o submit for fused submit", async () => {
    await must(["git", "-C", demo, "config", "bay.autoQueue", "true"], demo, env)
    const opened = await must(["git", "bay", "open", "retired-autoqueue"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "h.txt"), "z\n", "utf8")
    await must(["git", "-C", wtPath, "add", "h.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: h"], wtPath, env)

    const push = await must(["git", "-C", wtPath, "push"], wtPath, env) // NO -o option at all
    expect(push.stderr).toMatch(/remote: bay: PR1 opened — git bay submit PR1 when ready/)

    const ls = await must(["git", "bay", "ls", "PR1"], demo, env)
    expect(ls.stdout).toContain("PR1 pushed")
  })

  it("bay.autoSubmit=true makes a bare push submit too — with autoMerge still on by default, it ships all the way", async () => {
    await must(["git", "-C", demo, "config", "bay.autoSubmit", "true"], demo, env)
    const opened = await must(["git", "bay", "open", "auto-submit"], demo, env)
    const wtPath = opened.stdout.trim()
    await writeFile(join(wtPath, "j.txt"), "z\n", "utf8")
    await must(["git", "-C", wtPath, "add", "j.txt"], wtPath, env)
    await must(["git", "-C", wtPath, "commit", "-qm", "feat: j"], wtPath, env)

    const push = await must(["git", "-C", wtPath, "push"], wtPath, env) // NO -o option at all
    expect(push.stderr).toMatch(/remote: bay: PR1 received — checks running/)
    expect(push.stderr).toMatch(/remote: bay: PR1 merged onto main \(checks ✓\)/)
  })

  it("submit on an unknown PR-shaped id teaches the PR/name/branch addressing model", async () => {
    const res = await run(["git", "bay", "submit", "PR999"], demo, env)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("'PR999' is not a known PR, bay, or branch")
    expect(res.stderr).toContain("git bay ls lists PRs and bays; git branch lists branches")
  })

  it("submit refuses a PR that is already submitted", async () => {
    // Rest at `submitted` so the second submit call finds it still there —
    // otherwise the first call's default auto-integrate would already have
    // landed it, and the second call would report "already merged" instead.
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)
    await must(["git", "-C", demo, "branch", "task/dup"], demo, env)
    const id = (await must(["git", "bay", "adopt", "task/dup"], demo, env)).stdout.trim()
    await must(["git", "bay", "submit", id], demo, env)
    const res = await run(["git", "bay", "submit", id], demo, env)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain(`${id} is already submitted`)
  })
})

describe("git bay CLI — one merge seam (21002): retry re-runs the gates, never bypasses them", () => {
  let root: string
  let demo: string
  let env: Record<string, string>

  beforeEach(async () => {
    ;({ root, demo, env } = await makeFixture("bay-seam-"))
    await must(["git", "bay", "init"], demo, env)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("PR4 shape: a merge-command refusal STANDS on retry — the command re-runs, mainline never moves", async () => {
    const checkCalls = join(root, "check-calls.log")
    const check = join(root, "check.sh")
    await writeFile(check, `#!/bin/sh\necho check >> ${checkCalls}\n`, "utf8")
    await chmod(check, 0o755)

    const calls = join(root, "gate-calls.log")
    const refuse = join(root, "refuse.sh")
    await writeFile(refuse, `#!/bin/sh\necho run >> ${calls}\necho "reviewer-not-author gate: refused" >&2\nexit 1\n`, "utf8")
    await chmod(refuse, 0o755)
    await must(["git", "-C", demo, "config", "bay.check", check], demo, env)
    await must(["git", "-C", demo, "config", "bay.merge", refuse], demo, env)
    await must(["git", "-C", demo, "config", "bay.autoMerge", "false"], demo, env)

    await branchWithFiles(demo, env, "task/a", { "a.txt": "a\n" })
    const headBefore = (await must(["git", "-C", demo, "rev-parse", "HEAD"], demo, env)).stdout.trim()
    await must(["git", "bay", "adopt", "task/a"], demo, env)
    await must(["git", "bay", "submit", "PR1"], demo, env)

    const first = await must(["git", "bay", "integrate", "PR1"], demo, env)
    expect(first.stdout).toContain("merging → rejected")

    // The documented recovery verb: it must RE-RUN the pipeline (the merge
    // command fires again) and the refusal must stand — the LE-1 production
    // incident was retry raw-merging past the exact gate that had refused.
    const retried = await run(["git", "bay", "retry", "PR1"], demo, env)
    expect(retried.code).toBe(0)

    const log = (await import("node:fs")).readFileSync(calls, "utf8").trim().split("\n")
    expect(log).toHaveLength(2) // once per attempt — the gate ran BOTH times
    const checkLog = (await readFile(checkCalls, "utf8")).trim().split("\n")
    expect(checkLog).toHaveLength(1) // the successful check was reused on retry

    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as {
      prs: Record<string, { state: string }>
      line: { items: { pr: string; steps: { check?: { skipped?: boolean } } }[] }
    }
    expect(state.prs.PR1!.state).toBe("rejected")
    expect(state.line.items.find((item) => item.pr === "PR1")?.steps.check?.skipped).toBe(true)

    const headAfter = (await must(["git", "-C", demo, "rev-parse", "HEAD"], demo, env)).stdout.trim()
    expect(headAfter).toBe(headBefore) // no ungated merge ever touched the mainline
  })

  it("recovers orphaned inbox claims and never overwrites them (LE-3)", async () => {
    await branchWithFiles(demo, env, "task/a", { "a.txt": "a\n" })
    await branchWithFiles(demo, env, "task/b", { "b.txt": "b\n" })
    const shaA = (await must(["git", "-C", demo, "rev-parse", "task/a"], demo, env)).stdout.trim()
    const shaB = (await must(["git", "-C", demo, "rev-parse", "task/b"], demo, env)).stdout.trim()
    const bayDir = join(demo, ".git", "bay")
    // A crashed ingest's orphaned claim + a fresh inbox — BOTH must be drained.
    await writeFile(join(bayDir, "inbox.jsonl.processing-99999-1"), JSON.stringify({ branch: "task/a", sha: shaA }) + "\n", "utf8")
    await writeFile(join(bayDir, "inbox.jsonl"), JSON.stringify({ branch: "task/b", sha: shaB }) + "\n", "utf8")

    await must(["git", "bay", "integrate"], demo, env)

    const json = await must(["git", "bay", "ls", "--json"], demo, env)
    const state = JSON.parse(json.stdout) as { prs: Record<string, { state: string }> }
    // v0.3 default: push CREATES (`pushed`) — the LE-3 guarantee is that no
    // receipt is ever dropped, not that receipts auto-merge.
    const states = Object.values(state.prs).map((p) => p.state)
    expect(states).toHaveLength(2)
    for (const s of states) expect(s).toBe("pushed")

    const { readdirSync } = await import("node:fs")
    const leftovers = readdirSync(bayDir).filter((f) => f.startsWith("inbox.jsonl"))
    expect(leftovers).toEqual([]) // claims are consumed, never accumulated
  })
})
