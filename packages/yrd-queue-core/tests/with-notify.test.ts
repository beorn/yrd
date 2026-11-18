/**
 * @reach fs-walk <fixture-only: counts setup stamp directories under its own fixture workdir>
 * Notify dispatch: several notices over one prepared worktree, per-notice
 * results, and the ending messages a notifier is handed.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import { tryAcquireFlock } from "@bearly/flock"
import { holdNotifyTree, messageFor, notifyEnvRetired, type EnvRetiredNotice } from "../src/with-notify.ts"
import { testGitIn } from "../../../tests/support/test-git-in.ts"

function envRetired(environment: string): EnvRetiredNotice {
  return {
    record: "env-retired",
    change: "task/thing@abcdef1234567890abcdef1234567890abcdef12",
    endingId: `q-run9:${environment}`,
    endedAt: "2026-10-17T00:00:00.000Z",
    submitter: "submitter-x",
    environment,
    proof: "/retained/thing/manifest.json",
    retainUntil: "2026-10-24T00:00:00.000Z",
  }
}

const fixtureRoots: string[] = []
afterAll(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A one-commit repository with no submodules, plus the roots one dispatch needs. */
async function dispatchFixture(run: (records: string) => string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-notify-batch-")))
  fixtureRoots.push(root)
  const repo = join(root, "repo")
  const seed = testGitIn(root)
  await seed(["init", "--quiet", "--initial-branch=main", repo])
  const git = testGitIn(repo)
  await git(["config", "user.email", "notify@yrd.test"])
  await git(["config", "user.name", "yrd"])
  writeFileSync(join(repo, "file.txt"), "x\n")
  await git(["add", "file.txt"])
  await git(["commit", "--quiet", "-m", "one commit"])
  const targetSha = (await git(["rev-parse", "HEAD"])).trim()
  const records = join(root, "records.jsonl")
  const workdir = join(root, "workdir")
  return {
    records,
    workdir,
    context: {
      git,
      repo,
      targetSha,
      workdir,
      tempRoot: join(root, "tmp"),
      notify: [{ name: "recorder", on: ["env-retired"] as const, run: run(records) }],
      setup: "true",
    },
  }
}

describe("env-retired dispatch", () => {
  it("answers one none delivery per notice when no entry names env-retired, without touching git", async () => {
    const notice = envRetired("/w/thing")
    const handed = await notifyEnvRetired(
      {
        git: (() => {
          throw new Error("git must not run when nobody wants the occasion")
        }) as never,
        notify: [],
        repo: "/r",
        targetSha: "a".repeat(40),
        workdir: "/w",
        tempRoot: "/t",
      },
      [notice],
    )
    expect(handed).toEqual([{ delivery: "none", name: "none", notice }])
  })

  it("prepares the notify worktree once for several notices and keeps each result", async () => {
    const { context, records, workdir } = await dispatchFixture((file) => `cat >> ${file}`)
    const notices = [envRetired("/w/env-a"), envRetired("/w/env-b"), envRetired("/w/env-c")]
    const handed = await notifyEnvRetired(context, notices)
    expect(handed.map((each) => [each.notice, each.delivery])).toEqual([
      [notices[0], "sent"],
      [notices[1], "sent"],
      [notices[2], "sent"],
    ])
    // One preparation per dispatch: the setup stamp directories are the
    // preparations that actually ran, one per prepared worktree.
    expect(readdirSync(join(workdir, "checks", "notify"))).toHaveLength(1)
    const sent = readFileSync(records, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as EnvRetiredNotice).environment)
    expect(sent).toEqual(["/w/env-a", "/w/env-b", "/w/env-c"])
  })

  it("one notice the entry refuses does not block the notices after it", async () => {
    const { context, records, workdir } = await dispatchFixture(
      (file) => `line=$(cat); printf '%s\\n' "$line" >> ${file}; case "$line" in *env-bad*) exit 3;; esac`,
    )
    const notices = [envRetired("/w/env-a"), envRetired("/w/env-bad"), envRetired("/w/env-c")]
    const handed = await notifyEnvRetired(context, notices)
    expect(handed.map((each) => each.delivery)).toEqual(["sent", "failed", "sent"])
    expect(handed[1]?.notice).toBe(notices[1])
    expect(readdirSync(join(workdir, "checks", "notify"))).toHaveLength(1)
    expect(readFileSync(records, "utf8").trim().split("\n")).toHaveLength(3)
  })
})

