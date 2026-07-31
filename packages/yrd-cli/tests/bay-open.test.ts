/**
 * @failure `yrd bay open/run` loses work, returns before cleanup, or leaves a failed child unflagged.
 * @level l3
 * @consumer @yrd/cli Bay lifecycle
 */
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { runYrdProcess } from "../src/host.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
const spawnedYrdProcesses = new Set<ReturnType<typeof Bun.spawn>>()
const CLAIM = "@km/test/s2-fixture"
const BRANCH = "task/s2-fixture"
const BOUNDED_ONE_SECOND_LOOP =
  'fixture_ticks=0; while [ "$fixture_ticks" -lt 120 ]; do fixture_ticks=$((fixture_ticks + 1)); sleep 1; done'
const BOUNDED_RELEASE_FILE_LOOP =
  'fixture_ticks=0; while [ ! -f "$1" ] && [ "$fixture_ticks" -lt 1200 ]; do fixture_ticks=$((fixture_ticks + 1)); sleep 0.05; done'
const JOURNAL_CONFIG = ""
/**
 * Stand-in `ag` that records who it was launched as, the exact argv it received,
 * and whether the Bay was runnable when it started — a real agent harness
 * resolves modules before it can do anything else.
 */
const AG_ARGV_RECORDER = `#!/bin/sh
printf '%s' "$*" > agent.prompt
: > agent.argv
for arg in "$@"; do printf '%s\\n' "$arg" >> agent.argv; done
if [ -d node_modules ]; then printf 'present' > agent.deps; else printf 'absent' > agent.deps; fi
git rev-parse HEAD > agent.head 2>/dev/null || printf 'none' > agent.head
`
let originalPath: string | undefined
let issueToolRoot: string | undefined

beforeAll(async () => {
  originalPath = process.env.PATH
  issueToolRoot = await mkdtemp(join(tmpdir(), "yrd-bay-run-tools-"))
  await writeFile(
    join(issueToolRoot, "km"),
    `#!/bin/sh
if [ "$TEST_ISSUE_MISSING" = "$YRD_ISSUE_ID" ]; then
  printf 'Node not found: %s\n' "$YRD_ISSUE_ID" >&2
  exit 1
fi
printf '%s\n' '{"node":{"title":"Fixture issue","name":"fixture","version":1}}'
`,
  )
  await chmod(join(issueToolRoot, "km"), 0o755)
  process.env.PATH = `${issueToolRoot}:${originalPath ?? ""}`
})

afterAll(async () => {
  restoreEnv("PATH", originalPath)
  if (issueToolRoot !== undefined) await rm(issueToolRoot, { recursive: true, force: true })
})

