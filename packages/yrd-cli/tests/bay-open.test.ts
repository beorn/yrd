/**
 * @failure `yrd bay open/run` loses work, returns before cleanup, or leaves a failed child unflagged.
 * @level l3
 * @consumer @yrd/cli Bay lifecycle
 */
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { runYrdProcess } from "../src/host.ts"
import type { YrdCliIO } from "../src/types.ts"

const roots: string[] = []
const CLAIM = "@km/test/s2-fixture"
const BRANCH = "task/s2-fixture"
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("yrd bay open/run/in/do", { timeout: 30_000 }, () => {
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
      ["ag", "--help"],
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
    const doHelp = output(repo)
    expect(await yrd(repo, doHelp.io, "do", "--help"), doHelp.stderr()).toBe(0)
    expect(doHelp.stdout()).toContain("<issue-or-pr>")
  })

  it("opens a persistent Bay without running a command", async () => {
    return withoutRuntimeName(async () => {
      const { repo } = await repository()
      await configureNotify(repo)
      const wire = `file:${join(repo, "..", "wire.jsonl")}`
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
        expect(await yrd(repo, opened.io, "--wire", wire, "bay", "open", "--bay", "docs"), opened.stderr()).toBe(0)
        expect(await Bun.file(marker).exists()).toBe(false)
        const bayPath = opened.stdout().trim()
        expect(isAbsolute(bayPath)).toBe(true)
        expect(opened.stdout().trimEnd()).not.toContain("\n")
        expect(opened.stderr()).toContain("bay docs → new task/docs, no issue linked, name docs")
        expect(await git(bayPath, "branch", "--show-current")).toBe("task/docs")

        const bays = output(repo)
        expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
        expect(JSON.parse(bays.stdout())).toMatchObject({
          bays: [expect.objectContaining({ name: "docs", status: "active" })],
        })

        const closed = output(repo)
        expect(await yrd(repo, closed.io, "--wire", wire, "bay", "close", "docs"), closed.stderr()).toBe(0)
        const afterClose = output(repo)
        expect(await yrd(repo, afterClose.io, "bay", "list", "--json"), afterClose.stderr()).toBe(0)
        expect(JSON.parse(afterClose.stdout())).toMatchObject({
          bays: [expect.objectContaining({ name: "docs", status: "closed" })],
        })
      } finally {
        restoreEnv("SHELL", previousShell)
        restoreEnv("YRD_TEST_SHELL_MARKER", previousMarker)
      }
    })
  })

  it("runs one scoped command and keeps a successful Bay only with --keep", async () => {
    return withoutRuntimeName(async () => {
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
      expect(run.stdout()).toContain("bay once → new task/once, no issue linked, name once")
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
      expect(
        await yrd(keptFixture.repo, closed.io, "bay", "close", "kept"),
        `${closed.stdout()}${closed.stderr()}`,
      ).toBe(0)
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
      expect(duplicate.stderr()).toContain("yrd in shared")
    } finally {
      restoreEnv("SHELL", previousShell)
    }
  })

  it("resolves every run-table row without sigil dispatch or implicit PR intake", async () => {
    return withoutRuntimeName(async () => {
      const journeys = [
        {
          label: "bare positional issue",
          args: ["bay", "run", CLAIM, "--", "sh", "-c", 'printf %s "$HAB_NAME" > resolved.name'],
          expected: `bay s2-fixture → new ${BRANCH}, linked ${CLAIM}, name s2-fixture`,
          branch: BRANCH,
          name: "s2-fixture",
        },
        {
          label: "explicit issue",
          args: ["bay", "run", "--issue", CLAIM, "--", "sh", "-c", 'printf %s "$HAB_NAME" > resolved.name'],
          expected: `bay s2-fixture → new ${BRANCH}, linked ${CLAIM}, name s2-fixture`,
          branch: BRANCH,
          name: "s2-fixture",
        },
        {
          label: "issue-less explicit bay",
          args: ["bay", "run", "--bay", "sandbox", "--", "sh", "-c", 'printf %s "$HAB_NAME" > resolved.name'],
          expected: "bay sandbox → new task/sandbox, no issue linked, name sandbox",
          branch: "task/sandbox",
          name: "sandbox",
        },
        {
          label: "distinct bay linked to an issue",
          args: [
            "bay",
            "run",
            "--bay",
            "named-bay",
            "--issue",
            CLAIM,
            "--",
            "sh",
            "-c",
            'printf %s "$HAB_NAME" > resolved.name',
          ],
          expected: `bay named-bay → new ${BRANCH}, linked ${CLAIM}, name named-bay`,
          branch: BRANCH,
          name: "named-bay",
        },
        {
          label: "name override applies only at the name slot",
          args: [
            "--name",
            "named-session",
            "bay",
            "run",
            CLAIM,
            "--",
            "sh",
            "-c",
            'printf %s "$HAB_NAME" > resolved.name',
          ],
          expected: `bay s2-fixture → new ${BRANCH}, linked ${CLAIM}, name named-session`,
          branch: BRANCH,
          name: "named-session",
        },
      ] as const

      for (const journey of journeys) {
        const { repo } = await repository()
        const opened = output(repo)
        expect(await yrd(repo, opened.io, ...journey.args), `${journey.label}\n${opened.stderr()}`).toBe(0)
        expect(opened.stdout(), journey.label).toContain(journey.expected)
        expect(await git(repo, "show", `refs/remotes/origin/${journey.branch}:resolved.name`)).toBe(journey.name)
        const prs = output(repo)
        expect(await yrd(repo, prs.io, "pr", "list", "--json"), prs.stderr()).toBe(0)
        expect(JSON.parse(prs.stdout())).toMatchObject({ prs: [] })
      }

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
          'printf %s "$HAB_NAME" > resolved.name',
        ),
        continued.stderr(),
      ).toBe(0)
      expect(continued.stdout()).toContain(
        `bay explicit-target → reattached ${branch}, no issue linked, name explicit-target`,
      )
      expect(await git(targeted.repo, "show", `refs/remotes/origin/${branch}:resolved.name`)).toBe("explicit-target")

      const anonymous = await repository()
      const shell = join(anonymous.repo, "..", "anonymous-shell")
      const shellLog = join(anonymous.repo, "..", "anonymous-name")
      await writeFile(shell, `#!/bin/sh\nprintf '%s' "$HAB_NAME" > "$TEST_ANONYMOUS_NAME"\n`)
      await chmod(shell, 0o755)
      const previousShell = process.env.SHELL
      const previousLog = process.env.TEST_ANONYMOUS_NAME
      const previousHabName = process.env.HAB_NAME
      process.env.SHELL = shell
      process.env.TEST_ANONYMOUS_NAME = shellLog
      delete process.env.HAB_NAME
      try {
        const opened = output(anonymous.repo)
        expect(await yrd(anonymous.repo, opened.io, "bay", "run"), opened.stderr()).toBe(0)
        const match = opened.stdout().match(/bay (yrd-[0-9a-f]{12}) → new task\/\1, no issue linked, name \1/u)
        expect(match).not.toBeNull()
        expect(await readFile(shellLog, "utf8")).toBe(match?.[1])
      } finally {
        restoreEnv("SHELL", previousShell)
        restoreEnv("TEST_ANONYMOUS_NAME", previousLog)
        restoreEnv("HAB_NAME", previousHabName)
      }
    })
  })

  it("projects the same owner lifecycle through git bay", async () => {
    return withoutRuntimeName(async () => {
      const { repo } = await repository()
      const opened = output(repo)
      expect(
        await gitBay(repo, opened.io, "run", "--bay", "projected", "--", "sh", "-c", "printf git-bay > projected"),
        opened.stderr(),
      ).toBe(0)
      expect(opened.stdout()).toContain("bay projected → new task/projected, no issue linked, name projected")
      expect(await git(repo, "show", "refs/remotes/origin/task/projected:projected")).toBe("git-bay")
    })
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

  it("records the four resolved nouns at INFO without default stderr chatter", async () => {
    return withoutRuntimeName(async () => {
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
                name: "logged",
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
  })

  it("resolves a sigil issue and registers its mechanical persona in a fresh TTY", async () => {
    const { repo } = await repository()
    const mailbox = `@dev/${basename(repo)}:${String(process.pid)}`
    await configureNotify(repo)
    const fake = await fakeTribe(repo)
    const habName = process.env.HAB_NAME
    const habWire = process.env.HAB_WIRE
    const tribeName = process.env.TRIBE_NAME
    const tribeSessionName = process.env.TRIBE_SESSION_NAME
    const path = process.env.PATH
    const testLog = process.env.TRIBE_TEST_LOG
    delete process.env.HAB_NAME
    delete process.env.HAB_WIRE
    delete process.env.TRIBE_NAME
    delete process.env.TRIBE_SESSION_NAME
    process.env.PATH = `${fake.bin}:${path ?? ""}`
    process.env.TRIBE_TEST_LOG = fake.log
    try {
      const run = output(repo)
      run.io.interactive = true
      expect(await yrd(repo, run.io, "bay", "run", "@km/test/blabla1", "--", "true"), run.stderr()).toBe(0)

      expect(run.stdout()).toContain("bay blabla1 → new task/blabla1, linked @km/test/blabla1")
      expect(await readFile(fake.log, "utf8")).toContain(`join ${mailbox} --delivery pull --json`)
      const bays = output(repo)
      expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
      expect(JSON.parse(bays.stdout())).toMatchObject({
        bays: [expect.objectContaining({ issue: "@km/test/blabla1", by: mailbox, status: "closed" })],
      })
      const prs = output(repo)
      expect(await yrd(repo, prs.io, "pr", "list", "--issue", "@km/test/blabla1", "--json"), prs.stderr()).toBe(0)
      expect(JSON.parse(prs.stdout())).toMatchObject({ prs: [] })
    } finally {
      restoreEnv("HAB_NAME", habName)
      restoreEnv("HAB_WIRE", habWire)
      restoreEnv("TRIBE_NAME", tribeName)
      restoreEnv("TRIBE_SESSION_NAME", tribeSessionName)
      restoreEnv("PATH", path)
      restoreEnv("TRIBE_TEST_LOG", testLog)
    }
  })

  it("keeps mailbox registration supplementary in a TTY but fail-loud in a pipe", async () => {
    const interactiveFixture = await repository()
    await configureNotify(interactiveFixture.repo)
    const fake = await fakeTribe(interactiveFixture.repo, false)
    const habName = process.env.HAB_NAME
    const tribeName = process.env.TRIBE_NAME
    const path = process.env.PATH
    const testLog = process.env.TRIBE_TEST_LOG
    delete process.env.HAB_NAME
    delete process.env.TRIBE_NAME
    process.env.PATH = `${fake.bin}:${path ?? ""}`
    process.env.TRIBE_TEST_LOG = fake.log
    try {
      const tty = output(interactiveFixture.repo)
      tty.io.interactive = true
      expect(
        await yrd(interactiveFixture.repo, tty.io, "bay", "run", "--bay", "friendly", "--", "true"),
        tty.stderr(),
      ).toBe(0)
      expect(tty.stdout()).toContain("bay friendly → new task/friendly, no issue linked")
      expect(tty.stderr()).not.toContain("Tribe signal")

      const pipedFixture = await repository()
      await configureNotify(pipedFixture.repo)
      const piped = output(pipedFixture.repo)
      expect(await yrd(pipedFixture.repo, piped.io, "bay", "run", "--bay", "piped", "--", "true")).not.toBe(0)
      expect(piped.stderr()).toContain("mailbox registration")
    } finally {
      restoreEnv("HAB_NAME", habName)
      restoreEnv("TRIBE_NAME", tribeName)
      restoreEnv("PATH", path)
      restoreEnv("TRIBE_TEST_LOG", testLog)
    }
  })

  it("captures would-be Tribe traffic in a valued file wire without invoking the live adapter", async () => {
    const { repo } = await repository()
    await configureNotify(repo, "false")
    const fake = await fakeTribe(repo)
    const wireLog = join(repo, "..", "wire.jsonl")
    const decoyWire = join(repo, "..", "decoy-wire.jsonl")
    const habName = process.env.HAB_NAME
    const habWire = process.env.HAB_WIRE
    const tribeName = process.env.TRIBE_NAME
    const path = process.env.PATH
    const testLog = process.env.TRIBE_TEST_LOG
    delete process.env.HAB_NAME
    process.env.HAB_WIRE = `file:${decoyWire}`
    delete process.env.TRIBE_NAME
    process.env.PATH = `${fake.bin}:${path ?? ""}`
    process.env.TRIBE_TEST_LOG = fake.log
    try {
      const draft = output(repo)
      expect(
        await yrd(
          repo,
          draft.io,
          "--name",
          "s2-fixture",
          "--wire",
          `file:${wireLog}`,
          "bay",
          "run",
          "s2-fixture",
          "--",
          "true",
        ),
        draft.stderr(),
      ).toBe(0)

      const create = output(repo)
      expect(
        await yrd(
          repo,
          create.io,
          "--name",
          "s2-fixture",
          "--wire",
          `file:${wireLog}`,
          "pr",
          "create",
          BRANCH,
          "--issue",
          CLAIM,
        ),
        create.stderr(),
      ).toBe(0)
      const wire = output(repo)
      expect(
        await yrd(repo, wire.io, "--name", "s2-fixture", "--wire", `file:${wireLog}`, "pr", "ready", BRANCH),
        wire.stderr(),
      ).toBe(1)
      const traffic = await readFile(wireLog, "utf8")
      expect(traffic).toContain('"wire":"tribe.send"')
      expect(traffic).toContain('"to":"@dev/s2-fixture"')
      expect(traffic).toContain("Yrd failed")
      expect(await Bun.file(fake.log).exists()).toBe(false)
      expect(await Bun.file(decoyWire).exists()).toBe(false)
    } finally {
      restoreEnv("HAB_NAME", habName)
      restoreEnv("HAB_WIRE", habWire)
      restoreEnv("TRIBE_NAME", tribeName)
      restoreEnv("PATH", path)
      restoreEnv("TRIBE_TEST_LOG", testLog)
    }
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
    expect(bareCommand.stderr()).toContain("accepts bare `ag` only")
  })

  it("attaches PID-addressed guests by selector or cwd without taking the owner's Bay lifecycle", async () => {
    return withoutRuntimeName(async () => {
      const { repo } = await repository()
      const ownerStop = join(repo, "..", "owner.stop")
      const guestStop = join(repo, "..", "guest.stop")
      const owner = spawnYrd(
        repo,
        "bay",
        "run",
        "--bay",
        "shared",
        "--",
        "sh",
        "-c",
        'printf owner > owner.txt; : > owner.started; while [ ! -f "$1" ]; do sleep 0.05; done',
        "_",
        ownerStop,
      )
      await eventually(async () => access(join(repo, ".bays", "B1", "owner.started")))

      const duplicate = output(repo)
      expect(await yrd(repo, duplicate.io, "bay", "run", "--bay", "shared", "--", "true")).not.toBe(0)
      expect(duplicate.stderr()).toContain("yrd in shared -- <command>")

      const firstGuest = spawnYrd(
        repo,
        "in",
        "shared",
        "--",
        "sh",
        "-c",
        'printf "%s %s" "$HAB_NAME" "$$" > guest-one.name; : > guest-one.started; while [ ! -f "$1" ]; do sleep 0.05; done',
        "_",
        guestStop,
      )
      await eventually(async () => access(join(repo, ".bays", "B1", "guest-one.started")))

      const secondGuest = output(repo)
      expect(
        await yrd(
          repo,
          secondGuest.io,
          "bay",
          "in",
          "shared",
          "--",
          "sh",
          "-c",
          'printf "%s %s" "$HAB_NAME" "$$" > guest-two.name',
        ),
        secondGuest.stderr(),
      ).toBe(0)
      const guestOne = await readFile(join(repo, ".bays", "B1", "guest-one.name"), "utf8")
      const guestTwo = await readFile(join(repo, ".bays", "B1", "guest-two.name"), "utf8")
      expect(guestOne).toMatch(/^shared:(\d+) \1$/u)
      expect(guestTwo).toMatch(/^shared:(\d+) \1$/u)
      expect(guestTwo).not.toBe(guestOne)
      expect(secondGuest.stdout()).toContain(
        `bay shared → attached task/shared, no issue linked, name ${guestTwo.split(" ")[0]}`,
      )

      const helper = output(repo)
      expect(
        await yrd(
          repo,
          helper.io,
          "--name",
          "@shared/helper",
          "in",
          "shared",
          "--",
          "sh",
          "-c",
          'printf "%s %s" "$HAB_NAME" "$$" > helper.name',
        ),
        helper.stderr(),
      ).toBe(0)
      const helperIdentity = await readFile(join(repo, ".bays", "B1", "helper.name"), "utf8")
      expect(helperIdentity).toMatch(/^@shared\/helper:(\d+) \1$/u)
      expect(helper.stdout()).toContain(
        `bay shared → attached task/shared, no issue linked, name ${helperIdentity.split(" ")[0]}`,
      )

      const previousHabName = process.env.HAB_NAME
      process.env.HAB_NAME = "@shared/env-helper"
      try {
        const envHelper = output(repo)
        expect(
          await yrd(
            repo,
            envHelper.io,
            "in",
            "shared",
            "--",
            "sh",
            "-c",
            'printf "%s %s" "$HAB_NAME" "$$" > env-helper.name',
          ),
          envHelper.stderr(),
        ).toBe(0)
        const envHelperIdentity = await readFile(join(repo, ".bays", "B1", "env-helper.name"), "utf8")
        expect(envHelperIdentity).toMatch(/^@shared\/env-helper:(\d+) \1$/u)
        expect(envHelper.stdout()).toContain(
          `bay shared → attached task/shared, no issue linked, name ${envHelperIdentity.split(" ")[0]}`,
        )
      } finally {
        restoreEnv("HAB_NAME", previousHabName)
      }

      const shell = join(repo, "..", "cwd-shell")
      await writeFile(
        shell,
        `#!/bin/sh
printf '%s %s' "$HAB_NAME" "$$" > cwd-guest.name
`,
      )
      await chmod(shell, 0o755)
      const previousShell = process.env.SHELL
      process.env.SHELL = shell
      try {
        const cwdGuest = output(join(repo, ".bays", "B1"))
        expect(await yrd(repo, cwdGuest.io, "in"), cwdGuest.stderr()).toBe(0)
        const cwdIdentity = await readFile(join(repo, ".bays", "B1", "cwd-guest.name"), "utf8")
        expect(cwdIdentity).toMatch(/^shared:(\d+) \1$/u)
        expect(cwdGuest.stdout()).toContain(
          `bay shared → attached task/shared, no issue linked, name ${cwdIdentity.split(" ")[0]}`,
        )
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
      expect(ownerStdout).toContain("bay shared → new task/shared, no issue linked, name shared")
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(`${repo}/.bays/`)
      expect(await git(repo, "show", "refs/remotes/origin/task/shared:guest-one.name")).toBe(guestOne)
      expect(await git(repo, "show", "refs/remotes/origin/task/shared:guest-two.name")).toBe(guestTwo)
      expect(await git(repo, "show", "refs/remotes/origin/task/shared:helper.name")).toBe(helperIdentity)
      expect(await git(repo, "show", "refs/remotes/origin/task/shared:cwd-guest.name")).toMatch(/^shared:(\d+) \1$/u)

      await writeFile(guestStop, "")
      const [guestExit, guestStdout, guestStderr] = await Promise.all([
        firstGuest.exited,
        new Response(firstGuest.stdout).text(),
        new Response(firstGuest.stderr).text(),
      ])
      expect(guestExit, guestStderr).toBe(0)
      expect(guestStdout).toContain(
        `bay shared → attached task/shared, no issue linked, name ${guestOne.split(" ")[0]}`,
      )
    })
  })

  it("launches do through issue-first or existing-PR resolution with the mission primer", async () => {
    return withoutRuntimeName(async () => {
      const tools = await mkdtemp(join(tmpdir(), "yrd-do-tools-"))
      roots.push(tools)
      await writeFile(
        join(tools, "ag"),
        `#!/bin/sh
printf '%s' "$HAB_NAME" > agent.name
printf '%s' "$*" > agent.prompt
`,
      )
      await chmod(join(tools, "ag"), 0o755)
      const previousPath = process.env.PATH
      process.env.PATH = `${tools}:${previousPath ?? ""}`
      try {
        const issueJourney = await repository()
        const issue = output(issueJourney.repo)
        expect(await yrd(issueJourney.repo, issue.io, "do", CLAIM), issue.stderr()).toBe(0)
        expect(issue.stdout()).toContain(`bay s2-fixture → new ${BRANCH}, linked ${CLAIM}, name s2-fixture, via issue`)
        expect(await git(issueJourney.repo, "show", `refs/remotes/origin/${BRANCH}:agent.name`)).toBe("s2-fixture")
        const issuePrimer = await git(issueJourney.repo, "show", `refs/remotes/origin/${BRANCH}:agent.prompt`)
        expect(issuePrimer).toContain(`Mission: work issue ${CLAIM}`)
        expect(issuePrimer).toContain("claim")
        expect(issuePrimer).toContain("work order")

        const prJourney = await repository()
        const branch = "topic/do-existing"
        await git(prJourney.repo, "switch", "-qc", branch)
        await writeFile(join(prJourney.repo, "existing.txt"), "existing\n")
        await git(prJourney.repo, "add", "existing.txt")
        await git(prJourney.repo, "commit", "-qm", "existing target")
        await git(prJourney.repo, "push", "-q", "-u", "origin", branch)
        await git(prJourney.repo, "switch", "-q", "main")
        const draft = output(prJourney.repo)
        expect(await yrd(prJourney.repo, draft.io, "pr", "create", branch), draft.stderr()).toBe(0)

        const previousMissing = process.env.TEST_ISSUE_MISSING
        process.env.TEST_ISSUE_MISSING = "PR1"
        try {
          const pr = output(prJourney.repo)
          expect(await yrd(prJourney.repo, pr.io, "do", "PR1"), pr.stderr()).toBe(0)
          expect(pr.stdout()).toContain(`bay PR1 → reattached ${branch}, no issue linked, name PR1, via pr`)
          expect(await git(prJourney.repo, "show", `refs/remotes/origin/${branch}:agent.name`)).toBe("PR1")
          const prPrimer = await git(prJourney.repo, "show", `refs/remotes/origin/${branch}:agent.prompt`)
          expect(prPrimer).toContain("Mission: continue PR PR1")
          expect(prPrimer).toContain(branch)
        } finally {
          restoreEnv("TEST_ISSUE_MISSING", previousMissing)
        }
      } finally {
        restoreEnv("PATH", previousPath)
      }
    })
  })

  it("makes manual run plus ag and automatic do converge on integrated PR state", async () => {
    return withoutRuntimeName(async () => {
      const tools = await mkdtemp(join(tmpdir(), "yrd-do-submit-tools-"))
      roots.push(tools)
      await writeFile(
        join(tools, "ag"),
        `#!/bin/sh
name="\${HAB_NAME##*/}"
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

        const automaticFixture = await repository()
        const automatic = output(automaticFixture.repo)
        expect(await yrd(automaticFixture.repo, automatic.io, "do", CLAIM), automatic.stderr()).toBe(0)
        expect(automatic.stdout()).toContain("worked s2-fixture")

        const projections = []
        for (const repo of [manualFixture.repo, automaticFixture.repo]) {
          const prs = output(repo)
          expect(await yrd(repo, prs.io, "pr", "list", "--json"), prs.stderr()).toBe(0)
          const projection = JSON.parse(prs.stdout()) as {
            prs: readonly { branch: string; issue?: string; status: string; taskStatus: string }[]
          }
          expect(projection.prs).toHaveLength(1)
          const pr = projection.prs[0]
          if (pr === undefined) throw new Error("issue journey did not create a PR")
          projections.push({
            branch: pr.branch,
            issue: pr.issue,
            status: pr.status,
            taskStatus: pr.taskStatus,
          })
          expect(await git(repo, "show", `refs/remotes/origin/${BRANCH}:result.txt`)).toBe("s2-fixture")
        }
        expect(projections[0]).toEqual({
          branch: BRANCH,
          issue: CLAIM,
          status: "integrated",
          taskStatus: "done",
        })
        expect(projections[1]).toEqual(projections[0])
      } finally {
        restoreEnv("PATH", previousPath)
        restoreEnv("YRD_TEST_BUN", previousBun)
        restoreEnv("YRD_TEST_CLI", previousCli)
      }
    })
  })

  it("keeps sh/ag as owner aliases and gives `in ag` the guest-only primer", async () => {
    return withoutRuntimeName(async () => {
      const { repo } = await repository()
      const tools = join(repo, "..", "alias-tools")
      const shell = join(tools, "fixture-shell")
      const ag = join(tools, "ag")
      const log = join(repo, "..", "aliases.log")
      await mkdir(tools, { recursive: true })
      for (const [path, label] of [
        [shell, "sh"],
        [ag, "ag"],
      ] as const) {
        await writeFile(
          path,
          `#!/bin/sh
printf '%s %s %s %s\\n' '${label}' "$HAB_NAME" "$$" "$*" >> "$YRD_TEST_ALIAS_LOG"
printf '%s' '${label}' > '${label}-ran.txt'
`,
        )
        await chmod(path, 0o755)
      }
      const previousShell = process.env.SHELL
      const previousPath = process.env.PATH
      const previousLog = process.env.YRD_TEST_ALIAS_LOG
      process.env.SHELL = shell
      process.env.PATH = `${tools}:${previousPath ?? ""}`
      process.env.YRD_TEST_ALIAS_LOG = log
      try {
        const shellOwner = output(repo)
        expect(await yrd(repo, shellOwner.io, "sh", "--bay", "shell-owner"), shellOwner.stderr()).toBe(0)
        expect(shellOwner.stdout()).toContain(
          "bay shell-owner → new task/shell-owner, no issue linked, name shell-owner",
        )

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
          ': > ready; while [ ! -f "$1" ]; do sleep 0.05; done',
          "_",
          ownerStop,
        )
        const bayPath = await activeBayPath(repo, "shared")
        await eventually(async () => access(join(bayPath, "ready")))

        const shellGuest = output(bayPath)
        expect(await yrd(repo, shellGuest.io, "in"), shellGuest.stderr()).toBe(0)
        const agGuest = output(repo)
        expect(await yrd(repo, agGuest.io, "in", "shared", "ag"), agGuest.stderr()).toBe(0)

        await writeFile(ownerStop, "")
        const [ownerExit, ownerStderr] = await Promise.all([owner.exited, new Response(owner.stderr).text()])
        expect(ownerExit, ownerStderr).toBe(0)

        const agOwner = output(repo)
        expect(await yrd(repo, agOwner.io, "ag", "--bay", "ag-owner"), agOwner.stderr()).toBe(0)
        expect(agOwner.stdout()).toContain("bay ag-owner → new task/ag-owner, no issue linked, name ag-owner")

        const lines = (await readFile(log, "utf8")).trim().split("\n")
        expect(lines[0]).toMatch(/^sh shell-owner \d+\s*$/u)
        expect(lines[1]).toMatch(/^sh shared:(\d+) \1\s*$/u)
        expect(lines[2]).toMatch(/^ag shared:(\d+) \1 /u)
        expect(lines[2]).toContain("You are a guest in Bay shared")
        expect(lines[2]).toContain("no configuration or lifecycle authority")
        expect(lines[2]).toContain("owner close captures")
        expect(lines[3]).toMatch(/^ag ag-owner \d+\s*$/u)
        expect(shellGuest.stdout()).toContain(
          `bay shared → attached task/shared, no issue linked, name ${lines[1]?.split(" ")[1]}`,
        )
        expect(agGuest.stdout()).toContain(
          `bay shared → attached task/shared, no issue linked, name ${lines[2]?.split(" ")[1]}`,
        )
      } finally {
        restoreEnv("SHELL", previousShell)
        restoreEnv("PATH", previousPath)
        restoreEnv("YRD_TEST_ALIAS_LOG", previousLog)
      }
    })
  })

  it("runs $SHELL in a fresh uniquely named Bay when run has no operands", async () => {
    return withoutRuntimeName(async () => {
      const { repo } = await repository()
      const shell = join(repo, "..", "fixture-shell")
      const shellLog = join(repo, "..", "shell-name")
      await writeFile(
        shell,
        `#!/bin/sh
printf '%s' "$HAB_NAME" > "$YRD_TEST_SHELL_LOG"
`,
      )
      await chmod(shell, 0o755)
      const previousShell = process.env.SHELL
      const previousLog = process.env.YRD_TEST_SHELL_LOG
      const previousHabName = process.env.HAB_NAME
      process.env.SHELL = shell
      process.env.YRD_TEST_SHELL_LOG = shellLog
      delete process.env.HAB_NAME
      try {
        const run = output(repo)
        expect(await yrd(repo, run.io, "bay", "run"), run.stderr()).toBe(0)
        const match = run.stdout().match(/bay (yrd-[0-9a-f]{12}) → new task\/\1, no issue linked/u)
        expect(match).not.toBeNull()
        expect(await readFile(shellLog, "utf8")).toBe(match?.[1])
        expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(`${repo}/.bays/`)
      } finally {
        restoreEnv("SHELL", previousShell)
        restoreEnv("YRD_TEST_SHELL_LOG", previousLog)
        restoreEnv("HAB_NAME", previousHabName)
      }
    })
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
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
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
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
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
    expect(await yrd(repo, bays.io, "bay", "list", "--json"), bays.stderr()).toBe(0)
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

async function configureNotify(repo: string, check = "true"): Promise<void> {
  await writeFile(
    join(repo, ".yrd.yml"),
    `base: main
batch: 1
steps: [check, merge]
check: ${JSON.stringify(check)}
merge: {}
notify:
  run/failed: [submitter]
`,
  )
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", "configure notifications")
  await git(repo, "push", "-q", "origin", "main")
}

async function fakeTribe(repo: string, succeeds = true): Promise<{ bin: string; log: string }> {
  const bin = join(repo, "..", "bin")
  const log = join(repo, "..", "tribe.log")
  const executable = join(bin, "tribe")
  await mkdir(bin, { recursive: true })
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TRIBE_TEST_LOG"
${succeeds ? "" : "exit 1"}
if [ "$1" = join ]; then
  printf '{"joined":true,"name":"%s"}\\n' "$2"
fi
`,
  )
  await chmod(executable, 0o755)
  return { bin, log }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function withoutRuntimeName<T>(work: () => Promise<T>): Promise<T> {
  const habName = process.env.HAB_NAME
  const tribeName = process.env.TRIBE_NAME
  delete process.env.HAB_NAME
  delete process.env.TRIBE_NAME
  try {
    return await work()
  } finally {
    restoreEnv("HAB_NAME", habName)
    restoreEnv("TRIBE_NAME", tribeName)
  }
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
  return Bun.spawn([process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "--repo", repo, ...args], {
    cwd: repo,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
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