describe("notify tree reuse across dispatches (34755)", () => {
  /** The fixture plus a second commit, so two dispatches can name two different targets. */
  async function twoCommitFixture(run: (records: string) => string) {
    const fixture = await dispatchFixture(run)
    const git = fixture.context.git
    writeFileSync(join(fixture.context.repo, "file.txt"), "y\n")
    await git(["commit", "--quiet", "-am", "second commit"])
    const second = (await git(["rev-parse", "HEAD"])).trim()
    return { ...fixture, first: fixture.context.targetSha, second }
  }

  it("runs each dispatch at its own target in one pooled tree, re-running setup each time", async () => {
    const { context, records, workdir, first, second } = await twoCommitFixture(
      (file) => `cat >/dev/null; printf '%s %s\\n' "$(git rev-parse HEAD)" "$(pwd -P)" >> ${file}`,
    )
    const one = await notifyEnvRetired({ ...context, targetSha: first }, [envRetired("/w/env-a")])
    const two = await notifyEnvRetired({ ...context, targetSha: second }, [envRetired("/w/env-b")])
    expect([...one, ...two].map((each) => each.delivery)).toEqual(["sent", "sent"])
    const rows = readFileSync(records, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" "))
    // Each dispatch ran at the commit it named, not at whatever the tree held before.
    expect(rows.map(([head]) => head)).toEqual([first, second])
    // Both ran in the same warm tree: the second dispatch moved it rather than building another.
    expect(rows[0]?.[1]).toBe(rows[1]?.[1])
    expect(rows[0]?.[1]).toBe(join(workdir, "worktrees", "pool", "outside-round", "notify"))
    // The checkout outlives the dispatch, so the next one only writes what changed.
    expect(readdirSync(join(workdir, "worktrees", "pool", "outside-round", "notify"))).toContain("file.txt")
    // Setup is not a cache: it ran once per dispatch, each with its own stamp.
    expect(readdirSync(join(workdir, "checks", "notify"))).toHaveLength(2)
  })

  it("waits while another process holds the notify tree, then delivers once that holder dies", async () => {
    const { context, records, workdir } = await dispatchFixture((file) => `cat >> ${file}`)
    const lock = join(workdir, "worktrees", "pool", "outside-round", "notify.lock")
    // An independent process takes the lock and exits without releasing it: the kernel drops a dead
    // holder's flock, which is the only release this dispatch may rely on.
    const holder = spawn(
      process.execPath,
      [
        "--eval",
        [
          `const { tryAcquireFlock } = await import("@bearly/flock")`,
          `const held = tryAcquireFlock(${JSON.stringify(lock)}, { createParent: true, body: "child holder" })`,
          `if (held === null) process.exit(9)`,
          `console.log("held")`,
          `await new Promise((resolve) => setTimeout(resolve, 2500))`,
          `process.exit(0)`,
        ].join("\n"),
      ],
      { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "inherit"] },
    )
    const exited = new Promise<number | null>((resolve) => holder.on("exit", (code) => resolve(code)))
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on("data", (chunk: Buffer) => {
        if (String(chunk).includes("held")) resolve()
      })
      holder.on("exit", (code) => reject(new Error(`holder exited ${String(code)} before holding`)))
    })
    const startedAt = Date.now()
    const handed = await notifyEnvRetired(context, [envRetired("/w/env-a")])
    const returnedAfterMs = Date.now() - startedAt
    expect(await exited).toBe(0)
    expect(handed.map((each) => each.delivery)).toEqual(["sent"])
    // A fresh build alone takes well under a second here, so only a real wait reaches 2 s.
    expect(returnedAfterMs).toBeGreaterThanOrEqual(2000)
    expect(readFileSync(records, "utf8").trim().split("\n")).toHaveLength(1)
  })

  it("a refused reuse names its cause on stderr before it rebuilds the notify tree", async () => {
    const { context, records, workdir } = await dispatchFixture((file) => `cat >> ${file}`)
    await notifyEnvRetired(context, [envRetired("/w/env-a")])
    // A tracked modification in the warm tree is the pool's own refusal: it must not be reused silently.
    writeFileSync(join(workdir, "worktrees", "pool", "outside-round", "notify", "file.txt"), "edited in place\n")
    const written: string[] = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
    const handed = await notifyEnvRetired(context, [envRetired("/w/env-b")]).finally(() => stderr.mockRestore())
    expect(handed.map((each) => each.delivery)).toEqual(["sent"])
    const named = written.filter((line) => line.startsWith("yrd notify: "))
    expect(named).toHaveLength(1)
    expect(named[0]).toMatch(/^yrd notify: a tracked modification.*; building a fresh notify tree\n$/su)
    expect(readFileSync(records, "utf8").trim().split("\n")).toHaveLength(2)
  })

  it("a non-empty queue hooks directory fails the dispatch's deliveries by name", async () => {
    const { context, workdir } = await dispatchFixture((file) => `cat >> ${file}`)
    mkdirSync(join(workdir, "hooks-disabled"), { recursive: true })
    writeFileSync(join(workdir, "hooks-disabled", "post-checkout"), "#!/bin/sh\n")
    const handed = await notifyEnvRetired(context, [envRetired("/w/env-a")])
    expect(handed.map((each) => each.delivery)).toEqual(["failed"])
    expect(handed[0]?.failure ?? "").toContain("hooks-disabled is not empty (post-checkout)")
  })

  it("a failed setup fails that dispatch's deliveries by name, and the next dispatch still delivers", async () => {
    const { context, records } = await dispatchFixture((file) => `cat >> ${file}`)
    const failed = await notifyEnvRetired({ ...context, setup: "exit 7" }, [envRetired("/w/env-a")])
    expect(failed.map((each) => each.delivery)).toEqual(["failed"])
    expect(failed[0]?.failure ?? "").not.toBe("")
    const after = await notifyEnvRetired(context, [envRetired("/w/env-b")])
    expect(after.map((each) => each.delivery)).toEqual(["sent"])
    expect(readFileSync(records, "utf8").trim().split("\n")).toHaveLength(1)
  })

  it("a hold that outlasts its bound fails with the lock and its holder named, never silently", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-notify-hold-")))
    fixtureRoots.push(root)
    const lock = join(root, "notify.lock")
    const held = tryAcquireFlock(lock, { createParent: true, body: "other dispatch pid 4242\n" })
    try {
      await expect(holdNotifyTree(lock, 200)).rejects.toThrow(
        /notify\.lock was held past 200ms \(holder: other dispatch pid 4242\)/u,
      )
    } finally {
      held?.release()
    }
    const mine = await holdNotifyTree(lock, 200)
    mine.release()
  })
})

