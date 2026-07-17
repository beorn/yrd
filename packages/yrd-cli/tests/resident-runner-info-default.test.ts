/**
 * @failure The resident follow-runner stays at WARN so completed run/compose settlements — successes especially — never print, or the INFO bump leaks into one-shot commands as yrd:journal:lock spam.
 * @level l3
 * @consumer @yrd/cli resident follow-runner operators
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runYrdProcess } from "../src/host.ts"

const roots: string[] = []
const YRD_BIN = join(import.meta.dirname, "../../../bin/yrd.ts")

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function runnerRepo(): Promise<{ repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-resident-info-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nsteps: [check]\ncheck: "true"\n')
  await git(repo, "add", "README.md", ".yrd.yml")
  await git(repo, "commit", "-qm", "main")
  return { repo }
}

async function readRecords(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8").catch(() => "")
  return text
    .trim()
    .split("\n")
    .filter((entry) => entry !== "")
    .map((entry) => JSON.parse(entry) as Record<string, unknown>)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("resident follow-runner INFO-by-default", () => {
  it("prints compose settlements — successes included — at INFO with timing", async () => {
    // A WARN runner would never write a completed `compose succeeded`: at the
    // default level the success case simply vanishes. The resident INFO bump
    // makes every drain cycle print its settlement with duration. Assert against
    // the structured sink so the proof is format-independent (item 4 restyles the
    // human-facing output; the JSONL record stays the anchor).
    const { repo } = await runnerRepo()
    const logFile = join(repo, "resident.jsonl")
    const cli = Bun.spawn([process.execPath, YRD_BIN, "--repo", repo, "queue", "run", "--interval", "1"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LOGGILY_FILE: logFile, NO_COLOR: "1" },
    })
    const drainStdout = new Response(cli.stdout).text()
    const drainStderr = new Response(cli.stderr).text()
    try {
      await vi.waitFor(
        async () => {
          const records = await readRecords(logFile)
          const composeDone = records.find(
            (r) => r.name === "yrd:queue:compose" && r.outcome === "succeeded" && r.level === "info",
          )
          expect(composeDone, "no INFO yrd:queue:compose succeeded settlement").toBeDefined()
          expect(composeDone).toMatchObject({ msg: "compose succeeded", durationMs: expect.any(Number) })
        },
        { timeout: 20_000, interval: 200 },
      )
      cli.kill("SIGTERM")
      expect(await cli.exited, await drainStderr).toBe(0)
    } finally {
      cli.kill("SIGKILL")
      await cli.exited
      await drainStdout
      await drainStderr
    }
  }, 30_000)

  it("keeps one-shot non-runner commands at WARN — no yrd:journal:lock INFO spam", async () => {
    const { repo } = await runnerRepo()
    const logFile = join(repo, "one-shot.jsonl")
    const previous = process.env.LOGGILY_FILE
    process.env.LOGGILY_FILE = logFile
    const stderr: string[] = []
    try {
      await runYrdProcess(["yrd", "--repo", repo, "queue", "--json"], {
        cwd: repo,
        stdout: () => {},
        stderr: (text) => stderr.push(text),
        color: false,
      })
    } finally {
      if (previous === undefined) delete process.env.LOGGILY_FILE
      else process.env.LOGGILY_FILE = previous
    }
    const records = await readRecords(logFile)
    expect(records.some((r) => r.level === "info" && String(r.name).startsWith("yrd:journal:lock"))).toBe(false)
    expect(records.some((r) => r.level === "info")).toBe(false)
    expect(stderr.join("")).not.toContain("journal:lock")
  }, 20_000)
})
