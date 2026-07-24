/**
 * @failure `yrd bay run` loses work, returns before cleanup, or leaves a failed child unflagged.
 * @level l3
 * @consumer @yrd/cli bay run
 */
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runYrdProcess } from "../src/host.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
const CLAIM = "@km/test/s2-fixture"
const BRANCH = "task/s2-fixture"

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("yrd bay run", { timeout: 30_000 }, () => {
  it("creates a branch-backed draft, runs exact argv, and closes the clean Bay synchronously", async () => {
    const { repo } = await repository()
    const run = output(repo)

    expect(
      await yrd(
        repo,
        run.io,
        "bay",
        "run",
        CLAIM,
        "--",
        "sh",
        "-c",
        "test \"$1\" = 'literal $HOME'",
        "_",
        "literal $HOME",
      ),
      run.stderr(),
    ).toBe(0)

    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(`${repo}/.bays/`)
    expect(await git(repo, "rev-parse", `refs/remotes/origin/${BRANCH}`)).toMatch(/^[0-9a-f]{40}$/u)

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    const bayRows = JSON.parse(bays.stdout()) as {
      bays: readonly { issue?: string; status: string }[]
    }
    expect(bayRows.bays.filter((bay) => bay.issue === CLAIM && bay.status !== "closed")).toHaveLength(0)

    const prs = output(repo)
    expect(await yrd(repo, prs.io, "pr", "list", "--issue", CLAIM, "--json"), prs.stderr()).toBe(0)
    expect(JSON.parse(prs.stdout())).toMatchObject({
      prs: [{ branch: BRANCH, issue: CLAIM, status: "pushed" }],
    })
  })

  it("commits and pushes root work as `wip:` before synchronously closing", async () => {
    const { repo } = await repository()
    const run = output(repo)

    expect(
      await yrd(repo, run.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf payload > scratch.txt"),
      run.stderr(),
    ).toBe(0)

    expect(await git(repo, "log", `refs/remotes/origin/${BRANCH}`, "-1", "--format=%s")).toMatch(/^wip:/u)
    expect(await git(repo, "show", `refs/remotes/origin/${BRANCH}:scratch.txt`)).toBe("payload")
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(`${repo}/.bays/`)
  })

  it("reopens a closed claim and updates the same draft on a later run", async () => {
    const { repo } = await repository()
    const clean = output(repo)
    expect(await yrd(repo, clean.io, "bay", "run", CLAIM, "--", "true"), clean.stderr()).toBe(0)

    const dirty = output(repo)
    expect(
      await yrd(repo, dirty.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf later > later.txt"),
      dirty.stderr(),
    ).toBe(0)

    expect(await git(repo, "log", `refs/remotes/origin/${BRANCH}`, "-1", "--format=%s")).toMatch(/^wip:/u)
    const prs = output(repo)
    expect(await yrd(repo, prs.io, "pr", "list", "--issue", CLAIM, "--json"), prs.stderr()).toBe(0)
    expect(JSON.parse(prs.stdout())).toMatchObject({
      prs: [{ branch: BRANCH, issue: CLAIM, status: "pushed", revision: 2 }],
    })
  })

  it("uses the branch of an existing claim draft instead of minting a second PR", async () => {
    const { repo } = await repository()
    const branch = "topic/existing-claim"
    await git(repo, "switch", "-qc", branch)
    await writeFile(join(repo, "claim.txt"), "existing\n")
    await git(repo, "add", "claim.txt")
    await git(repo, "commit", "-qm", "existing claim")
    await git(repo, "push", "-q", "-u", "origin", branch)
    await git(repo, "switch", "-q", "main")

    const draft = output(repo)
    expect(await yrd(repo, draft.io, "pr", "create", branch, "--issue", CLAIM), draft.stderr()).toBe(0)
    const run = output(repo)
    expect(
      await yrd(repo, run.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf continued > continued.txt"),
      run.stderr(),
    ).toBe(0)

    expect(await git(repo, "show", `refs/remotes/origin/${branch}:continued.txt`)).toBe("continued")
    const prs = output(repo)
    expect(await yrd(repo, prs.io, "pr", "list", "--issue", CLAIM, "--json"), prs.stderr()).toBe(0)
    expect(JSON.parse(prs.stdout())).toMatchObject({
      prs: [{ branch, issue: CLAIM, status: "pushed", revision: 2 }],
    })
  })

  it("refuses to publish an unrelated pre-existing task branch and records the failed bracket", async () => {
    const { repo } = await repository()
    const claim = "@km/test/foreign"
    const branch = "task/foreign"
    await git(repo, "switch", "-qc", branch)
    await writeFile(join(repo, "foreign.txt"), "unrelated\n")
    await git(repo, "add", "foreign.txt")
    await git(repo, "commit", "-qm", "unrelated task branch")
    await git(repo, "switch", "-q", "main")

    const run = output(repo)
    expect(await yrd(repo, run.io, "bay", "run", claim, "--", "true"), run.stderr()).not.toBe(0)
    expect(await git(repo, "ls-remote", "origin", `refs/heads/${branch}`)).toBe("")

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    expect(JSON.parse(bays.stdout())).toMatchObject({
      bays: [
        expect.objectContaining({
          issue: claim,
          orphan: expect.objectContaining({ reason: expect.stringContaining("pre-child setup failed") }),
        }),
      ],
    })
  })

  it("keeps distinct full claims with the same basename on distinct PR branches", async () => {
    const { repo } = await repository()
    const firstClaim = "@km/a/shared-slug"
    const secondClaim = "@ag/b/shared-slug"
    const first = output(repo)
    expect(await yrd(repo, first.io, "bay", "run", firstClaim, "--", "true"), first.stderr()).toBe(0)
    await writeFile(join(repo, "advance.txt"), "new base\n")
    await git(repo, "add", "advance.txt")
    await git(repo, "commit", "-qm", "advance base")
    await git(repo, "push", "-q", "origin", "main")
    const second = output(repo)
    expect(await yrd(repo, second.io, "bay", "run", secondClaim, "--", "true"), second.stderr()).toBe(0)

    const prs = output(repo)
    expect(await yrd(repo, prs.io, "pr", "list", "--json"), prs.stderr()).toBe(0)
    const rows = (JSON.parse(prs.stdout()) as { prs: readonly { branch: string; issue?: string }[] }).prs.filter(
      (pr) => pr.issue === firstClaim || pr.issue === secondClaim,
    )
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((pr) => pr.branch))).toHaveProperty("size", 2)
  })

  it("resolves a repeated claim's active orphan by its friendly Bay name", async () => {
    const { repo } = await repository()
    const claim = "@km/test/alias-active"
    const clean = output(repo)
    expect(await yrd(repo, clean.io, "bay", "run", claim, "--", "true"), clean.stderr()).toBe(0)
    const failed = output(repo)
    expect(await yrd(repo, failed.io, "bay", "run", claim, "--", "sh", "-c", "exit 17"), failed.stderr()).toBe(1)

    const path = output(repo)
    expect(await yrd(repo, path.io, "bay", "path", "alias-active"), path.stderr()).toBe(0)
    expect(path.stdout()).toContain(join(repo, ".bays", "B2"))
  })

  it("does not rewrite an existing orphan when a duplicate active claim is refused", async () => {
    const { repo } = await repository()
    const failed = output(repo)
    expect(await yrd(repo, failed.io, "bay", "run", CLAIM, "--", "sh", "-c", "exit 17"), failed.stderr()).toBe(1)

    const duplicate = output(repo)
    expect(await yrd(repo, duplicate.io, "bay", "run", CLAIM, "--", "true"), duplicate.stderr()).not.toBe(0)

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    expect(JSON.parse(bays.stdout())).toMatchObject({
      bays: [
        expect.objectContaining({
          issue: CLAIM,
          orphan: expect.objectContaining({ reason: expect.stringContaining("child exited 17") }),
        }),
      ],
    })
  })

  it("inherits piped stdin even when child output is captured", async () => {
    const { repo } = await repository()
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "../../../bin/yrd.ts"),
        "--repo",
        repo,
        "bay",
        "run",
        "@km/test/stdin",
        "--",
        "sh",
        "-c",
        'read value && test "$value" = payload',
      ],
      { cwd: repo, env: process.env, stdin: new Blob(["payload\n"]), stdout: "pipe", stderr: "pipe" },
    )
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exitCode, stderr).toBe(0)
  })

  it("preserves and durably flags a failed child's Bay instead of closing it", async () => {
    const { repo } = await repository()
    const run = output(repo)

    expect(
      await yrd(repo, run.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf preserve > crash.txt; exit 17"),
      run.stderr(),
    ).toBe(1)

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    const projection = JSON.parse(bays.stdout()) as {
      bays: readonly {
        issue?: string
        status: string
        path?: string
        orphan?: { exitCode?: number; reason: string }
      }[]
    }
    const orphan = projection.bays.find((bay) => bay.issue === CLAIM && bay.orphan !== undefined)
    expect(orphan).toMatchObject({
      status: "active",
      orphan: { exitCode: 17, reason: expect.stringContaining("child exited 17") },
    })
    if (orphan?.path === undefined) throw new Error("orphaned Bay did not retain its workspace path")
    expect(await readFile(join(orphan.path, "crash.txt"), "utf8")).toBe("preserve")
  })

  it("records an interrupted child as orphan before signal shutdown closes the runtime", async () => {
    const { repo } = await repository()
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "../../../bin/yrd.ts"),
        "--repo",
        repo,
        "bay",
        "run",
        CLAIM,
        "--",
        "sh",
        "-c",
        "printf started > child.started; while :; do sleep 1; done",
      ],
      { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" },
    )
    await eventually(async () => access(join(repo, ".bays", "B1", "child.started")))

    child.kill("SIGTERM")
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exitCode, stderr).not.toBe(0)

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    expect(JSON.parse(bays.stdout())).toMatchObject({
      bays: [
        expect.objectContaining({
          issue: CLAIM,
          status: "active",
          orphan: expect.objectContaining({ reason: expect.stringContaining("child exited after SIGTERM") }),
        }),
      ],
    })
  })

  it("records an interruption during the post-child checkpoint before closing the Bay", async () => {
    const { repo } = await repository()
    const origin = await git(repo, "remote", "get-url", "origin")
    const marker = join(origin, "..", "post-child.push")
    const hook = join(origin, "hooks", "pre-receive")
    await writeFile(
      hook,
      [
        "#!/bin/sh",
        "while read -r _old new _ref; do",
        '  if git cat-file -e "$new:post-child.txt" 2>/dev/null; then',
        `    : > ${JSON.stringify(marker)}`,
        "    sleep 2",
        "  fi",
        "done",
        "",
      ].join("\n"),
    )
    await chmod(hook, 0o755)

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "../../../bin/yrd.ts"),
        "--repo",
        repo,
        "bay",
        "run",
        CLAIM,
        "--",
        "sh",
        "-c",
        "printf payload > post-child.txt",
      ],
      { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" },
    )
    await eventually(async () => access(marker))

    child.kill("SIGTERM")
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exitCode, stderr).not.toBe(0)

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    expect(JSON.parse(bays.stdout())).toMatchObject({
      bays: [
        expect.objectContaining({
          issue: CLAIM,
          status: "active",
          orphan: expect.objectContaining({
            reason: expect.stringContaining("interrupted during post-child checkpoint"),
          }),
        }),
      ],
    })
  })
})

async function repository(): Promise<{ repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-bay-run-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  const origin = join(root, "origin.git")
  await git(root, "init", "-q", "--bare", origin)
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await git(repo, "remote", "add", "origin", origin)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nsteps: [check, merge]\ncheck: "true"\nmerge: {}\n')
  await git(repo, "add", "README.md", ".yrd.yml")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "push", "-q", "-u", "origin", "main")
  return { repo }
}

function output(cwd: string): {
  io: YrdCliIO
  stdout(): string
  stderr(): string
} {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      cwd,
      color: false,
      stdout(text) {
        stdout += text
      },
      stderr(text) {
        stderr += text
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

function yrd(repo: string, io: YrdCliIO, ...args: string[]): Promise<0 | 1 | 2 | 3> {
  return runYrdProcess([process.execPath, "/usr/local/bin/yrd", "--repo", repo, ...args], io)
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function eventually(check: () => Promise<unknown>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await check()
      return
    } catch (error) {
      lastError = error
      await Bun.sleep(25)
    }
  }
  throw lastError ?? new Error(`condition did not become true within ${timeoutMs}ms`)
}