describe("messageFor deferred timing relation", () => {
  const base = {
    branch: "task/25029-fix",
    head: "abcdef1234567890abcdef1234567890abcdef12",
    subject: "fix(yrd): deferral notice relation",
  }

  it("formats > when projected duration exceeds bound", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: 58 * 60_000,
      boundMs: 30 * 60_000,
    })
    expect(msg).toBe("waits for long check: task/25029-fix@abcdef123456 (projected 58m > 30m)")
  })

  it("formats < when projected duration is less than bound", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: 17 * 60_000,
      boundMs: 30 * 60_000,
    })
    expect(msg).toBe("waits for long check: task/25029-fix@abcdef123456 (projected 17m < 30m)")
  })

  it("formats = when projected duration equals bound", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: 30 * 60_000,
      boundMs: 30 * 60_000,
    })
    expect(msg).toBe("waits for long check: task/25029-fix@abcdef123456 (projected 30m = 30m)")
  })

  it("falls back to projection exceeded bound when timing is undefined", () => {
    const msg = messageFor("deferred", {
      ...base,
      projectedMs: undefined,
      boundMs: undefined,
    })
    expect(msg).toBe("waits for long check: task/25029-fix@abcdef123456 (projection exceeded bound)")
  })
})

describe("messageFor names a queue re-cut (24977)", () => {
  const about = {
    branch: "task/24977-recut",
    head: "abcdef1234567890abcdef1234567890abcdef12",
    subject: "task/24977-recut merged into main as 0123456789ab",
    merge: "0123456789abcdef0123456789abcdef01234567",
    recuts: [
      "ag 1111111111111111111111111111111111111111 + 2222222222222222222222222222222222222222 -> 3333333333333333333333333333333333333333",
    ],
  }

  it("says the merged change was re-cut, naming the change's pin, the main merged in, and the composed commit", () => {
    expect(messageFor("merged", about)).toBe(
      "close your bead: task/24977-recut@abcdef123456 merged as 0123456789ab; the queue re-cut it: ag 111111111111 + main 222222222222 -> 333333333333",
    )
  })

  it("says nothing about a re-cut when there was none", () => {
    expect(messageFor("merged", { ...about, recuts: [] })).toBe(
      "close your bead: task/24977-recut@abcdef123456 merged as 0123456789ab",
    )
  })
})
