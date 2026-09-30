/**
 * @failure A portable run address could select the wrong queue, hide a missing journal as an unknown run,
 *          or print success for a number absent from the authoritative index.
 * @level l3 (real remote and CLI streams)
 * @consumer yrd runs show
 * @testonly none
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { appendNumberedChangeEvent, createEventStore, readStatus, selectionFor, submit } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { resolveQueueLocation } from "../src/queue-location.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
const priorEnvironment = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
}
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const transport = "https://yrd-run-address.invalid/org/product.git"
const address = "yrd-run-address.invalid/org/product@main"

async function fixture(): Promise<{ root: string; work: string }> {
  const root = mkdtempSync(join(tmpdir(), "yrd-run-address-command-"))
  roots.push(root)
  const fixtureConfigDir = join(root, "git-config")
  mkdirSync(fixtureConfigDir)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  writeFileSync(
    join(fixtureConfigDir, ".gitconfig"),
    ['[protocol "file"]', "\tallow = always", `[url "file://${remote}"]`, `\tinsteadOf = ${transport}`, ""].join("\n"),
  )
  process.env.GIT_CONFIG_GLOBAL = join(fixtureConfigDir, ".gitconfig")
  process.env.XDG_STATE_HOME = join(root, "state")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  await git(["remote", "set-url", "origin", transport])
  await birthEventQueue(work, "main", { localStore: false })
  await git(["checkout", "--quiet", "-b", "task/one", "main"])
  writeFileSync(join(work, "one.txt"), "one\n")
  await git(["add", "one.txt"])
  await git(["commit", "--quiet", "-m", "one"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", { branch: "task/one", submitter: "author", target: { branch: "main", remote: "origin" } })
  const status = await readStatus(createEventStore(work, "origin", selectionFor(git)), "main", "task/one")
  if (status.tip === undefined) throw new Error("fixture has no change tip")
  await appendNumberedChangeEvent(
    createEventStore(work, "origin", selectionFor(git)),
    "main",
    "task/one",
    status.tip,
    { type: "verifying", at: new Date(), commit: head },
    { id: "opaque-test-run", startedAt: "2026-09-27T12:00:00.000Z", host: "test-host", actor: "yrd" },
  )
  return { root, work }
}

async function yrd(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    color: false,
    cwd,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  }
  const code = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], io)
  return { code, stdout, stderr }
}

describe("yrd runs show", () => {
  it("names the missing remote index for an existing queue (26193)", async () => {
    const { work } = await fixture()
    await gitIn(work)(["push", "--quiet", "origin", ":refs/yrd/main/runs"])
    const shown = await yrd(work, "runs", "show", `${address}#1`, "--json")
    expect(shown.code).toBe(2)
    expect(shown.stdout).toBe("")
    expect(shown.stderr).toContain("E_RUN_INDEX_MISSING")
    expect(shown.stderr).toContain("refs/yrd/main/runs")
    expect(shown.stderr).toContain("origin")
  }, 60_000)

  it("returns an indexed record with explicit unavailable local detail and byte-clean JSON (26193)", async () => {
    const { work } = await fixture()
    const shown = await yrd(work, "runs", "show", `${address}#1`, "--json")
    expect(shown.code, shown.stderr).toBe(0)
    expect(shown.stderr).toBe("")
    expect(JSON.parse(shown.stdout)).toMatchObject({
      address: `${address}#1`,
      number: 1,
      record: { id: "opaque-test-run" },
      detail: { status: "unavailable", reason: expect.stringContaining("absent on this host") },
    })
    const human = await yrd(work, "runs", "show", `${address}#1`)
    expect(human.code, human.stderr).toBe(0)
    const parsed = JSON.parse(shown.stdout) as { record: { firstQueueTip: string } }
    expect(human.stdout).toContain(`first queue tip ${parsed.record.firstQueueTip}`)
    const location = await resolveQueueLocation(work, address, process.env)
    const logs = join(location.workdir, "logs")
    mkdirSync(logs, { recursive: true })
    writeFileSync(
      join(logs, "opaque-test-run.jsonl"),
      `${JSON.stringify({
        kind: "run",
        run: "opaque-test-run",
        at: "2026-09-27T12:00:00.000Z",
        target: "main",
      })}\n`,
    )
    const withJournal = await yrd(work, "runs", "show", `${address}#1`, "--json")
    expect(withJournal.code, withJournal.stderr).toBe(0)
    expect(JSON.parse(withJournal.stdout)).toMatchObject({
      detail: { status: "available", records: [{ kind: "run", run: "opaque-test-run" }] },
    })
    const unknown = await yrd(work, "runs", "show", `${address}#2`, "--json")
    expect(unknown.code).toBe(2)
    expect(unknown.stdout).toBe("")
    expect(unknown.stderr).toContain("E_RUN_UNKNOWN")
    expect(unknown.stderr).toContain("by-number/0/2")
    expect(unknown.stderr).toContain("indexed range is 1..1 (may have gaps)")
    const repeated = await yrd(work, "runs", "activate", address, "--json")
    expect(repeated.code).toBe(2)
    expect(repeated.stdout).toBe("")
    expect(repeated.stderr).toContain("already exists")
  }, 60_000)
})
