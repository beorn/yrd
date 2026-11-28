/**
 * @failure A submitted change records no fact on its issue, records it twice, records it under an id km refuses, writes
 *          it in the submit's own process (so a held km lane parks every submit), or loses a launch failure silently.
 * @level l1
 * @consumer hh #38766 — the Fleet timeline's `submitted` mark, and @cto e0638180's rule that the edge is best-effort
 *          under a bound and never slows or fails a submit.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  ISSUE_EVENT_EDGE_TIMEOUT_MS,
  issueEventOperationId,
  issueEventSource,
  launchIssueEvent,
} from "../src/issue-event-edge.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "issue-event-edge-"))

describe("the issue-event edge's keys", () => {
  it("spells a replay key km accepts: one ref segment, no colon", () => {
    const id = issueEventOperationId("submitted", "7111504be0fe")
    expect(id).toBe("yrd-submitted-7111504be0fe")
    expect(/^[A-Za-z0-9._-]+$/u.test(id)).toBe(true)
    expect(issueEventOperationId("submitted", "aaa")).not.toBe(issueEventOperationId("merged", "aaa"))
    expect(issueEventOperationId("submitted", "aaa")).not.toBe(issueEventOperationId("submitted", "bbb"))
  })

  it("names the source as the queue spells the repository, at the observed 40-hex sha", () => {
    expect(issueEventSource("git@github.com:beorn/hh-dev.git", "a".repeat(40))).toBe(
      `github.com/beorn/hh-dev@${"a".repeat(40)}`,
    )
  })
})

describe("the issue-event edge's launch", () => {
  it("starts the CLI's own issues event verb detached, with the bound, and leaves the outcome in the queue's log tree", () => {
    const workdir = tmp()
    const spawned: Array<{ argv: readonly string[]; options: Record<string, unknown> }> = []
    const submitter = { name: "@dev/author", source: "explicit", launchIdentity: "@dev/runner" } as const
    const outcome = launchIssueEvent({
      kind: "submitted",
      issue: "#38766",
      source: "github.com/beorn/hh-dev@abc",
      text: "task/38766 submitted at abc",
      submitter,
      opId: "yrd-submitted-abc",
      projectRoot: "/hh/dev",
      cwd: "/hh/dev",
      workdir,
      env: { PATH: "/usr/bin" },
      self: ["/usr/bin/bun", "/hh/dev/tools/yrd-runtime.mjs", "yrd"],
      spawn: (argv, options) => {
        spawned.push({ argv, options })
        return {}
      },
    })
    expect(outcome).toEqual({ launched: true, log: join(workdir, "logs", "issue-events", "yrd-submitted-abc.log") })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.argv).toEqual([
      "/usr/bin/bun",
      "/hh/dev/tools/yrd-runtime.mjs",
      "yrd",
      "issues",
      "event",
      "#38766",
      "submitted",
      "github.com/beorn/hh-dev@abc",
      "task/38766 submitted at abc",
      "--id",
      "yrd-submitted-abc",
      "--project-root",
      "/hh/dev",
      "--timeout-ms",
      String(ISSUE_EVENT_EDGE_TIMEOUT_MS),
      "--submitter",
      JSON.stringify(submitter),
    ])
    // The child owns stdout and stderr (one shared descriptor), so its refusal is written by name.
    expect(spawned[0]?.options).toMatchObject({ cwd: "/hh/dev", env: { PATH: "/usr/bin" } })
    const header = readFileSync(outcome.launched ? outcome.log : "", "utf8")
    expect(header).toContain("yrd-submitted-abc launched")
    expect(header).toContain("#38766")
  })

  it("carries the branch's own failure notify into the child when a caller names one", () => {
    // hh #38766 (@cto 15f0394a): a detached child owns an outcome the round can no longer see, so the failing write
    // must record its own `failed` event rather than leave the round to report a branch it never watched.
    const workdir = tmp()
    const spawned: Array<{ argv: readonly string[] }> = []
    const outcome = launchIssueEvent({
      kind: "merged",
      issue: "#38766",
      source: "github.com/beorn/hh-dev@abc",
      text: "task/38766 merged at abc",
      opId: "yrd-merged-abc",
      projectRoot: "/hh/dev",
      cwd: "/hh/dev",
      workdir,
      env: { PATH: "/usr/bin" },
      fallback: { kind: "failed", text: "task/38766 merged event for abc did not land" },
      self: ["/usr/bin/bun"],
      spawn: (argv) => {
        spawned.push({ argv })
        return {}
      },
    })
    expect(outcome.launched).toBe(true)
    expect(spawned[0]?.argv.slice(-4)).toEqual([
      "--on-failure-kind",
      "failed",
      "--on-failure-text",
      "task/38766 merged event for abc did not land",
    ])
  })

  it("a write that cannot be started is named, never swallowed", () => {
    const outcome = launchIssueEvent({
      kind: "merged",
      issue: "#1",
      source: "github.com/beorn/hh-dev@abc",
      text: "x merged",
      opId: "yrd-merged-abc",
      projectRoot: "/hh/dev",
      cwd: "/hh/dev",
      workdir: tmp(),
      env: {},
      self: ["/usr/bin/bun", "/hh/dev/tools/yrd-runtime.mjs", "yrd"],
      spawn: () => {
        throw new Error("ENOMEM: cannot fork")
      },
    })
    expect(outcome.launched).toBe(false)
    expect(outcome.launched ? "" : outcome.why).toMatch(/ENOMEM/u)
  })

  it("a log directory that cannot be opened refuses the launch instead of writing nowhere", () => {
    const outcome = launchIssueEvent({
      kind: "submitted",
      issue: "#1",
      source: "github.com/beorn/hh-dev@abc",
      text: "x",
      opId: "yrd-submitted-abc",
      projectRoot: "/hh/dev",
      cwd: "/hh/dev",
      workdir: "/proc/definitely-not-writable",
      env: {},
      self: ["/usr/bin/bun", "/hh/dev/tools/yrd-runtime.mjs", "yrd"],
      spawn: () => ({}),
    })
    expect(outcome.launched).toBe(false)
    expect(outcome.launched ? "" : outcome.why).toMatch(/could not be opened/u)
  })

  it("re-enters a standalone Bun script without a launcher selector", async () => {
    const workdir = tmp()
    const script = join(workdir, "yrd.ts")
    const log = join(workdir, "logs", "issue-events", "standalone-submitted.log")
    const modulePath = join(import.meta.dirname, "..", "src", "issue-event-edge.ts")
    writeFileSync(
      script,
      `
import { launchIssueEvent } from ${JSON.stringify(modulePath)}
if (process.argv[2] !== undefined) {
  if (process.argv[2] !== "issues") throw new Error("Unexpected selector: " + process.argv[2])
  console.log("detached event command reached")
} else {
  const outcome = launchIssueEvent({
    kind: "submitted", issue: "#29527", source: "github.com/beorn/hh-dev@abc", text: "submitted",
    opId: "standalone-submitted", workdir: ${JSON.stringify(workdir)}, cwd: ${JSON.stringify(workdir)},
    projectRoot: ${JSON.stringify(workdir)}, env: process.env,
  })
  if (!outcome.launched) throw new Error(outcome.why)
}`,
    )
    const ran = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
    expect(ran.exitCode, ran.stderr.toString()).toBe(0)
    await vi.waitFor(() => expect(readFileSync(log, "utf8")).toContain("detached event command reached"), {
      timeout: 5000,
    })
  })

  it("a launched write never keeps the caller's process alive", () => {
    // The real spawn, not the injected one (@cto e72bc1a0): a live Subprocess keeps the parent's event loop alive, so
    // without `detached`+`unref` the caller would wait for a km write it never looks at. A 5 s child makes that visible.
    const dir = tmp()
    const fixture = join(dir, "launch.ts")
    const modulePath = join(import.meta.dirname, "..", "src", "issue-event-edge.ts")
    writeFileSync(
      fixture,
      [
        `import { launchIssueEvent } from ${JSON.stringify(modulePath)}`,
        "const outcome = launchIssueEvent({",
        '  kind: "submitted", issue: "#1", source: "github.com/beorn/hh-dev@abc", text: "x",',
        '  opId: "yrd-submitted-detachprobe", projectRoot: "/tmp", cwd: "/tmp",',
        `  workdir: ${JSON.stringify(dir)}, env: {}, self: ["/bin/sh", "-c", "sleep 5"],`,
        "})",
        'if (!outcome.launched) { console.error("not launched: " + outcome.why); process.exit(2) }',
        'console.log("returned")',
      ].join("\n"),
    )
    const started = Date.now()
    const ran = Bun.spawnSync([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" })
    const elapsed = Date.now() - started
    expect(ran.exitCode, new TextDecoder().decode(ran.stderr)).toBe(0)
    expect(elapsed).toBeLessThan(3000)
    expect(readFileSync(join(dir, "logs", "issue-events", "yrd-submitted-detachprobe.log"), "utf8")).toContain(
      "yrd-submitted-detachprobe launched",
    )
  })
})