afterEach(async () => {
  await stopSpawnedYrdProcesses()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("yrd bay open/run/in", { timeout: 30_000 }, () => {
  it("separates persistent open from scoped run and keeps config off guest attach", async () => {
    const { repo } = await repository()
    const open = output(repo)
    expect(await yrd(repo, open.io, "bay", "open", "--help"), open.stderr()).toBe(0)
    expect(open.stdout()).toContain("[config]")
    expect(open.stdout()).not.toContain("[command...]")
    expect(open.stdout()).not.toContain("--keep")
    for (const flag of ["--issue <ref>", "--pr <selector>", "--bay <name>"]) {
      expect(open.stdout()).toContain(flag)
    }

    for (const args of [
      ["bay", "run", "--help"],
      ["sh", "--help"],
    ] as const) {
      const help = output(repo)
      expect(await yrd(repo, help.io, ...args), `${args.join(" ")}\n${help.stderr()}`).toBe(0)
      expect(help.stdout()).toContain("--issue <ref>")
      expect(help.stdout()).toContain("--pr <selector>")
      expect(help.stdout()).toContain("--bay <name>")
      expect(help.stdout()).not.toContain("--exec")
      if (args[1] === "run") {
        expect(help.stdout()).toContain("--keep")
      }
    }
    const runHelp = output(repo)
    expect(await yrd(repo, runHelp.io, "run", "--help"), runHelp.stderr()).toBe(0)
    expect(runHelp.stdout()).toContain("act on individual queue runs")
    expect(runHelp.stdout()).toContain("cancel")
    expect(runHelp.stdout()).not.toContain("--issue")
    expect(runHelp.stdout()).not.toContain("--bay")
    const listHelp = output(repo)
    expect(await yrd(repo, listHelp.io, "bay", "list", "--help"), listHelp.stderr()).toBe(0)
    expect(listHelp.stdout()).toContain("--check")

    for (const args of [
      ["bay", "in", "--help"],
      ["in", "--help"],
    ] as const) {
      const help = output(repo)
      expect(await yrd(repo, help.io, ...args), `${args.join(" ")}\n${help.stderr()}`).toBe(0)
      expect(help.stdout()).not.toContain("--issue")
      expect(help.stdout()).not.toContain("--pr")
      expect(help.stdout()).not.toContain("--bay")
    }
    const rootHelp = output(repo)
    expect(await yrd(repo, rootHelp.io, "--help"), rootHelp.stderr()).toBe(0)
    expect(rootHelp.stdout()).not.toMatch(/^\s+do(?:\s|$)/mu)
    const issueHelp = output(repo)
    expect(await yrd(repo, issueHelp.io, "issue", "--help"), issueHelp.stderr()).toBe(0)
    expect(issueHelp.stdout()).toContain("ensure [options] <issue>")
  })

  it("ensures one issue-owned Bay and one tracked draft PR idempotently", async () => {
    const { repo } = await repository()
    const first = output(repo)
    expect(await yrd(repo, first.io, "issue", "ensure", CLAIM, "--json"), first.stderr()).toBe(0)
    const firstResult = JSON.parse(first.stdout()) as {
      command: string
      issue: string
      bay: { id: string; issue?: string; branch: string; status: string }
      pr: { id: string; issue?: string; branch: string; track?: boolean; status: string; revs: readonly unknown[] }
    }
    expect(firstResult).toMatchObject({
      command: "issue.ensure",
      issue: CLAIM,
      bay: { id: "B1", issue: CLAIM, branch: BRANCH, status: "active" },
      pr: { id: "PR1", issue: CLAIM, branch: BRANCH, track: true, status: "pushed" },
    })

    const second = output(repo)
    expect(await yrd(repo, second.io, "issue", "ensure", CLAIM, "--json"), second.stderr()).toBe(0)
    const secondResult = JSON.parse(second.stdout()) as typeof firstResult
    expect(secondResult).toMatchObject({
      command: "issue.ensure",
      issue: CLAIM,
      bay: { id: "B1" },
      pr: { id: "PR1" },
    })
    expect(secondResult.pr.revs).toEqual(firstResult.pr.revs)

    const human = output(repo)
    expect(await yrd(repo, human.io, "issue", "ensure", CLAIM), human.stderr()).toBe(0)
    expect(human.stdout()).toBe(`issue ${CLAIM} → bay B1 ${BRANCH} → tracked draft PR1\n`)

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    expect((JSON.parse(bays.stdout()) as { bays: readonly unknown[] }).bays).toHaveLength(1)
    const prs = output(repo)
    expect(await yrd(repo, prs.io, "pr", "list", "--json"), prs.stderr()).toBe(0)
    expect((JSON.parse(prs.stdout()) as { prs: readonly unknown[] }).prs).toHaveLength(1)
  })

  it("refuses to ensure a draft from an active Bay with uncommitted work", async () => {
    const { repo } = await repository()
    const first = output(repo)
    expect(await yrd(repo, first.io, "issue", "ensure", CLAIM, "--json"), first.stderr()).toBe(0)
    const ensured = JSON.parse(first.stdout()) as { bay: { path: string } }
    await writeFile(join(ensured.bay.path, "uncommitted.txt"), "not durable\n")

    const retry = output(repo)
    expect(await yrd(repo, retry.io, "issue", "ensure", CLAIM)).toBe(1)
    expect(retry.stderr()).toContain("holds uncommitted changes")
    expect(retry.stderr()).toContain("checkpoint them before ensuring its draft PR")
    expect(retry.stderr()).toContain("yrd in B1")
  })

  it("opens a persistent Bay without running a command", async () => {
    const { repo } = await repository()
    const shell = join(repo, "..", "must-not-run")
    const marker = join(repo, "..", "shell-ran")
    await writeFile(shell, `#!/bin/sh\n: > "$YRD_TEST_SHELL_MARKER"\n`)
    await chmod(shell, 0o755)
    const previousShell = process.env.SHELL
    const previousMarker = process.env.YRD_TEST_SHELL_MARKER
    process.env.SHELL = shell
    process.env.YRD_TEST_SHELL_MARKER = marker
    try {
      const opened = output(repo)
      expect(await yrd(repo, opened.io, "bay", "open", "--bay", "docs"), opened.stderr()).toBe(0)
      expect(await Bun.file(marker).exists()).toBe(false)
      const bayPath = opened.stdout().trim()
      expect(isAbsolute(bayPath)).toBe(true)
      expect(opened.stdout().trimEnd()).not.toContain("\n")
      expect(opened.stderr()).toContain("bay docs → new task/docs, no issue linked")
      expect(await git(bayPath, "branch", "--show-current")).toBe("task/docs")

      const bays = output(repo)
      expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
      expect(JSON.parse(bays.stdout())).toMatchObject({
        bays: [
          expect.objectContaining({
            name: "docs",
            by: `yrd:${String(process.pid)}`,
            nativeStatus: "active",
            status: "open",
          }),
        ],
      })

      const held = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000)"], {
        cwd: bayPath,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      try {
        expect(isPidAlive(held.pid)).toBe(true)
        const closed = output(repo)
        expect(await yrd(repo, closed.io, "bay", "close", "docs"), closed.stderr()).toBe(0)
        await eventually(async () => {
          if (isPidAlive(held.pid)) throw new Error(`path-owned pid ${held.pid} survived explicit Bay close`)
        })
        const afterClose = output(repo)
        expect(await yrd(repo, afterClose.io, "bay", "list", "--closed", "--json"), afterClose.stderr()).toBe(0)
        expect(JSON.parse(afterClose.stdout())).toMatchObject({
          bays: [expect.objectContaining({ name: "docs", nativeStatus: "closed", status: "done" })],
        })
      } finally {
        killQuiet(held.pid)
      }
    } finally {
      restoreEnv("SHELL", previousShell)
      restoreEnv("YRD_TEST_SHELL_MARKER", previousMarker)
    }
  })

  it("runs one scoped command and keeps a successful Bay only with --keep", async () => {
    const closedFixture = await repository()
    const run = output(closedFixture.repo)
    expect(
      await yrd(
        closedFixture.repo,
        run.io,
        "bay",
        "run",
        "--bay",
        "once",
        "--",
        "sh",
        "-c",
        "printf done > result.txt",
      ),
      run.stderr(),
    ).toBe(0)
    expect(run.stdout()).toContain("bay once → new task/once, no issue linked")
    expect(await git(closedFixture.repo, "show", "refs/remotes/origin/task/once:result.txt")).toBe("done")
    const closedPath = output(closedFixture.repo)
    expect(await yrd(closedFixture.repo, closedPath.io, "bay", "path", "once")).not.toBe(0)

    const keptFixture = await repository()
    const kept = output(keptFixture.repo)
    expect(
      await yrd(
        keptFixture.repo,
        kept.io,
        "bay",
        "run",
        "--keep",
        "--bay",
        "kept",
        "--",
        "sh",
        "-c",
        "printf kept > result.txt; git add result.txt; git commit -qm kept",
      ),
      kept.stderr(),
    ).toBe(0)
    const keptPath = output(keptFixture.repo)
    expect(await yrd(keptFixture.repo, keptPath.io, "bay", "path", "kept"), keptPath.stderr()).toBe(0)
    expect(await readFile(join(keptPath.stdout().trim(), "result.txt"), "utf8")).toBe("kept")
    await git(keptPath.stdout().trim(), "push", "-q", "origin", "HEAD:task/kept")

    const closed = output(keptFixture.repo)
    expect(await yrd(keptFixture.repo, closed.io, "bay", "close", "kept"), `${closed.stdout()}${closed.stderr()}`).toBe(
      0,
    )
  })

  it("reaps a setsid descendant before a successful Bay run closes (22510)", async () => {
    const { repo } = await repository()
    const fixtureRoot = join(repo, "..")
    const escapedPidPath = join(fixtureRoot, "escaped.pid")
    const escapedChildPath = join(fixtureRoot, "escaped-child.ts")
    await writeFile(
      escapedChildPath,
      [`process.on("SIGHUP", () => {})`, `process.on("SIGTERM", () => {})`, `setInterval(() => {}, 1_000)`].join("\n"),
    )
    const spawnEscaped = [
      `perl -MPOSIX -e '$sid = POSIX::setsid(); open(my $fh, ">", shift @ARGV) or die $!; print $fh "$$ $sid"; close $fh; exec @ARGV or die $!' "$1" "$2" "$3" </dev/null >/dev/null 2>&1 &`,
      `fixture_ticks=0`,
      `while [ ! -s "$1" ] && [ "$fixture_ticks" -lt 500 ]; do`,
      `  fixture_ticks=$((fixture_ticks + 1))`,
      `  sleep 0.01`,
      `done`,
      `test -s "$1"`,
    ].join("\n")
    const run = output(repo)
    let escapedPid = 0
    try {
      expect(
        await yrd(
          repo,
          run.io,
          "bay",
          "run",
          "--bay",
          "escaped-tree",
          "--",
          "sh",
          "-c",
          spawnEscaped,
          "yrd-setsid-fixture",
          escapedPidPath,
          process.execPath,
          escapedChildPath,
        ),
        run.stderr(),
      ).toBe(0)
      const [escapedPidText, escapedSidText] = (await readFile(escapedPidPath, "utf8")).trim().split(/\s+/u)
      escapedPid = Number(escapedPidText)
      expect(escapedPid).toBeGreaterThan(1)
      expect(Number(escapedSidText), "fixture must create a new session, not only a process group").toBe(escapedPid)
      expect(run.stdout()).toContain("closed escaped-tree")
      await eventually(async () => {
        if (isPidAlive(escapedPid)) throw new Error(`setsid descendant ${escapedPid} survived Bay close`)
      }, 2_000)
    } finally {
      killQuiet(escapedPid)
    }
  })

  it("does not trust a stale remote-tracking ref as durability proof", async () => {
    const { repo } = await repository()
    const kept = output(repo)
    expect(
      await yrd(
        repo,
        kept.io,
        "bay",
        "run",
        "--keep",
        "--bay",
        "stale-remote",
        "--",
        "sh",
        "-c",
        "printf risk > risk.txt; git add risk.txt; git commit -qm risk",
      ),
      kept.stderr(),
    ).toBe(0)

    const path = output(repo)
    expect(await yrd(repo, path.io, "bay", "path", "stale-remote"), path.stderr()).toBe(0)
    const bayPath = path.stdout().trim()
    await git(bayPath, "push", "-q", "origin", "HEAD:task/stale-remote")

    const remoteTrackingRef = "refs/remotes/origin/task/stale-remote"
    const remoteBranchRef = "refs/heads/task/stale-remote"
    const pushedTip = await git(repo, "rev-parse", remoteTrackingRef)
    await git(join(repo, "..", "origin.git"), "update-ref", "-d", remoteBranchRef)
    expect(await git(repo, "ls-remote", "--heads", "origin", remoteBranchRef)).toBe("")
    expect(await git(repo, "rev-parse", remoteTrackingRef)).toBe(pushedTip)

    const status = output(repo)
    expect(
      await yrd(repo, status.io, "bay", "status", "stale-remote", "--json"),
      `${status.stdout()}${status.stderr()}`,
    ).toBe(1)
    const payload = JSON.parse(status.stdout()) as {
      reports: readonly {
        bay: string
        lines: readonly { class: string; verdict: string; evidence: string }[]
      }[]
    }
    expect(payload.reports[0]?.lines.find((line) => line.class === "commits")).toMatchObject({
      verdict: "BLOCK",
      evidence: expect.stringMatching(/no advertised origin ref.*at risk/u),
    })

    const listed = output(repo)
    expect(await yrd(repo, listed.io, "bay", "list", "--check", "--json"), `${listed.stdout()}${listed.stderr()}`).toBe(
      0,
    )
    const listPayload = JSON.parse(listed.stdout()) as {
      reports: readonly {
        bay: string
        exit: number
        lines: readonly { class: string; verdict: string; evidence: string }[]
      }[]
    }
    expect(listPayload.reports).toContainEqual(
      expect.objectContaining({
        bay: payload.reports[0]?.bay,
        exit: 1,
        lines: expect.arrayContaining([expect.objectContaining({ class: "commits", verdict: "BLOCK" })]),
      }),
    )

    const humanList = output(repo)
    expect(await yrd(repo, humanList.io, "bay", "list", "--check"), `${humanList.stdout()}${humanList.stderr()}`).toBe(
      0,
    )
    expect(humanList.stdout()).toContain("SAFETY")
    expect(humanList.stdout()).toContain("blocked")
  })

  it("accepts a patch-equivalent landing even when commit ancestry differs", async () => {
    const { repo } = await repository()
    const kept = output(repo)
    expect(
      await yrd(
        repo,
        kept.io,
        "bay",
        "run",
        "--keep",
        "--bay",
        "patch-landed",
        "--",
        "sh",
        "-c",
        "printf same > landed.txt; git add landed.txt; git commit -qm branch-copy",
      ),
      kept.stderr(),
    ).toBe(0)

    const path = output(repo)
    expect(await yrd(repo, path.io, "bay", "path", "patch-landed"), path.stderr()).toBe(0)
    const bayPath = path.stdout().trim()
    await writeFile(join(repo, "landed.txt"), "same")
    await git(repo, "add", "landed.txt")
    await git(repo, "commit", "-qm", "main-copy")
    await git(repo, "push", "-q", "origin", "main")
    expect(await git(bayPath, "cherry", "origin/main", "HEAD")).toMatch(/^- /u)

    const status = output(repo)
    expect(
      await yrd(repo, status.io, "bay", "status", "patch-landed", "--json"),
      `${status.stdout()}${status.stderr()}`,
    ).toBe(0)
    const payload = JSON.parse(status.stdout()) as {
      reports: readonly {
        lines: readonly { class: string; verdict: string; evidence: string }[]
      }[]
    }
    expect(payload.reports[0]?.lines.find((line) => line.class === "commits")).toMatchObject({
      verdict: "PASS",
      evidence: "tip is durable at origin/main (same changes)",
    })
  })

  it("refuses commands on open and scoped runs against an already-open Bay", async () => {
    const { repo } = await repository()
    const previousShell = process.env.SHELL
    process.env.SHELL = "/usr/bin/true"
    try {
      const opened = output(repo)
      expect(await yrd(repo, opened.io, "bay", "open", "--bay", "shared"), opened.stderr()).toBe(0)

      const command = output(repo)
      expect(await yrd(repo, command.io, "bay", "open", "--bay", "other", "--", "true")).toBe(2)
      expect(command.stderr()).toContain("yrd bay run")

      const duplicate = output(repo)
      expect(await yrd(repo, duplicate.io, "bay", "run", "--bay", "shared", "--", "true")).not.toBe(0)
      expect(duplicate.stderr()).toContain("yrd in B1 -- true")
    } finally {
      restoreEnv("SHELL", previousShell)
    }
  })

  const runJourneys = [
    {
      label: "bare positional issue",
      args: ["bay", "run", CLAIM, "--", "sh", "-c", "printf resolved > result.txt"],
      expected: `bay s2-fixture → new ${BRANCH}, linked ${CLAIM}`,
      branch: BRANCH,
    },
    {
      label: "explicit issue",
      args: ["bay", "run", "--issue", CLAIM, "--", "sh", "-c", "printf resolved > result.txt"],
      expected: `bay s2-fixture → new ${BRANCH}, linked ${CLAIM}`,
      branch: BRANCH,
    },
    {
      label: "issue-less explicit bay",
      args: ["bay", "run", "--bay", "sandbox", "--", "sh", "-c", "printf resolved > result.txt"],
      expected: "bay sandbox → new task/sandbox, no issue linked",
      branch: "task/sandbox",
    },
    {
      label: "distinct bay linked to an issue",
      args: ["bay", "run", "--bay", "named-bay", "--issue", CLAIM, "--", "sh", "-c", "printf resolved > result.txt"],
      expected: `bay named-bay → new ${BRANCH}, linked ${CLAIM}`,
      branch: BRANCH,
    },
  ] as const

  it.each(runJourneys)("resolves $label without implicit PR intake", async (journey) => {
    const { repo } = await repository()
    const opened = output(repo)
    expect(await yrd(repo, opened.io, ...journey.args), `${journey.label}\n${opened.stderr()}`).toBe(0)
    expect(opened.stdout(), journey.label).toContain(journey.expected)
    expect(await git(repo, "show", `refs/remotes/origin/${journey.branch}:result.txt`)).toBe("resolved")
    const prs = output(repo)
    expect(await yrd(repo, prs.io, "pr", "list", "--json"), prs.stderr()).toBe(0)
    expect(JSON.parse(prs.stdout())).toMatchObject({ prs: [] })
  })

  it("reattaches an explicit PR target without implicit PR intake", async () => {
    const targeted = await repository()
    const branch = "topic/explicit-target"
    await git(targeted.repo, "switch", "-qc", branch)
    await writeFile(join(targeted.repo, "existing.txt"), "existing\n")
    await git(targeted.repo, "add", "existing.txt")
    await git(targeted.repo, "commit", "-qm", "existing target")
    await git(targeted.repo, "push", "-q", "-u", "origin", branch)
    await git(targeted.repo, "switch", "-q", "main")
    const draft = output(targeted.repo)
    expect(await yrd(targeted.repo, draft.io, "pr", "create", branch, "--issue", CLAIM), draft.stderr()).toBe(0)
    const continued = output(targeted.repo)
    expect(
      await yrd(
        targeted.repo,
        continued.io,
        "bay",
        "run",
        "--pr",
        branch,
        "--",
        "sh",
        "-c",
        "printf reattached > result.txt",
      ),
      continued.stderr(),
    ).toBe(0)
    expect(continued.stdout()).toContain(`bay explicit-target → reattached ${branch}, no issue linked`)
    expect(await git(targeted.repo, "show", `refs/remotes/origin/${branch}:result.txt`)).toBe("reattached")
  })

  it("generates an anonymous Bay when no selector exists", async () => {
    const anonymous = await repository()
    const shell = join(anonymous.repo, "..", "anonymous-shell")
    const shellLog = join(anonymous.repo, "..", "anonymous-ran")
    await writeFile(shell, `#!/bin/sh\nprintf ran > "$TEST_ANONYMOUS_LOG"\n`)
    await chmod(shell, 0o755)
    const previousShell = process.env.SHELL
    const previousLog = process.env.TEST_ANONYMOUS_LOG
    process.env.SHELL = shell
    process.env.TEST_ANONYMOUS_LOG = shellLog
    try {
      const opened = output(anonymous.repo)
      expect(await yrd(anonymous.repo, opened.io, "bay", "run"), opened.stderr()).toBe(0)
      const match = opened.stdout().match(/bay (yrd-[0-9a-f]{12}) → new task\/\1, no issue linked/u)
      expect(match).not.toBeNull()
      expect(await readFile(shellLog, "utf8")).toBe("ran")
    } finally {
      restoreEnv("SHELL", previousShell)
      restoreEnv("TEST_ANONYMOUS_LOG", previousLog)
    }
  })

  it("projects the same owner lifecycle through git bay", async () => {
    const { repo } = await repository()
    const opened = output(repo)
    expect(
      await gitBay(repo, opened.io, "run", "--bay", "projected", "--", "sh", "-c", "printf git-bay > projected"),
      opened.stderr(),
    ).toBe(0)
    expect(opened.stdout()).toContain("bay projected → new task/projected, no issue linked")
    expect(await git(repo, "show", "refs/remotes/origin/task/projected:projected")).toBe("git-bay")
  })

  it("rejects ambiguous open config and requires every positional to resolve as an issue", async () => {
    const { repo } = await repository()
    const conflict = output(repo)
    expect(await yrd(repo, conflict.io, "bay", "open", CLAIM, "--issue", "@km/test/other")).toBe(2)
    expect(conflict.stderr()).toContain("positional")
    expect(conflict.stderr()).toContain("--issue")

    const previousMissing = process.env.TEST_ISSUE_MISSING
    process.env.TEST_ISSUE_MISSING = "friendly"
    try {
      const typo = output(repo)
      expect(await yrd(repo, typo.io, "bay", "open", "friendly")).not.toBe(0)
      expect(typo.stderr()).toContain(
        "error: cannot resolve issue 'friendly': configured source 'km' failed: Node not found: friendly",
      )
    } finally {
      restoreEnv("TEST_ISSUE_MISSING", previousMissing)
    }
  })

  it("records the resolved delivery nouns at INFO without default stderr chatter", async () => {
    const { repo } = await repository()
    const logFile = join(repo, "..", "open.jsonl")
    const previousLevel = process.env.LOG_LEVEL
    const previousFile = process.env.LOGGILY_FILE
    process.env.LOG_LEVEL = "info"
    process.env.LOGGILY_FILE = logFile
    try {
      const opened = output(repo)
      expect(await yrd(repo, opened.io, "bay", "run", "--bay", "logged", "--", "true"), opened.stderr()).toBe(0)
      const records = (await readFile(logFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "info",
            name: "yrd:bay:open",
            resolved: {
              issue: null,
              pr: "task/logged",
              bay: "logged",
            },
          }),
        ]),
      )
    } finally {
      restoreEnv("LOG_LEVEL", previousLevel)
      restoreEnv("LOGGILY_FILE", previousFile)
    }

    const quiet = await repository()
    const opened = output(quiet.repo)
    expect(await yrd(quiet.repo, opened.io, "bay", "run", "--bay", "quiet", "--", "true"), opened.stderr()).toBe(0)
    expect(opened.stderr()).toBe("")
  })

  it("teaches bay open when a guest targets no open Bay", async () => {
    const { repo } = await repository()
    const run = output(repo)

    expect(await yrd(repo, run.io, "in", "missing", "--", "true")).not.toBe(0)
    expect(run.stderr()).toContain("no open bay 'missing'")
    expect(run.stderr()).toContain("yrd bay open --bay missing")

    const unwritable = output(repo)
    expect(await yrd(repo, unwritable.io, "bay", "in", "missing", "--issue", CLAIM)).toBe(2)
    expect(unwritable.stderr()).toContain("unknown option '--issue'")

    const bareCommand = output(repo)
    expect(await yrd(repo, bareCommand.io, "in", "missing", "true")).toBe(2)
    expect(bareCommand.stderr()).toContain("child commands must follow --")
  })

  it("attaches PID-addressed guests by selector or cwd without taking the owner's Bay lifecycle", async () => {
    const { repo } = await repository()
    const ownerStop = join(repo, "..", "owner.stop")
    const owner = spawnYrd(
      repo,
      "bay",
      "run",
      "--bay",
      "shared",
      "--",
      "sh",
      "-c",
      `printf owner > owner.txt; : > owner.started; ${BOUNDED_RELEASE_FILE_LOOP}`,
      "_",
      ownerStop,
    )
    await eventually(async () => access(join(repo, ".bays", "B1", "owner.started")))

    const duplicate = output(repo)
    expect(await yrd(repo, duplicate.io, "bay", "run", "--bay", "shared", "--", "true")).not.toBe(0)
    // The refusal names the Bay's id and the exact child, so the operator can
    // paste it without filling in a placeholder.
    expect(duplicate.stderr()).toContain("yrd in B1 -- true")

    const firstGuest = spawnYrd(
      repo,
      "in",
      "shared",
      "--",
      "sh",
      "-c",
      `printf "%s" "$$" > guest-one.pid; : > guest-one.started; ${BOUNDED_RELEASE_FILE_LOOP}`,
      "_",
      join(repo, "..", "guest-never-released"),
    )
    await eventually(async () => access(join(repo, ".bays", "B1", "guest-one.started")))

    const secondGuest = output(repo)
    expect(
      await yrd(repo, secondGuest.io, "bay", "in", "shared", "--", "sh", "-c", 'printf "%s" "$$" > guest-two.pid'),
      secondGuest.stderr(),
    ).toBe(0)
    const guestOne = await readFile(join(repo, ".bays", "B1", "guest-one.pid"), "utf8")
    const guestTwo = await readFile(join(repo, ".bays", "B1", "guest-two.pid"), "utf8")
    expect(guestOne).toMatch(/^\d+$/u)
    expect(guestTwo).toMatch(/^\d+$/u)
    expect(guestTwo).not.toBe(guestOne)
    expect(secondGuest.stdout()).toContain("bay shared → attached task/shared, no issue linked")

    const shell = join(repo, "..", "cwd-shell")
    await writeFile(
      shell,
      `#!/bin/sh
printf '%s' "$$" > cwd-guest.pid
`,
    )
    await chmod(shell, 0o755)
    const previousShell = process.env.SHELL
    process.env.SHELL = shell
    try {
      const cwdGuest = output(join(repo, ".bays", "B1"))
      expect(await yrd(repo, cwdGuest.io, "in"), cwdGuest.stderr()).toBe(0)
      const cwdPid = await readFile(join(repo, ".bays", "B1", "cwd-guest.pid"), "utf8")
      expect(cwdPid).toMatch(/^\d+$/u)
      expect(cwdGuest.stdout()).toContain("bay shared → attached task/shared, no issue linked")
    } finally {
      restoreEnv("SHELL", previousShell)
    }

    await writeFile(ownerStop, "")
    const [ownerExit, ownerStdout, ownerStderr] = await Promise.all([
      owner.exited,
      new Response(owner.stdout).text(),
      new Response(owner.stderr).text(),
    ])
    expect(ownerExit, ownerStderr).toBe(0)
    expect(ownerStdout).toContain("bay shared → new task/shared, no issue linked")
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(`${repo}/.bays/`)
    expect(await git(repo, "show", "refs/remotes/origin/task/shared:guest-one.pid")).toBe(guestOne)
    expect(await git(repo, "show", "refs/remotes/origin/task/shared:guest-two.pid")).toBe(guestTwo)
    expect(await git(repo, "show", "refs/remotes/origin/task/shared:cwd-guest.pid")).toMatch(/^\d+$/u)

    const [guestExit, guestStdout, guestStderr] = await Promise.all([
      firstGuest.exited,
      new Response(firstGuest.stdout).text(),
      new Response(firstGuest.stderr).text(),
    ])
    expect(guestExit).toBe(1)
    expect(guestStderr).toContain("guest child exited after SIGTERM")
    expect(guestStdout).toContain("bay shared → attached task/shared, no issue linked")
  })

  it("installs a fresh Bay's dependencies before its child starts", async () => {
    const fixture = await packagedRepository()
    const tools = await packageManagerShim()
    try {
      const run = output(fixture.repo)
      expect(await yrd(fixture.repo, run.io, "bay", "run", CLAIM, "--", "ag"), run.stderr()).toBe(0)
      // The repository named its package manager with a lockfile; the child
      // must find its dependencies already installed, which is the whole
      // point — `ag` died on module resolution without this.
      expect((await readFile(tools.log, "utf8")).trim().split("\n")).toEqual([
        "install --frozen-lockfile --ignore-scripts",
        "run postinstall",
      ])
      expect(await git(fixture.repo, "show", `refs/remotes/origin/${BRANCH}:agent.deps`)).toBe("present")
      expect(run.stderr()).toContain("bun install --frozen-lockfile --ignore-scripts")
    } finally {
      await tools.restore()
    }
  })

  it("fails the launch loudly when a Bay's dependencies cannot be installed", async () => {
    const fixture = await packagedRepository()
    const tools = await packageManagerShim({ install: "fails" })
    try {
      const run = output(fixture.repo)
      expect(await yrd(fixture.repo, run.io, "bay", "run", CLAIM, "--", "ag")).toBe(1)
      const stderr = run.stderr()
      expect(stderr).toContain("could not install its dependencies")
      expect(stderr).toContain("bun install --frozen-lockfile --ignore-scripts")
      // The tail is the diagnosis: without it the operator holds an orphaned
      // Bay and no reason.
      expect(stderr).toContain("lockfile had changes, but lockfile is frozen")

      // A child must never start in a Bay that could not be provisioned.
      const bayPath = await activeBayPath(fixture.repo, "B1")
      await expect(access(join(bayPath, "agent.argv"))).rejects.toThrow()
      const bays = output(fixture.repo)
      expect(await yrd(fixture.repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
      expect(JSON.parse(bays.stdout())).toMatchObject({
        bays: [
          expect.objectContaining({
            orphan: expect.objectContaining({ reason: expect.stringContaining("bun install") }),
          }),
        ],
      })
    } finally {
      await tools.restore()
    }
  })

  it("makes manual bay run plus ag converge on integrated PR state", async () => {
    const tools = await mkdtemp(join(tmpdir(), "yrd-do-submit-tools-"))
    roots.push(tools)
    await writeFile(
      join(tools, "ag"),
      `#!/bin/sh
branch="$(git branch --show-current)"
name="\${branch##*/}"
printf 'worked %s\\n' "$name"
printf '%s\\n' "$*" > agent.prompt
printf '%s\\n' "$name" > result.txt
git add agent.prompt result.txt
git commit -qm "work $name"
"$YRD_TEST_BUN" "$YRD_TEST_CLI" bay submit
"$YRD_TEST_BUN" "$YRD_TEST_CLI" queue run PR1 --steps check,merge
`,
    )
    await chmod(join(tools, "ag"), 0o755)
    const previousPath = process.env.PATH
    const previousBun = process.env.YRD_TEST_BUN
    const previousCli = process.env.YRD_TEST_CLI
    process.env.PATH = `${tools}:${previousPath ?? ""}`
    process.env.YRD_TEST_BUN = process.execPath
    process.env.YRD_TEST_CLI = join(import.meta.dirname, "../../../bin/yrd.ts")
    try {
      const manualFixture = await repository()
      const manual = output(manualFixture.repo)
      expect(
        await yrd(manualFixture.repo, manual.io, "bay", "run", CLAIM, "--", "ag", "Do the issue, then submit."),
        manual.stderr(),
      ).toBe(0)
      expect(manual.stdout()).toContain("worked s2-fixture")

      const prs = output(manualFixture.repo)
      expect(await yrd(manualFixture.repo, prs.io, "pr", "list", "--json"), prs.stderr()).toBe(0)
      const projection = JSON.parse(prs.stdout()) as {
        prs: readonly { branch: string; issue?: string; status: string; taskStatus: string }[]
      }
      expect(projection.prs).toHaveLength(1)
      expect(projection.prs[0]).toMatchObject({
        branch: BRANCH,
        issue: CLAIM,
        status: "integrated",
        taskStatus: "done",
      })
      expect(await git(manualFixture.repo, "show", `refs/remotes/origin/${BRANCH}:result.txt`)).toBe("s2-fixture")
    } finally {
      restoreEnv("PATH", previousPath)
      restoreEnv("YRD_TEST_BUN", previousBun)
      restoreEnv("YRD_TEST_CLI", previousCli)
    }
  })

  it("keeps sh as an owner alias and passes explicit guest argv through unchanged", async () => {
    const { repo } = await repository()
    const tools = join(repo, "..", "alias-tools")
    const shell = join(tools, "fixture-shell")
    const worker = join(tools, "fixture-worker")
    const log = join(repo, "..", "aliases.log")
    await mkdir(tools, { recursive: true })
    await writeFile(
      shell,
      `#!/bin/sh
printf 'sh %s %s\\n' "$$" "$*" >> "$YRD_TEST_ALIAS_LOG"
printf sh > sh-ran.txt
`,
    )
    await writeFile(
      worker,
      `#!/bin/sh
printf 'worker %s %s\\n' "$$" "$*" >> "$YRD_TEST_ALIAS_LOG"
printf worker > worker-ran.txt
`,
    )
    await Promise.all([chmod(shell, 0o755), chmod(worker, 0o755)])
    const previousShell = process.env.SHELL
    const previousLog = process.env.YRD_TEST_ALIAS_LOG
    process.env.SHELL = shell
    process.env.YRD_TEST_ALIAS_LOG = log
    try {
      const shellOwner = output(repo)
      expect(await yrd(repo, shellOwner.io, "sh", "--bay", "shell-owner"), shellOwner.stderr()).toBe(0)
      expect(shellOwner.stdout()).toContain("bay shell-owner → new task/shell-owner, no issue linked")

      const ownerStop = join(repo, "..", "alias-owner.stop")
      const owner = spawnYrd(
        repo,
        "bay",
        "run",
        "--bay",
        "shared",
        "--",
        "sh",
        "-c",
        `: > ready; ${BOUNDED_RELEASE_FILE_LOOP}`,
        "_",
        ownerStop,
      )
      const bayPath = await activeBayPath(repo, "shared")
      await eventually(async () => access(join(bayPath, "ready")))

      const shellGuest = output(bayPath)
      expect(await yrd(repo, shellGuest.io, "in"), shellGuest.stderr()).toBe(0)
      const workerGuest = output(repo)
      expect(await yrd(repo, workerGuest.io, "in", "shared", "--", worker, "literal value"), workerGuest.stderr()).toBe(
        0,
      )

      await writeFile(ownerStop, "")
      const [ownerExit, ownerStderr] = await Promise.all([owner.exited, new Response(owner.stderr).text()])
      expect(ownerExit, ownerStderr).toBe(0)

      const lines = (await readFile(log, "utf8")).trim().split("\n")
      expect(lines[0]).toMatch(/^sh \d+\s*$/u)
      expect(lines[1]).toMatch(/^sh \d+\s*$/u)
      expect(lines[2]).toMatch(/^worker \d+ literal value$/u)
      expect(shellGuest.stdout()).toContain("bay shared → attached task/shared, no issue linked")
      expect(workerGuest.stdout()).toContain("bay shared → attached task/shared, no issue linked")
    } finally {
      restoreEnv("SHELL", previousShell)
      restoreEnv("YRD_TEST_ALIAS_LOG", previousLog)
    }
  })

  it("runs $SHELL in a fresh unique Bay when run has no operands", async () => {
    const { repo } = await repository()
    const shell = join(repo, "..", "fixture-shell")
    const shellLog = join(repo, "..", "shell-name")
    await writeFile(
      shell,
      `#!/bin/sh
printf ran > "$YRD_TEST_SHELL_LOG"
`,
    )
    await chmod(shell, 0o755)
    const previousShell = process.env.SHELL
    const previousLog = process.env.YRD_TEST_SHELL_LOG
    process.env.SHELL = shell
    process.env.YRD_TEST_SHELL_LOG = shellLog
    try {
      const run = output(repo)
      expect(await yrd(repo, run.io, "bay", "run"), run.stderr()).toBe(0)
      const match = run.stdout().match(/bay (yrd-[0-9a-f]{12}) → new task\/\1, no issue linked/u)
      expect(match).not.toBeNull()
      expect(await readFile(shellLog, "utf8")).toBe("ran")
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(`${repo}/.bays/`)
    } finally {
      restoreEnv("SHELL", previousShell)
      restoreEnv("YRD_TEST_SHELL_LOG", previousLog)
    }
  })

  it("keeps a branch carrier without creating a PR, runs exact argv, and closes synchronously", async () => {
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
    expect(JSON.parse(prs.stdout())).toMatchObject({ prs: [] })
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
    const prs = output(repo)
    expect(await yrd(repo, prs.io, "pr", "list", "--issue", CLAIM, "--json"), prs.stderr()).toBe(0)
    expect(JSON.parse(prs.stdout())).toMatchObject({ prs: [] })
  })

  it("keeps the Bay open without an archive receipt when the checkpoint commit fails", async () => {
    const { repo } = await repository()
    const originalHead = await git(repo, "rev-parse", "HEAD")
    const preCommit = join(repo, ".git", "hooks", "pre-commit")
    await writeFile(preCommit, "#!/bin/sh\nprintf 'checkpoint denied' >&2\nexit 17\n")
    await chmod(preCommit, 0o755)
    const run = output(repo)

    expect(
      await yrd(repo, run.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf payload > scratch.txt"),
      run.stderr(),
    ).toBe(1)
    expect(run.stderr()).toContain("scratch.txt")
    expect(run.stderr()).toContain("checkpoint commit failed")
    expect(run.stderr()).toContain("checkpoint denied")
    expect(run.stderr()).toContain("Bay remains open and no archive receipt was written")
    expect(await git(repo, "rev-parse", `refs/remotes/origin/${BRANCH}`)).toBe(originalHead)
    await expect(git(repo, "show", `refs/remotes/origin/${BRANCH}:scratch.txt`)).rejects.toThrow()
    await expect(git(repo, "rev-parse", "--verify", "refs/yrd/closed/B1")).rejects.toThrow()

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    const projection = JSON.parse(bays.stdout()) as {
      bays: readonly { archive?: unknown; issue?: string; status: string }[]
    }
    const failed = projection.bays.find((bay) => bay.issue === CLAIM)
    expect(failed).toMatchObject({ issue: CLAIM, status: "open" })
    expect(failed?.archive).toBeUndefined()
  })

  it("refuses to archive an unchanged head when the dirty checkpoint commit no-ops", async () => {
    const { repo } = await repository()
    const originalHead = await git(repo, "rev-parse", "HEAD")
    const postCommit = join(repo, ".git", "hooks", "post-commit")
    await writeFile(
      postCommit,
      ["#!/bin/sh", 'case "$(git log -1 --format=%s)" in', "  wip:*) git reset --hard -q HEAD^ ;;", "esac", ""].join(
        "\n",
      ),
    )
    await chmod(postCommit, 0o755)
    const run = output(repo)

    expect(
      await yrd(repo, run.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf payload > scratch.txt"),
      run.stderr(),
    ).toBe(1)
    expect(run.stderr()).toContain("scratch.txt")
    expect(run.stderr()).toContain("did not advance HEAD")
    expect(await git(repo, "rev-parse", `refs/remotes/origin/${BRANCH}`)).toBe(originalHead)
    await expect(git(repo, "show", `refs/remotes/origin/${BRANCH}:scratch.txt`)).rejects.toThrow()
    await expect(git(repo, "rev-parse", "--verify", "refs/yrd/closed/B1")).rejects.toThrow()
    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    const projection = JSON.parse(bays.stdout()) as {
      bays: readonly { archive?: unknown; issue?: string; status: string }[]
    }
    const failed = projection.bays.find((bay) => bay.issue === CLAIM)
    expect(failed).toMatchObject({ issue: CLAIM, status: "open" })
    expect(failed?.archive).toBeUndefined()
  })

  it("refuses to archive an advancing checkpoint that lost the staged content", async () => {
    const { repo } = await repository()
    const originalHead = await git(repo, "rev-parse", "HEAD")
    const postCommit = join(repo, ".git", "hooks", "post-commit")
    await writeFile(
      postCommit,
      [
        "#!/bin/sh",
        'case "$(git log -1 --format=%s)" in',
        "  wip:*)",
        "    git reset --hard -q HEAD^",
        "    git commit --allow-empty -qm 'replacement checkpoint'",
        "    ;;",
        "esac",
        "",
      ].join("\n"),
    )
    await chmod(postCommit, 0o755)
    const run = output(repo)

    expect(
      await yrd(repo, run.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf payload > scratch.txt"),
      run.stderr(),
    ).toBe(1)
    expect(run.stderr()).toContain("scratch.txt")
    expect(run.stderr()).toContain("did not preserve the staged content")
    expect(await git(repo, "rev-parse", `refs/remotes/origin/${BRANCH}`)).toBe(originalHead)
    await expect(git(repo, "show", `refs/remotes/origin/${BRANCH}:scratch.txt`)).rejects.toThrow()
    await expect(git(repo, "rev-parse", "--verify", "refs/yrd/closed/B1")).rejects.toThrow()
  })

  it("reopens a closed claim without implicitly creating or updating a PR", async () => {
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
    expect(JSON.parse(prs.stdout())).toMatchObject({ prs: [] })
  })

  it("uses the branch of an existing claim draft without implicitly recutting it", async () => {
    const { repo } = await repository()
    const branch = "topic/existing-claim"
    await git(repo, "switch", "-qc", branch)
    await writeFile(join(repo, "claim.txt"), "existing\n")
    await git(repo, "add", "claim.txt")
    await git(repo, "commit", "-qm", "existing claim")
    const originalHead = await git(repo, "rev-parse", "HEAD")
    await git(repo, "push", "-q", "-u", "origin", branch)
    await git(repo, "switch", "-q", "main")

    const draft = output(repo)
    expect(await yrd(repo, draft.io, "pr", "create", branch, "--issue", CLAIM), draft.stderr()).toBe(0)
    await git(repo, "branch", "-D", branch)
    await git(repo, "update-ref", "-d", `refs/remotes/origin/${branch}`)
    const run = output(repo)
    expect(
      await yrd(repo, run.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf continued > continued.txt"),
      run.stderr(),
    ).toBe(0)

    expect(await git(repo, "show", `refs/remotes/origin/${branch}:continued.txt`)).toBe("continued")
    const prs = output(repo)
    expect(await yrd(repo, prs.io, "pr", "list", "--issue", CLAIM, "--json"), prs.stderr()).toBe(0)
    expect(JSON.parse(prs.stdout())).toMatchObject({
      prs: [{ branch, issue: CLAIM, status: "pushed", revs: [{ n: 1, head: originalHead }] }],
    })
  })

  it("targets an existing PR branch through --pr without implicitly recutting it", async () => {
    const { repo } = await repository()
    const branch = "topic/explicit-target"
    await git(repo, "switch", "-qc", branch)
    await writeFile(join(repo, "claim.txt"), "existing\n")
    await git(repo, "add", "claim.txt")
    await git(repo, "commit", "-qm", "existing target")
    const originalHead = await git(repo, "rev-parse", "HEAD")
    await git(repo, "push", "-q", "-u", "origin", branch)
    await git(repo, "switch", "-q", "main")

    const draft = output(repo)
    expect(await yrd(repo, draft.io, "pr", "create", branch), draft.stderr()).toBe(0)
    await git(repo, "branch", "-D", branch)
    await git(repo, "update-ref", "-d", `refs/remotes/origin/${branch}`)

    const run = output(repo)
    expect(
      await yrd(repo, run.io, "bay", "run", "--pr", branch, "--", "sh", "-c", "printf continued > continued.txt"),
      run.stderr(),
    ).toBe(0)
    expect(run.stdout()).toContain(`bay explicit-target → reattached ${branch}, no issue linked`)
    expect(await git(repo, "show", `refs/remotes/origin/${branch}:continued.txt`)).toBe("continued")

    const prs = output(repo)
    expect(await yrd(repo, prs.io, "pr", "view", branch, "--json"), prs.stderr()).toBe(0)
    expect(JSON.parse(prs.stdout())).toMatchObject({
      pr: { branch, status: "pushed", revs: [{ n: 1, head: originalHead }] },
    })
  })

  it("opens a branch-held PR at its recorded head through --pr", async () => {
    const { repo } = await repository()
    const branch = "topic/held-by-author"
    await git(repo, "switch", "-qc", branch)
    await writeFile(join(repo, "claim.txt"), "held by author\n")
    await git(repo, "add", "claim.txt")
    await git(repo, "commit", "-qm", "held candidate")
    const originalHead = await git(repo, "rev-parse", "HEAD")
    await git(repo, "push", "-q", "-u", "origin", branch)
    await git(repo, "switch", "-q", "main")

    const draft = output(repo)
    expect(await yrd(repo, draft.io, "pr", "create", branch), draft.stderr()).toBe(0)
    const authorSlot = join(repo, "..", "author-slot")
    await git(repo, "worktree", "add", "-q", authorSlot, branch)

    const open = output(repo)
    expect(await yrd(repo, open.io, "bay", "open", "--pr", branch), open.stderr()).toBe(0)

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    const bay = (JSON.parse(bays.stdout()) as { bays: Array<{ id: string; headSha?: string; path?: string }> }).bays[0]
    expect(bay).toMatchObject({ id: "B1", headSha: originalHead, path: expect.any(String) })
    expect(await git(bay?.path ?? "", "rev-parse", "HEAD")).toBe(originalHead)

    await writeFile(join(bay?.path ?? "", "continued.txt"), "continued in detached Bay\n")
    await git(bay?.path ?? "", "add", "continued.txt")
    await git(bay?.path ?? "", "commit", "-qm", "continue held candidate")
    const continuedHead = await git(bay?.path ?? "", "rev-parse", "HEAD")
    const refresh = output(bay?.path ?? repo)
    expect(await yrd(repo, refresh.io, "bay", "refresh", bay?.id ?? ""), refresh.stderr()).toBe(0)

    const refreshed = output(repo)
    expect(await yrd(repo, refreshed.io, "bay", "list", "--json"), refreshed.stderr()).toBe(0)
    expect(JSON.parse(refreshed.stdout())).toMatchObject({
      bays: [{ id: "B1", branch, headSha: continuedHead, status: "open" }],
    })
  })

  it("repairs a live claim draft whose local branch lost its tracking ref", async () => {
    const { repo } = await repository()
    const branch = "topic/local-claim-without-tracking"
    await git(repo, "switch", "-qc", branch)
    await writeFile(join(repo, "claim.txt"), "existing\n")
    await git(repo, "add", "claim.txt")
    await git(repo, "commit", "-qm", "existing claim")
    await git(repo, "push", "-q", "-u", "origin", branch)
    await git(repo, "switch", "-q", "main")

    const draft = output(repo)
    expect(await yrd(repo, draft.io, "pr", "create", branch, "--issue", CLAIM), draft.stderr()).toBe(0)
    await git(repo, "update-ref", "-d", `refs/remotes/origin/${branch}`)

    const run = output(repo)
    expect(
      await yrd(repo, run.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf continued > continued.txt"),
      run.stderr(),
    ).toBe(0)

    expect(await git(repo, "show", `refs/remotes/origin/${branch}:continued.txt`)).toBe("continued")
  })

  it("recovers a live claim draft from its tracking head when the remote branch was deleted", async () => {
    const { repo } = await repository()
    const branch = "topic/deleted-remote-claim"
    await git(repo, "switch", "-qc", branch)
    await writeFile(join(repo, "claim.txt"), "preserve claim head\n")
    await git(repo, "add", "claim.txt")
    await git(repo, "commit", "-qm", "existing claim")
    await git(repo, "push", "-q", "-u", "origin", branch)
    await git(repo, "switch", "-q", "main")

    const draft = output(repo)
    expect(await yrd(repo, draft.io, "pr", "create", branch, "--issue", CLAIM), draft.stderr()).toBe(0)
    await git(repo, "branch", "-D", branch)
    const origin = await git(repo, "remote", "get-url", "origin")
    await git(origin, "update-ref", "-d", `refs/heads/${branch}`)

    const run = output(repo)
    expect(
      await yrd(repo, run.io, "bay", "run", CLAIM, "--", "sh", "-c", "printf continued > continued.txt"),
      run.stderr(),
    ).toBe(0)

    expect(await git(repo, "show", `refs/remotes/origin/${branch}:claim.txt`)).toBe("preserve claim head")
    expect(await git(repo, "show", `refs/remotes/origin/${branch}:continued.txt`)).toBe("continued")
  })

  it("refuses to recreate a deleted claim remote from a rewound local branch", async () => {
    const { repo } = await repository()
    const branch = "topic/rewound-local-claim"
    await git(repo, "switch", "-qc", branch)
    await writeFile(join(repo, "claim.txt"), "preserve claim head\n")
    await git(repo, "add", "claim.txt")
    await git(repo, "commit", "-qm", "existing claim")
    await git(repo, "push", "-q", "-u", "origin", branch)
    await git(repo, "switch", "-q", "main")

    const draft = output(repo)
    expect(await yrd(repo, draft.io, "pr", "create", branch, "--issue", CLAIM), draft.stderr()).toBe(0)
    const origin = await git(repo, "remote", "get-url", "origin")
    await git(origin, "update-ref", "-d", `refs/heads/${branch}`)
    await git(repo, "branch", "-f", branch, "main")

    const run = output(repo)
    expect(await yrd(repo, run.io, "bay", "run", CLAIM, "--", "true"), run.stderr()).not.toBe(0)
    expect(await git(repo, "ls-remote", "origin", `refs/heads/${branch}`)).toBe("")
  })

  it("refuses a live claim draft after its authoritative branch carriers are lost", async () => {
    for (const localCarrier of ["rewound", "absent"] as const) {
      const { repo } = await repository()
      const branch = `topic/lost-claim-${localCarrier}`
      await git(repo, "switch", "-qc", branch)
      await writeFile(join(repo, "claim.txt"), "preserve claim head\n")
      await git(repo, "add", "claim.txt")
      await git(repo, "commit", "-qm", "existing claim")
      await git(repo, "push", "-q", "-u", "origin", branch)
      await git(repo, "switch", "-q", "main")

      const draft = output(repo)
      expect(await yrd(repo, draft.io, "pr", "create", branch, "--issue", CLAIM), draft.stderr()).toBe(0)
      const origin = await git(repo, "remote", "get-url", "origin")
      await git(origin, "update-ref", "-d", `refs/heads/${branch}`)
      await git(repo, "update-ref", "-d", `refs/remotes/origin/${branch}`)
      if (localCarrier === "rewound") {
        await git(repo, "branch", "-f", branch, "main")
      } else {
        await git(repo, "branch", "-D", branch)
      }

      const run = output(repo)
      expect(await yrd(repo, run.io, "bay", "run", CLAIM, "--", "true"), run.stderr()).not.toBe(0)
      expect(await git(repo, "ls-remote", "origin", `refs/heads/${branch}`)).toBe("")
    }
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
    expect(await yrd(repo, bays.io, "bay", "list", "--closed", "--json"), bays.stderr()).toBe(0)
    expect(JSON.parse(bays.stdout())).toMatchObject({
      bays: [
        expect.objectContaining({
          issue: claim,
          orphan: expect.objectContaining({ reason: expect.stringContaining("setup failed") }),
        }),
      ],
    })
  })

  it("refuses an unrelated remote-only task branch that has not been fetched", async () => {
    const { repo } = await repository()
    const claim = "@km/test/foreign-remote"
    const branch = "task/foreign-remote"
    const remoteHead = await git(repo, "rev-parse", "main")
    await git(repo, "push", "-q", "origin", `${remoteHead}:refs/heads/${branch}`)
    await writeFile(join(repo, "advance-main.txt"), "newer base\n")
    await git(repo, "add", "advance-main.txt")
    await git(repo, "commit", "-qm", "advance main past unrelated remote branch")
    await git(repo, "push", "-q", "origin", "main")
    await git(repo, "update-ref", "-d", `refs/remotes/origin/${branch}`)

    const run = output(repo)
    expect(await yrd(repo, run.io, "bay", "run", claim, "--", "true"), run.stderr()).not.toBe(0)
    expect(await git(repo, "ls-remote", "origin", `refs/heads/${branch}`)).toBe(`${remoteHead}\trefs/heads/${branch}`)

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--closed", "--json"), bays.stderr()).toBe(0)
    expect(JSON.parse(bays.stdout())).toMatchObject({
      bays: [
        expect.objectContaining({
          issue: claim,
          orphan: expect.objectContaining({ reason: expect.stringContaining("setup failed") }),
        }),
      ],
    })
  })

  it("keeps distinct full claims with the same basename on distinct branch carriers", async () => {
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

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--closed", "--json"), bays.stderr()).toBe(0)
    const rows = (JSON.parse(bays.stdout()) as { bays: readonly { branch: string; issue?: string }[] }).bays.filter(
      (bay) => bay.issue === firstClaim || bay.issue === secondClaim,
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
    expect(await git(path.stdout().trim(), "branch", "--show-current")).toMatch(/^task\/alias-active(?:-|$)/u)
  })

  it("does not rewrite an existing orphan when a duplicate active claim is refused", async () => {
    const { repo } = await repository()
    const failed = output(repo)
    expect(await yrd(repo, failed.io, "bay", "run", CLAIM, "--", "sh", "-c", "exit 17"), failed.stderr()).toBe(1)

    const duplicate = output(repo)
    expect(await yrd(repo, duplicate.io, "bay", "run", CLAIM, "--", "true"), duplicate.stderr()).not.toBe(0)
    expect(duplicate.stderr()).toContain("yrd in B1 -- true")

    const attached = output(repo)
    expect(await yrd(repo, attached.io, "in", "B1", "--", "true"), attached.stderr()).toBe(0)

    const bays = output(repo)
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
    const projection = JSON.parse(bays.stdout()) as {
      bays: readonly { issue?: string; orphan?: { reason: string } }[]
    }
    expect(projection).toMatchObject({
      bays: [
        expect.objectContaining({
          issue: CLAIM,
          orphan: expect.objectContaining({ reason: expect.stringContaining("child exited 17") }),
        }),
      ],
    })
    expect(projection.bays).toHaveLength(1)
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
      status: "open",
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
        `printf started > child.started; ${BOUNDED_ONE_SECOND_LOOP}`,
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
          status: "open",
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
          status: "open",
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
  await writeFile(
    join(repo, ".yrd.yml"),
    `base: main
batch: 1
checks: [{check: {run: "true"}}]
${JOURNAL_CONFIG}`,
  )
  await git(repo, "add", "README.md", ".yrd.yml")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "push", "-q", "-u", "origin", "main")
  return { repo }
}

/**
 * A repository that declares dependencies, the way every repository a Bay is
 * cut from does. `node_modules` is ignored so an installed Bay still reads as
 * clean — an adoption must not mistake its own provisioning for the operator's
 * uncommitted work.
 */
async function packagedRepository(): Promise<{ repo: string }> {
  const fixture = await repository()
  await writeFile(
    join(fixture.repo, "package.json"),
    `${JSON.stringify({ name: "bay-fixture", private: true, scripts: { postinstall: "true" } }, null, 2)}\n`,
  )
  await writeFile(join(fixture.repo, "bun.lock"), "{}\n")
  await writeFile(join(fixture.repo, ".gitignore"), "node_modules/\n")
  await git(fixture.repo, "add", "package.json", "bun.lock", ".gitignore")
  await git(fixture.repo, "commit", "-qm", "declare dependencies")
  await git(fixture.repo, "push", "-q", "origin", "main")
  return fixture
}

/**
 * `bun` and `ag` stand-ins on PATH.
 *
 * The package-manager shim records provisioning argv and passes everything else
 * through to the real Bun: the managed push receiver runs under
 * `#!/usr/bin/env bun`, so a shim that swallowed every invocation would break
 * the Bay's own delivery path rather than the install under test.
 */
async function packageManagerShim(
  options: Readonly<{ install?: "succeeds" | "fails" }> = {},
): Promise<{ bin: string; log: string; restore(): Promise<void> }> {
  const bin = await mkdtemp(join(tmpdir(), "yrd-bay-deps-tools-"))
  roots.push(bin)
  const log = join(bin, "package-manager.log")
  await writeFile(log, "")
  const provision =
    options.install === "fails"
      ? `  install)
    printf 'error: lockfile had changes, but lockfile is frozen\\n' >&2
    exit 1
    ;;
  run)
    exit 0
    ;;`
      : `  install)
    mkdir -p node_modules
    exit 0
    ;;
  run)
    exit 0
    ;;`
  await writeFile(
    join(bin, "bun"),
    `#!/bin/sh
case "$1" in
  install|run)
    printf '%s\\n' "$*" >> "$YRD_TEST_PACKAGE_MANAGER_LOG"
    ;;
  *)
    exec "$YRD_TEST_REAL_BUN" "$@"
    ;;
esac
case "$1" in
${provision}
esac
`,
  )
  await chmod(join(bin, "bun"), 0o755)
  await writeFile(join(bin, "ag"), AG_ARGV_RECORDER)
  await chmod(join(bin, "ag"), 0o755)
  const previous = {
    path: process.env.PATH,
    log: process.env.YRD_TEST_PACKAGE_MANAGER_LOG,
    bun: process.env.YRD_TEST_REAL_BUN,
  }
  process.env.PATH = `${bin}:${previous.path ?? ""}`
  process.env.YRD_TEST_PACKAGE_MANAGER_LOG = log
  process.env.YRD_TEST_REAL_BUN = process.execPath
  return {
    bin,
    log,
    restore: async () => {
      restoreEnv("PATH", previous.path)
      restoreEnv("YRD_TEST_PACKAGE_MANAGER_LOG", previous.log)
      restoreEnv("YRD_TEST_REAL_BUN", previous.bun)
      await Promise.resolve()
    },
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
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

function gitBay(repo: string, io: YrdCliIO, ...args: string[]): Promise<0 | 1 | 2 | 3> {
  return runYrdProcess([process.execPath, "/usr/local/bin/git-bay", "--repo", repo, ...args], io)
}

function spawnYrd(repo: string, ...args: string[]) {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "--repo", repo, ...args],
    {
      cwd: repo,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  spawnedYrdProcesses.add(child)
  void child.exited.then(() => spawnedYrdProcesses.delete(child))
  return child
}

async function stopSpawnedYrdProcesses(): Promise<void> {
  const processes = Array.from(spawnedYrdProcesses)
  spawnedYrdProcesses.clear()
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  }
  await Promise.all(
    processes.map(async (child) => {
      const outcome = await Promise.race([child.exited, Bun.sleep(3_000).then(() => "timeout" as const)])
      if (outcome !== "timeout") return
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await child.exited
    }),
  )
}

async function activeBayPath(repo: string, selector: string): Promise<string> {
  let resolved: string | undefined
  await eventually(async () => {
    const path = output(repo)
    const exitCode = await yrd(repo, path.io, "bay", "path", selector)
    if (exitCode !== 0) throw new Error(path.stderr())
    resolved = path.stdout().trim()
    await access(resolved)
  })
  if (resolved === undefined) throw new Error(`Bay '${selector}' did not expose an active path`)
  return resolved
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

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

function killQuiet(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // silent-fallback-allow: best-effort fixture cleanup accepts an already-dead process.
  }
}
