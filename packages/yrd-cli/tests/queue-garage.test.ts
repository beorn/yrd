/**
 * @failure The garage's truth lives somewhere yrd cannot read without hab, so
 *          the queue timeline prints "NO RUNNER - habitant runner [pid] died …;
 *          restart it" while the queue is in the garage — false, and the one
 *          act the garage forbids. Or the resident starts anyway, takes the
 *          queue-runner lease, and drains beside the mechanic.
 * @level   l3
 * @consumer the mechanic reading the queue timeline · hab starting the service ·
 *           anyone told to restart a runner that must stay down
 *
 * Black box on a scratch repository: the CLI opens and closes the garage, and
 * every other surface is read the way its reader reads it. The declaration is a
 * ref, so one case writes it with plain git — proving yrd needs nothing of its
 * own booted to see a garage, which is the whole reason the fact moved into
 * git.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runYrdProcess } from "../src/host.ts"
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

/** A repository with a queue, and nothing of yrd's own yet written into it. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-garage-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Garage")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, ".yrd.yml"), "base: main\n")
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
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", "--repo", repo, ...args], run.io)
  return {
    exitCode,
    stdout: run.stdout(),
    stderr: run.stderr(),
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${run.stdout()}\n--- stderr ---\n${run.stderr()}`,
  }
}

/**
 * The garage as the queue's own JSON reports it. Driven through the `status`
 * spelling, which the invocation table canonicalizes to `list` — the mechanic
 * reaches this view by that name, so that is the name under test.
 */
async function garageOfStatus(repo: string): Promise<unknown> {
  const status = await yrd(repo, "queue", "status", "--json")
  expect(status.exitCode, status.report).toBe(0)
  const parsed = JSON.parse(status.stdout) as { projection?: { garage?: unknown } }
  if (parsed.projection === undefined) throw new Error(`the queue's JSON carried no projection\n${status.report}`)
  return parsed.projection.garage
}

describe("the garage is a declaration in git", () => {
  it("opens, is read back by every surface, and closes", async () => {
    const repo = await repository()

    const opened = await yrd(repo, "queue", "garage", "open", "--reason", "rebuilding the core")
    expect(opened.exitCode, opened.report).toBe(0)
    expect(await git(repo, "rev-parse", "--verify", GARAGE_REF)).toMatch(/^[0-9a-f]{40,64}$/u)

    // No parent, so the declaration carries none of the project's history.
    expect(await git(repo, "log", "-1", "--format=%P", GARAGE_REF)).toBe("")
    expect(await git(repo, "log", "-1", "--format=%s", GARAGE_REF)).toBe("garage: rebuilding the core")

    const garage = (await garageOfStatus(repo)) as { reason?: unknown; since?: unknown; by?: unknown }
    expect(garage.reason).toBe("rebuilding the core")
    expect(garage.by).toBe("operator")
    expect(typeof garage.since === "string" && !Number.isNaN(Date.parse(garage.since))).toBe(true)

    const closed = await yrd(repo, "queue", "garage", "close")
    expect(closed.exitCode, closed.report).toBe(0)
    expect(existsSync(join(repo, ".git", "refs", "yrd", "garage"))).toBe(false)
    await expect(git(repo, "rev-parse", "--verify", GARAGE_REF)).rejects.toThrow()
    expect(await garageOfStatus(repo)).toBe(null)
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

  it("prints the reason instead of telling the reader to restart a runner", async () => {
    const repo = await repository()

    const before = await yrd(repo, "queue", "status")
    expect(before.exitCode, before.report).toBe(0)
    expect(before.stdout, "the defect this file is about needs the old text to exist first").toContain("NO RUNNER")

    const opened = await yrd(repo, "queue", "garage", "open", "--reason", "rebuilding the core")
    expect(opened.exitCode, opened.report).toBe(0)

    const during = await yrd(repo, "queue", "status")
    expect(during.exitCode, during.report).toBe(0)
    expect(during.stdout).toContain("garage: rebuilding the core since ")
    expect(during.stdout).toContain(" by operator")
    expect(during.stdout).not.toContain("NO RUNNER")
    expect(during.stdout).not.toContain("restart it")
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
    expect((await garageOfStatus(repo)) as { by?: unknown }).toMatchObject({ by: "@cto" })
  })

  it("stops the service on one line, before it takes the lease or writes anything", async () => {
    const repo = await repository()
    // Written with plain git, in a repository yrd has never run in: the garage
    // is a fact of the repository, not of yrd's state.
    const tree = await git(repo, "mktree")
    const commit = await git(repo, "commit-tree", tree, "-m", "garage: rebuilding the core\n\nOpened-By: @cto\n")
    await git(repo, "update-ref", GARAGE_REF, commit)
    expect(existsSync(join(repo, ".git", "yrd")), "yrd has written nothing here yet").toBe(false)

    // `queue up` is the service — one round on a loop — and the only spelling
    // the garage refuses.
    const service = await yrd(repo, "queue", "up")

    expect(service.exitCode, service.report).toBe(2)
    expect(service.stderr.trimEnd()).toBe("garage: rebuilding the core; the service stays down until the garage closes")
    expect(service.stdout).toBe("")
    // No lease, no journal, no state at all: the refusal happens before the
    // host that would take them is built.
    expect(existsSync(join(repo, ".git", "yrd")), service.report).toBe(false)
  })

  it("lets the mechanic's own queue run through", async () => {
    // `queue run` is one round, by hand: the thing a garage exists to let
    // somebody do.
    const repo = await repository()
    const opened = await yrd(repo, "queue", "garage", "open", "--reason", "rebuilding the core")
    expect(opened.exitCode, opened.report).toBe(0)

    const byHand = await yrd(repo, "queue", "run", "--json")
    // Nothing to do in an empty queue, so this is the ordinary "next" exit.
    expect(byHand.exitCode, byHand.report).toBe(0)
    expect(JSON.parse(byHand.stdout)).toMatchObject({ garage: "rebuilding the core" })
  })
})
