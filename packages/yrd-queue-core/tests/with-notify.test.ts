/**
 * @reach fs-walk <fixture-only: counts setup stamp directories under its own fixture workdir>
 * Notify dispatch: several notices over one prepared worktree, per-notice
 * results, and the ending messages a notifier is handed.
 */
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { messageFor, notifyEnvRetired, type EnvRetiredNotice } from "../src/with-notify.ts"
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
