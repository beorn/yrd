/**
 * @failure `yrd bay run` loses work, returns before cleanup, or leaves a failed child unflagged.
 * @level l3
 * @consumer @yrd/cli bay run
 */
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

describe("yrd bay run", { timeout: 30_000 }, () => {
  it("resolves a sigil issue to one name and registers its derived persona in a fresh TTY", async () => {
    const { repo } = await repository()
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
      expect(await readFile(fake.log, "utf8")).toContain("join @dev/blabla1 --delivery pull --json")
      const prs = output(repo)
      expect(await yrd(repo, prs.io, "pr", "list", "--issue", "@km/test/blabla1", "--json"), prs.stderr()).toBe(0)
      expect(JSON.parse(prs.stdout())).toMatchObject({
        prs: [{ branch: "task/blabla1", revisions: [expect.objectContaining({ actor: "@dev/blabla1" })] }],
      })
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
      expect(await yrd(interactiveFixture.repo, tty.io, "bay", "run", "friendly", "--", "true"), tty.stderr()).toBe(0)
      expect(tty.stdout()).toContain("bay friendly → new task/friendly, no issue linked")
      expect(tty.stderr()).not.toContain("Tribe signal")

      const pipedFixture = await repository()
      await configureNotify(pipedFixture.repo)
      const piped = output(pipedFixture.repo)
      expect(await yrd(pipedFixture.repo, piped.io, "bay", "run", "piped", "--", "true")).not.toBe(0)
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

      const wire = output(repo)
      expect(
        await yrd(repo, wire.io, "--name", "s2-fixture", "--wire", `file:${wireLog}`, "pr", "ready", BRANCH),
        wire.stderr(),
      ).toBe(1)
      const traffic = await readFile(wireLog, "utf8")
      expect(traffic).toContain('"wire":"tribe.send"')
      expect(traffic).toContain('"to":"@dev/s2-fixture"')
      expect(traffic).toContain("Yrd rejected")
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

  it("teaches owner run when --exec has no open Bay", async () => {
    const { repo } = await repository()
    const run = output(repo)

    expect(await yrd(repo, run.io, "run", "--exec", "missing", "--", "true")).not.toBe(0)
    expect(run.stderr()).toContain("no open bay 'missing'")
    expect(run.stderr()).toContain("yrd run missing -- <command>")

    const legacy = output(repo)
    expect(await yrd(repo, legacy.io, "exec", "missing", "--", "true")).toBe(2)
    expect(legacy.stderr()).toContain("unknown command 'exec'")
  })

  it("attaches PID-addressed guests by selector or cwd without taking the owner's Bay lifecycle", async () => {
    const { repo } = await repository()
    const ownerStop = join(repo, "..", "owner.stop")
    const guestStop = join(repo, "..", "guest.stop")
    const owner = spawnYrd(
      repo,
      "run",
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
    expect(await yrd(repo, duplicate.io, "run", "shared", "--", "true")).not.toBe(0)
    expect(duplicate.stderr()).toContain("yrd run --exec shared -- <command>")

    const firstGuest = spawnYrd(
      repo,
      "run",
      "--exec",
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
        "run",
        "--exec",
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
    expect(secondGuest.stdout()).toContain(`bay ${guestTwo.split(" ")[0]} → attached task/shared, no issue linked`)

    const helper = output(repo)
    expect(
      await yrd(
        repo,
        helper.io,
        "--name",
        "@shared/helper",
        "run",
        "--exec",
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
    expect(helper.stdout()).toContain(`bay ${helperIdentity.split(" ")[0]} → attached task/shared, no issue linked`)

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
      expect(await yrd(repo, cwdGuest.io, "run", "--exec"), cwdGuest.stderr()).toBe(0)
      const cwdIdentity = await readFile(join(repo, ".bays", "B1", "cwd-guest.name"), "utf8")
      expect(cwdIdentity).toMatch(/^shared:(\d+) \1$/u)
      expect(cwdGuest.stdout()).toContain(`bay ${cwdIdentity.split(" ")[0]} → attached task/shared, no issue linked`)
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
    expect(guestStdout).toContain(`bay ${guestOne.split(" ")[0]} → attached task/shared, no issue linked`)
  })

  it("provides sh and ag owner aliases that also compose with --exec", async () => {
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
printf '%s %s %s\\n' '${label}' "$HAB_NAME" "$$" >> "$YRD_TEST_ALIAS_LOG"
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
      expect(await yrd(repo, shellOwner.io, "sh", "shell-owner"), shellOwner.stderr()).toBe(0)
      expect(shellOwner.stdout()).toContain("bay shell-owner → new task/shell-owner, no issue linked")

      const agOwner = output(repo)
      expect(await yrd(repo, agOwner.io, "ag", "ag-owner"), agOwner.stderr()).toBe(0)
      expect(agOwner.stdout()).toContain("bay ag-owner → new task/ag-owner, no issue linked")

      const ownerStop = join(repo, "..", "alias-owner.stop")
      const owner = spawnYrd(
        repo,
        "run",
        "shared",
        "--",
        "sh",
        "-c",
        ': > ready; while [ ! -f "$1" ]; do sleep 0.05; done',
        "_",
        ownerStop,
      )
      await eventually(async () => access(join(repo, ".bays", "B3", "ready")))

      const shellGuest = output(join(repo, ".bays", "B3"))
      expect(await yrd(repo, shellGuest.io, "sh", "--exec"), shellGuest.stderr()).toBe(0)
      const agGuest = output(repo)
      expect(await yrd(repo, agGuest.io, "ag", "--exec", "shared"), agGuest.stderr()).toBe(0)

      await writeFile(ownerStop, "")
      const [ownerExit, ownerStderr] = await Promise.all([owner.exited, new Response(owner.stderr).text()])
      expect(ownerExit, ownerStderr).toBe(0)

      const lines = (await readFile(log, "utf8")).trim().split("\n")
      expect(lines[0]).toMatch(/^sh shell-owner \d+$/u)
      expect(lines[1]).toMatch(/^ag ag-owner \d+$/u)
      expect(lines[2]).toMatch(/^sh shared:(\d+) \1$/u)
      expect(lines[3]).toMatch(/^ag shared:(\d+) \1$/u)
      expect(shellGuest.stdout()).toContain(`bay ${lines[2]?.split(" ")[1]} → attached task/shared`)
      expect(agGuest.stdout()).toContain(`bay ${lines[3]?.split(" ")[1]} → attached task/shared`)
    } finally {
      restoreEnv("SHELL", previousShell)
      restoreEnv("PATH", previousPath)
      restoreEnv("YRD_TEST_ALIAS_LOG", previousLog)
    }
  })

  it("runs $SHELL in a fresh uniquely named Bay when run has no operands", async () => {
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
      expect(await yrd(repo, run.io, "run"), run.stderr()).toBe(0)
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
      prs: [{ branch, issue: CLAIM, status: "pushed", revision: 2 }],
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
          orphan: expect.objectContaining({ reason: expect.stringContaining("pre-child setup failed") }),
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

async function configureNotify(repo: string, check = "true"): Promise<void> {
  await writeFile(
    join(repo, ".yrd.yml"),
    `base: main
batch: 1
steps: [check, merge]
check: ${JSON.stringify(check)}
merge: {}
notify:
  pr/rejected: [submitter]
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

function spawnYrd(repo: string, ...args: string[]) {
  return Bun.spawn([process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "--repo", repo, ...args], {
    cwd: repo,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
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
