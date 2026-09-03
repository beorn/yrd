/**
 * @failure The garage's truth lives somewhere yrd cannot read without hab, so
 *          the service starts anyway and drains beside the mechanic; or the
 *          mechanic's own round is refused along with it.
 * @level   l3
 * @consumer the mechanic working the queue by hand · hab starting the service
 *
 * Black box on a throwaway repository: the CLI opens and closes the garage, and
 * every fact is read back off the ref with plain git — proving yrd needs
 * nothing of its own booted to see a garage, which is the whole reason the
 * fact lives in git.
 *
 * The old core's `queue status` projection of the garage went with it at M6;
 * what a queue run stamps on its own record is `tests/boundary/
 * queue-garage.test.ts`, on a repository with a real queue.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runYrdProcess } from "../src/cli.ts"
import { GARAGE_REF } from "../src/garage.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${String(code)}: ${stderr || stdout}`)
  return stdout.trim()
}

/** A repository with a declaration, and nothing of yrd's own yet written into it. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-garage-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Garage")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, ".yrd.yml"), 'target: "origin#main"\n')
  await git(repo, "add", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  return repo
}

type Capture = Readonly<{ io: YrdCliIO; stdout(): string; stderr(): string }>

function capture(cwd: string): Capture {
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

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

async function yrd(repo: string, ...args: string[]): Promise<Ran> {
  const run = capture(repo)
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], run.io)
  return {
    exitCode,
    stdout: run.stdout(),
    stderr: run.stderr(),
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${run.stdout()}\n--- stderr ---\n${run.stderr()}`,
  }
}

describe("the garage is a declaration in git", () => {
  it("opens, is readable with plain git, and closes", async () => {
    const repo = await repository()

    const opened = await yrd(repo, "queue", "garage", "open", "--reason", "rebuilding the core")
    expect(opened.exitCode, opened.report).toBe(0)
    expect(await git(repo, "rev-parse", "--verify", GARAGE_REF)).toMatch(/^[0-9a-f]{40,64}$/u)

    // No parent, so the declaration carries none of the project's history.
    expect(await git(repo, "log", "-1", "--format=%P", GARAGE_REF)).toBe("")
    expect(await git(repo, "log", "-1", "--format=%s", GARAGE_REF)).toBe("garage: rebuilding the core")
    expect(opened.stdout).toContain("garage: rebuilding the core since ")
    expect(opened.stdout).toContain(" by operator")

    const closed = await yrd(repo, "queue", "garage", "close")
    expect(closed.exitCode, closed.report).toBe(0)
    expect(existsSync(join(repo, ".git", "refs", "yrd", "garage"))).toBe(false)
    await expect(git(repo, "rev-parse", "--verify", GARAGE_REF)).rejects.toThrow()
  })

  it("refuses a second open and names whose garage it already is", async () => {
    const repo = await repository()
    const first = await yrd(repo, "queue", "garage", "open", "--reason", "rebuilding the core")
    expect(first.exitCode, first.report).toBe(0)

    const second = await yrd(repo, "queue", "garage", "open", "--reason", "something else")
    expect(second.exitCode, second.report).not.toBe(0)
    expect(second.stderr).toContain("rebuilding the core")
    // The second reason never becomes the record.
    expect(await git(repo, "log", "-1", "--format=%s", GARAGE_REF)).toBe("garage: rebuilding the core")
  })

  it("refuses a close when no garage is open", async () => {
    const repo = await repository()
    const closed = await yrd(repo, "queue", "garage", "close")
    expect(closed.exitCode, closed.report).not.toBe(0)
    expect(closed.stderr).toContain("garage")
  })

  it("names the seat that opened it", async () => {
    const repo = await repository()
    const previous = process.env["YRD_DEFAULT_SUBMITTER"]
    process.env["YRD_DEFAULT_SUBMITTER"] = "@cto"
    try {
      const opened = await yrd(repo, "queue", "garage", "open", "--reason", "rebuilding the core")
      expect(opened.exitCode, opened.report).toBe(0)
    } finally {
      if (previous === undefined) delete process.env["YRD_DEFAULT_SUBMITTER"]
      else process.env["YRD_DEFAULT_SUBMITTER"] = previous
    }
    expect(await git(repo, "log", "-1", "--format=%(trailers:key=Opened-By,valueonly)", GARAGE_REF)).toBe("@cto")
  })

  it("stops the service on one line, before it reads a remote or writes anything", async () => {
    const repo = await repository()
    // Written with plain git, in a repository yrd has never run in: the garage
    // is a fact of the repository, not of yrd's state.
    const tree = await git(repo, "mktree")
    const commit = await git(repo, "commit-tree", tree, "-m", "garage: rebuilding the core\n\nOpened-By: @cto\n")
    await git(repo, "update-ref", GARAGE_REF, commit)
    expect(existsSync(join(repo, ".git", "yrd-core")), "yrd has written nothing here yet").toBe(false)

    // `queue up` is the service — one round on a loop — and the only spelling
    // the garage refuses.
    const service = await yrd(repo, "queue", "up")

    expect(service.exitCode, service.report).toBe(2)
    expect(service.stderr.trimEnd()).toBe("garage: rebuilding the core; the service stays down until the garage closes")
    expect(service.stdout).toBe("")
    // The refusal happens before the queue's own directory is made.
    expect(existsSync(join(repo, ".git", "yrd-core")), service.report).toBe(false)
  })
})
