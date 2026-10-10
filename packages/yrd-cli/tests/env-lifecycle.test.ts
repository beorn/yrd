/**
 * @reach fs-walk <fixture-only: temporary repositories, bare remotes and retained worktrees>
 * @failure A fresh environment ignored its commit's setup or ran it before
 *          dependencies existed; closing an unsafe environment discarded work.
 * @level   l2 (real bare remote and real retained Git worktree)
 * @consumer every seat opening a fresh environment through `yrd env open`
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as removely from "removely"
import { createEventStore, previewCloneKey, previewSubjectPrefix } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { closeEnvironment } from "../src/env-commands.ts"
import { admitEnvironmentClose, environmentCwdHolder } from "../src/env-close-holders.ts"
import {
  closeRequestFile,
  closeRequestsDirectory,
  listCloseRequests,
  readCloseRequest,
  requesterOf,
} from "../src/env-close-requests.ts"
import { workdirOf } from "../src/workdir.ts"
import { environmentIssues, environmentProvenance } from "../src/env-cleanup-provenance.ts"
import type { YrdCliIO } from "../src/types.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

// A spy cannot replace a binding of an installed ESM package's namespace (standalone CI), so the seam is a module mock.
vi.mock("removely", async (importOriginal) => {
  const actual = await importOriginal<typeof import("removely")>()
  return { ...actual, inspectProcessCensus: vi.fn(actual.inspectProcessCensus) }
})

const roots: string[] = []
const realProcessCensus = (await vi.importActual<typeof import("removely")>("removely")).inspectProcessCensus
const processCensus = vi.mocked(removely.inspectProcessCensus)
// Non-holder lifecycle rows inject this external boundary; host process churn is not their subject.
beforeEach(async () => {
  if (process.platform !== "linux") return
  const observed = await realProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
  processCensus.mockResolvedValue({
    ...observed,
    rows: [],
    coverage: { ...observed.coverage, complete: true, unreadable: [] },
  })
})
afterEach(() => processCensus.mockReset())

/** Scope real kernel observations to the native fixture; missing expected PIDs fail loudly. */
function fixtureCensus(census: removely.ProcessCensus<"same-uid">, pids: readonly number[]) {
  for (const pid of pids) {
    if (!census.rows.some((row) => row.pid === pid)) throw new Error(`fixture process ${pid} missing from real census`)
  }
  const unreadable = (census.coverage.unreadable ?? []).filter((row) => pids.includes(row.pid))
  return {
    ...census,
    rows: census.rows.filter((row) => pids.includes(row.pid)),
    coverage: { ...census.coverage, unreadable, complete: unreadable.length === 0 },
  }
}
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      color: false,
      cwd,
      stderr: (text) => void (stderr += text),
      stdout: (text) => void (stdout += text),
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

async function openEnvironment(cwd: string, commit: string): Promise<Readonly<{ path: string; head: string }>> {
  const run = capture(cwd)
  expect(await runYrdProcess(["bun", "yrd", "env", "open", commit, "--json"], run.io), run.stderr()).toBe(0)
  expect(JSON.parse(run.stdout())).toMatchObject({ base: commit, head: commit })
  expect(run.stderr()).not.toMatch(/reus/iu)
  return JSON.parse(run.stdout()) as { path: string; head: string }
}

type World = Readonly<{ git: ReturnType<typeof gitIn>; work: string }>

it("cleanup unions every creating OID and canonical branch binding without inherited Refs", async () => {
  const w = await world(":")
  await w.git(["commit", "--quiet", "--allow-empty", "-m", "inherited target binding", "-m", "Refs: 999"])
  const path = join(dirname(w.work), "retained")
  const branch = "task/@i/10-yrd/27723-scope"
  await w.git(["worktree", "add", "--quiet", "-b", branch, path, "HEAD"])
  const tree = gitIn(path)
  for (const issue of ["111", "112"]) {
    await tree(["commit", "--quiet", "--allow-empty", "-m", `own binding ${issue}`, "-m", `Refs: ${issue}`])
  }
  const issues = await environmentIssues(
    path,
    tree,
    "retained",
    branch,
    w.git,
    "main",
    createEventStore(w.work, "origin", w.git.selection),
    async () => undefined,
    async (raw) => raw,
  )
  expect(new Set(issues.issues)).toEqual(new Set(["111", "112", "@i/10-yrd/27723-scope"]))
})

it("cleanup provenance excludes inherited history and refuses incomplete or unknown HEAD evidence", async () => {
  const w = await world(":")
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  const log = (await w.git(["rev-parse", "--git-path", "logs/HEAD"])).trim()
  const path = join(w.work, log)
  const entry = (old: string, message: string) => `${old} ${head} yrd <env-open@yrd.test> 1 +0000\t${message}\n`
  const creation = entry("0".repeat(40), "")
  writeFileSync(path, creation + entry(head, "checkout: moving from task/27723 to main"))
  expect(await environmentProvenance(w.work, w.git, "main")).toEqual({
    commits: [],
    branches: ["main", "task/27723"],
  })
  writeFileSync(path, creation + entry(head, "commit (amend): own binding") + entry(head, "reset: moving to HEAD"))
  expect((await environmentProvenance(w.work, w.git)).commits).toEqual([head])
  // A message-less NON-FIRST entry is CREATING: it is `env open`'s binding
  // update-ref, which git mirrors into HEAD's reflog with no -m (27723
  // addendum). Its trailers are read from that commit, never its ancestry.
  writeFileSync(path, creation + entry(head, ""))
  expect((await environmentProvenance(w.work, w.git)).commits).toEqual([head])
  // `git branch -m` writes this message as a delete/create pair. It creates no
  // commit, and BOTH names join the branch set so a renamed branch still finds
  // the change chain stored under its old name (ruling 27723 post-adoption).
  writeFileSync(path, creation + entry(head, "Branch: renamed refs/heads/task/a to refs/heads/task/b"))
  expect(await environmentProvenance(w.work, w.git)).toEqual({ commits: [], branches: ["task/a", "task/b"] })
  // Newer Yrd names that same binding move with -m; the prefix stays CREATING.
  writeFileSync(path, creation + entry(head, "yrd env open: bind 27723"))
  expect((await environmentProvenance(w.work, w.git)).commits).toEqual([head])
  // `rebase: fast-forward` is a non-creating move, like merge/pull's.
  for (const message of ["rebase: fast-forward", "merge: Fast-forward", "pull: Fast-forward"]) {
    writeFileSync(path, creation + entry(head, message))
    expect((await environmentProvenance(w.work, w.git)).commits, message).toEqual([])
  }
  for (const message of [
    "commit: own",
    "commit (merge): own",
    "commit (initial): own",
    "rebase (pick): own",
    "rebase -i (reword): own",
    "pull --rebase (edit): own",
    "rebase (squash): own",
    "rebase (fixup): own",
    "rebase (continue): own",
    "cherry-pick: own",
    "revert: own",
    "am: own",
    "merge topic: Merge made by the 'ort' strategy.",
    "pull: Merge made by the 'ort' strategy.",
  ]) {
    writeFileSync(path, creation + entry(head, message))
    expect((await environmentProvenance(w.work, w.git)).commits, message).toEqual([head])
  }
  writeFileSync(path, entry(head, "commit: truncated beginning"))
  await expect(environmentProvenance(w.work, w.git)).rejects.toThrow(/creation evidence/u)
  writeFileSync(path, creation + entry(head, "future-command: unknown"))
  await expect(environmentProvenance(w.work, w.git)).rejects.toThrow(/future-command/u)
})

/** One denied same-UID cwd read exactly as removely records it: identity evidence, no readable row. */
function unreadableDenial(
  argv: readonly string[] = ["bun", "private-argument-must-not-be-reported"],
): removely.UnreadableProcess {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this case needs a real unix uid")
  return {
    pid: 4242,
    uid,
    comm: "bun",
    denied: ["process"],
    issues: [{ source: "process", resource: "cwd", reason: "denied", code: "EACCES" }],
    argv: [...argv],
  }
}

/** The census this caller cannot complete: one uncleared denial, no readable row. */
async function incompleteCensus(): Promise<removely.ProcessCensus<"same-uid">> {
  const observed = await removely.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
  return { rows: [], coverage: { ...observed.coverage, complete: false, unreadable: [unreadableDenial()] } }
}

/** A census the caller read completely, carrying one readable holder. */
async function holderCensus(pid: number, cwd: string): Promise<removely.ProcessCensus<"same-uid">> {
  const observed = await removely.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
  return {
    rows: [{ pid, sources: { cwd: { availability: "readable", value: cwd, issues: [] } }, issues: [] }],
    coverage: { ...observed.coverage, complete: true, unreadable: [] },
  }
}

async function command(
  cwd: string,
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<Readonly<{ exit: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn([...argv], { cwd, env, stderr: "pipe", stdin: "ignore", stdout: "pipe" })
  const [exit, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  return { exit, stderr, stdout }
}

async function world(setup: string, teardown?: string): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-env-open-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "env-open@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(
    join(work, ".yrd.yml"),
    `setup: ${JSON.stringify(setup)}\n${teardown === undefined ? "" : `teardown: ${JSON.stringify(teardown)}\n`}`,
  )
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "declare environment setup"])
  await git(["push", "--quiet", "origin", "main"])
  return { git, work }
}

async function addMaterializedDependency(w: World): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-env-submodule-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "env-open@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "READY"), "materialized\n")
  await git(["add", "READY"])
  await git(["commit", "--quiet", "-m", "seed materialized dependency"])
  await git(["push", "--quiet", "origin", "main"])
  await w.git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", remote, "vendor/dependency"])
  await w.git(["commit", "--quiet", "-m", "add materialized dependency"])
  await w.git(["push", "--quiet", "origin", "main"])
}

describe("yrd env open prepares the retained environment", () => {
  it("resolves a configured relative workdir against the repository, not the caller's subdirectory", async () => {
    const w = await world(":")
    await w.git(["config", "yrd.workdir", "relative-state"])
    const nested = join(w.work, "nested")
    mkdirSync(nested)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
    const run = await command(nested, [process.execPath, cli, "env", "open", selected, "--json"])
    expect(run, run.stderr).toMatchObject({ exit: 0 })
    const { path } = JSON.parse(run.stdout) as { path: string }
    // The queue root sits under the configured workdir since 25716 row 9; the root is what resolves (25848).
    expect(path.startsWith(join(w.work, "relative-state") + "/")).toBe(true)
    expect(path).toContain(`${sep}environments${sep}`)
    const listed = await command(nested, [process.execPath, cli, "env", "list", "--json"])
    expect(listed, listed.stderr).toMatchObject({ exit: 0 })
    expect(JSON.parse(listed.stdout)).toMatchObject({ environments: [{ path, head: selected }] })
  })

  // The library materializer cannot prove this process boundary: a plain
  // commit needs no tool, and a required CLI must return a trustworthy result.
  it.each(["plain", "missing", "malformed", "partial", "mismatched"])(
    "honours the git-super boundary when %s",
    async (mode) => {
      const w = await world(":")
      const plain = (await w.git(["rev-parse", "HEAD"])).trim()
      await addMaterializedDependency(w)
      const selected = mode === "plain" ? plain : (await w.git(["rev-parse", "HEAD"])).trim()
      const bin = join(w.work, "fixture-bin")
      mkdirSync(bin)
      const git = Bun.which("git")
      const sh = Bun.which("sh")
      expect(git).not.toBeNull()
      expect(sh).not.toBeNull()
      symlinkSync(git!, join(bin, "git"))
      symlinkSync(sh!, join(bin, "sh"))
      if (mode === "malformed") {
        writeFileSync(join(bin, "git-super"), "#!/bin/sh\nprintf 'not-json\\n'\n")
        chmodSync(join(bin, "git-super"), 0o755)
      } else if (mode === "partial" || mode === "mismatched") {
        // Valid JSON and exit zero are insufficient: the external report must
        // attest this exact path/commit and complete, not partial, success.
        writeFileSync(
          join(bin, "git-super"),
          `#!${process.execPath}\nconsole.log(JSON.stringify({
        state: "updated", partial: ${mode === "partial"},
        path: process.argv[5], requested: process.argv[6],
        commit: ${mode === "mismatched" ? '"0".repeat(40)' : "process.argv[6]"},
        gitmodules: true,
        gitlinks: {considered: 1, borrowed: 1, fetched: 0, absent: 0},
        repositories: [{repository: process.cwd(), state: "updated", refs: []}]
      }))\n`,
        )
        chmodSync(join(bin, "git-super"), 0o755)
      }
      const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
      const run = await command(w.work, [process.execPath, cli, "env", "open", selected, "--json"], {
        ...process.env,
        PATH: bin,
        YRD_GIT_SUPER_BIN: join(bin, "git-super"),
      })
      if (mode === "plain") {
        expect(run, run.stderr).toMatchObject({ exit: 0 })
        const { path } = JSON.parse(run.stdout) as { path: string }
        expect(existsSync(join(path, ".gitmodules"))).toBe(false)
        expect((await gitIn(path)(["rev-parse", "HEAD"])).trim()).toBe(plain)
      } else {
        expect(run, run.stderr).toMatchObject({ exit: 2, stdout: "" })
        expect(run.stderr).toContain(mode === "missing" ? "requires git-super" : "malformed git-super")
        const listed = capture(w.work)
        expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
        expect(JSON.parse(listed.stdout())).toEqual({ environments: [] })
      }
    },
  )

  it.each(["branch", "unknown", "blob"])("refuses a %s before creating an environment", async (kind) => {
    const w = await world(":")
    const operand =
      kind === "branch"
        ? "main"
        : kind === "unknown"
          ? "0".repeat(40)
          : (await w.git(["rev-parse", "HEAD:.yrd.yml"])).trim()
    const run = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "open", operand, "--json"], run.io)).toBe(2)
    expect(run.stderr()).toContain(operand)
    expect(run.stdout()).toBe("")
    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    expect(JSON.parse(listed.stdout())).toEqual({ environments: [] })
  })

  it("opens the exact commit detached and runs that commit's setup", async () => {
    const w = await world("printf 'selected commit\\n' > selected-setup.txt")
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    writeFileSync(join(w.work, ".yrd.yml"), "setup: printf 'newer commit\\n' > selected-setup.txt\n")
    await w.git(["add", ".yrd.yml"])
    await w.git(["commit", "--quiet", "-m", "change setup after selected commit"])
    await w.git(["push", "--quiet", "origin", "main"])
    const current = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    expect((await gitIn(path)(["rev-parse", "HEAD"])).trim()).toBe(selected)
    expect((await gitIn(path)(["branch", "--show-current"])).trim()).toBe("")
    expect(readFileSync(join(path, "selected-setup.txt"), "utf8")).toBe("selected commit\n")
    expect((await w.git(["rev-parse", "HEAD"])).trim()).toBe(current)
  })

  it("runs the target's declared setup after materialization", async () => {
    const w = await world(
      "bun --version >/dev/null && test -f vendor/dependency/READY && printf '%s\\n' \"$YRD_REPO\" > setup-ready.txt",
    )
    await addMaterializedDependency(w)
    const run = capture(w.work)

    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await runYrdProcess(["bun", "yrd", "env", "open", selected], run.io), run.stderr()).toBe(0)

    const bay = run.stdout().trim()
    expect(run.stderr()).toContain("detached")
    expect(run.stderr()).toContain("cut from")
    expect(run.stderr()).not.toMatch(/reus/iu)
    expect(readFileSync(join(bay, "setup-ready.txt"), "utf8")).toBe(`${bay}\n`)
    expect((await gitIn(bay)(["branch", "--show-current"])).trim()).toBe("")
  })

  it("opens the same exact commit twice without attaching or moving its branch", async () => {
    const w = await world('printf \'%s\\n%s\\n\' "$YRD_BASE_SHA" "$YRD_CANDIDATE_SHA" > setup-tree.txt')
    await w.git(["checkout", "--quiet", "-b", "task/reopened"])
    writeFileSync(join(w.work, "branch.txt"), "branch change\n")
    await w.git(["add", "branch.txt"])
    await w.git(["commit", "--quiet", "-m", "change on retained branch"])
    const candidate = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    writeFileSync(join(w.work, "main.txt"), "target change\n")
    await w.git(["add", "main.txt"])
    await w.git(["commit", "--quiet", "-m", "advance target"])
    await w.git(["push", "--quiet", "origin", "main"])
    const { path: bay } = await openEnvironment(w.work, candidate)
    expect(readFileSync(join(bay, "setup-tree.txt"), "utf8")).toBe(`${candidate}\n${candidate}\n`)

    const { path: reopened } = await openEnvironment(w.work, candidate)
    expect(reopened).not.toBe(bay)
    expect(readFileSync(join(reopened, "setup-tree.txt"), "utf8")).toBe(`${candidate}\n${candidate}\n`)
    expect((await w.git(["rev-parse", "refs/heads/task/reopened"])).trim()).toBe(candidate)
  })

  it("keeps a failed environment and reports its command and output", async () => {
    const command = "printf 'setup exploded\\n' >&2; exit 23"
    const w = await world(command)
    const run = capture(w.work)

    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await runYrdProcess(["bun", "yrd", "env", "open", selected], run.io)).toBe(2)

    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io), listed.stderr()).toBe(0)
    const rows = JSON.parse(listed.stdout()) as { environments: { path: string }[] }
    expect(rows.environments).toHaveLength(1)
    const bay = rows.environments[0]!.path
    expect(run.stdout()).toBe("")
    expect(existsSync(bay)).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain"])).toContain(bay)
    expect((await gitIn(bay)(["branch", "--show-current"])).trim()).toBe("")
    expect(run.stderr()).toContain(command)
    expect(run.stderr()).toContain("exit 23")
    expect(run.stderr()).toContain("exit 23 is not a verdict")
    expect(run.stderr()).toContain("setup exploded")
    expect(run.stderr()).toContain(bay)
  })

  /**
   * @failure 26906: `yrd env open`'s failed-setup report dropped the frozen-lockfile diagnosis,
   *          and the retained bay's lockfile was left rewritten by it, so the caller could not
   *          tell its own starting bytes from the diagnosis's dependency change.
   * @level l2 (real `bun install --frozen-lockfile` refusal through `yrd env open`)
   * @consumer every seat whose environment setup fails a frozen install
   */
  it("keeps a failed frozen install's lockfile bytes and names the diagnosis (26906)", async () => {
    const w = await world("bun install --frozen-lockfile")
    const manifest = (version: string): string =>
      `${JSON.stringify(
        { dependencies: { "fixture-dep": `file:./vendor-${version}` }, name: "fixture-root", version: "0.0.0" },
        null,
        2,
      )}\n`
    await w.git(["checkout", "--quiet", "main"])
    for (const version of ["1.0.0", "2.0.0"]) {
      mkdirSync(join(w.work, `vendor-${version}`), { recursive: true })
      writeFileSync(
        join(w.work, `vendor-${version}`, "package.json"),
        `${JSON.stringify({ name: "fixture-dep", version }, null, 2)}\n`,
      )
    }
    writeFileSync(join(w.work, "package.json"), manifest("1.0.0"))
    // The one moment a lockfile is GENERATED rather than diffed: a real, offline `bun install`
    // against the BEFORE manifest, in the fixture's own work tree.
    const seeded = await command(w.work, ["bun", "install"])
    expect(seeded, seeded.stderr).toMatchObject({ exit: 0 })
    const locked = readFileSync(join(w.work, "bun.lock"), "utf8")
    // The candidate raises the dependency in package.json ALONE, never touching the lockfile:
    // 24140's own repro for a `bun install --frozen-lockfile` that refuses without naming what moved.
    writeFileSync(join(w.work, "package.json"), manifest("2.0.0"))
    await w.git(["add", "package.json", "bun.lock", "vendor-1.0.0", "vendor-2.0.0"])
    await w.git(["commit", "--quiet", "-m", "raise the dependency without the lockfile"])
    await w.git(["push", "--quiet", "origin", "main"])
    const run = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "frozen"], run.io), run.stderr()).toBe(2)

    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io), listed.stderr()).toBe(0)
    const rows = JSON.parse(listed.stdout()) as { environments: { path: string }[] }
    expect(rows.environments).toHaveLength(1)
    const bay = rows.environments[0]!.path
    expect(existsSync(bay), run.stderr()).toBe(true)
    // The failure text names the diagnosis and what moved.
    expect(run.stderr()).toContain("frozen-lockfile diagnosis")
    expect(run.stderr()).toContain("fixture-dep")
    // And the retained bay's tracked lockfile is byte-identical to the candidate's.
    expect(readFileSync(join(bay, "bun.lock"), "utf8")).toBe(locked)
  })
})

describe("yrd env close preserves anything it cannot safely remove", () => {
  /**
   * @failure 28120: symlinked environment paths missed kernel-resolved cwd holders.
   * @level l1 (real filesystem symlink at the shared containment boundary)
   * @consumer the queue's early holder filter and authoritative close admission
   */
  it("finds a holder through a symlinked environment path (28120)", () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-holder-symlink-"))
    roots.push(root)
    const target = join(root, "physical")
    const alias = join(root, "alias")
    mkdirSync(target)
    symlinkSync(target, alias, "dir")
    const holder = { pid: 4242, cwd: realpathSync(target) }
    expect(environmentCwdHolder(alias, { rows: [holder], unreadable: [], complete: true, mechanism: "proc" })).toEqual(
      holder,
    )
  })

  /**
   * @failure 28120: direct close removed an unrelated process's cwd and ran teardown first.
   * @level l2 (real CLI and native cwd holder in a temporary retained worktree)
   * @consumer callers closing an environment still used by another process
   */
  it.runIf(process.platform === "linux").each(["CLI sibling", "caller child"])(
    "refuses a live cwd holder (%s) before teardown (28120)",
    async (invocation) => {
      const w = await world(":", "printf touched > ../holder-teardown-ran.txt")
      const selected = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path } = await openEnvironment(w.work, selected)
      const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
      const heldPath = invocation === "caller child" ? join(path, "nested") : path
      if (heldPath !== path) mkdirSync(heldPath)
      const holder = Bun.spawn([process.execPath, "-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
        cwd: heldPath,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      })
      try {
        const ready = holder.stdout.getReader()
        expect(new TextDecoder().decode((await ready.read()).value)).toContain("ready")
        ready.releaseLock()
        if (invocation === "caller child") {
          processCensus.mockImplementation(async () =>
            fixtureCensus(await realProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 }), [
              process.pid,
              holder.pid,
            ]),
          )
        }

        const local = capture(path)
        const closed =
          invocation === "CLI sibling"
            ? await command(w.work, [process.execPath, cli, "env", "close", path, "--json"], process.env)
            : {
                exit: await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], local.io),
                stderr: local.stderr(),
                stdout: local.stdout(),
              }

        expect(closed.exit, closed.stderr).toBe(2)
        expect(closed.stderr).toContain(String(holder.pid))
        expect(closed.stderr).toContain("same-UID holders inspected; other-UID holders are not inspectable")
        expect(closed.stderr).toContain("exempt PIDs:")
        expect(closed.stderr).toContain("a process can enter after the check")
        expect(existsSync(path)).toBe(true)
        expect(await w.git(["worktree", "list", "--porcelain"])).toContain(path)
        expect(existsSync(join(dirname(path), "holder-teardown-ran.txt"))).toBe(false)
      } finally {
        holder.kill()
        await holder.exited
      }
    },
  )

  /**
   * @failure 28120: teardown could start a holder after the first safe admission.
   * @level l2 (real teardown starts a native process in the temporary worktree)
   * @consumer close callers whose declared teardown leaves background work
   */
  it.runIf(process.platform === "linux")(
    "keeps a holder started by teardown at the fresh removal check (28120)",
    async () => {
      const program =
        'import { writeFileSync } from "node:fs"; writeFileSync("../teardown-holder.pid", String(process.pid)); setInterval(() => {}, 1000)'
      const launcher = `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(program)}],
        { cwd: process.cwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      child.unref();
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await Bun.file("../teardown-holder.pid").exists()) process.exit(0);
        await Bun.sleep(10);
      }
      child.kill(); await child.exited; throw new Error("teardown holder did not become ready");`
      const w = await world(":", `'${process.execPath.replaceAll("'", "'\\''")}' -e '${launcher}'`)
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      const marker = join(dirname(path), "teardown-holder.pid")
      processCensus.mockImplementation(async () =>
        fixtureCensus(await realProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 }), [
          process.pid,
          ...(existsSync(marker) ? [Number(readFileSync(marker, "utf8"))] : []),
        ]),
      )
      try {
        const closed = capture(w.work)
        expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(2)
        const pid = Number(readFileSync(marker, "utf8"))
        expect(closed.stderr()).toContain(`process ${pid} has CWD`)
        expect(existsSync(path)).toBe(true)
        expect(await w.git(["worktree", "list", "--porcelain"])).toContain(path)
      } finally {
        if (existsSync(marker)) {
          const pid = Number(readFileSync(marker, "utf8"))
          process.kill(pid, "SIGTERM")
          await vi.waitFor(() => expect(existsSync(`/proc/${pid}/cwd`)).toBe(false))
        }
      }
    },
  )

  /**
   * @failure 28120: absent ancestry evidence was treated as permission to close from inside.
   * @level l1 (injected unreadable ancestry at the existing process-census boundary)
   * @consumer own-directory callers on platforms without readable ancestry
   */
  it.runIf(process.platform === "linux")(
    "names the outside-environment cure when invocation ancestry is unreadable (28120)",
    async () => {
      const w = await world(":", "printf touched > ../ancestry-teardown-ran.txt")
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      const observed = await removely.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
      const census = processCensus.mockResolvedValue({
        rows: [
          { pid: process.pid, sources: { cwd: { availability: "readable", value: path, issues: [] } }, issues: [] },
        ],
        coverage: { ...observed.coverage, complete: true, unreadable: [] },
      })
      try {
        const closed = capture(path)
        expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(2)
        expect(closed.stderr()).toContain("ancestry unavailable")
        expect(closed.stderr()).toContain("run the close from outside the environment")
        expect(existsSync(path)).toBe(true)
        expect(existsSync(join(dirname(path), "ancestry-teardown-ran.txt"))).toBe(false)
      } finally {
        census.mockRestore()
      }
    },
  )

  /**
   * @failure 25949: successful removal was reported as failure when the caller's cwd was the removed environment.
   * @level l2 (real CLI subprocess and materialized submodule)
   * @consumer a caller closing the environment from its own shell
   */
  it.runIf(process.platform === "linux")(
    "closes from inside the removed environment and reports success (25949)",
    async () => {
      const w = await world(":")
      await addMaterializedDependency(w)
      const selected = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path } = await openEnvironment(w.work, selected)
      const cli = join(dirname(fileURLToPath(import.meta.url)), "../../../bin/yrd.ts")
      // A real shell and child run the real lifecycle with CTO's internal dependency;
      // only their kernel process rows belong to this fixture's census population.
      const nativeEntry = join(dirname(w.work), "native-close.ts")
      writeFileSync(
        nativeEntry,
        `
        import { closeEnvironment } from ${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), "../src/env-commands.ts"))};
        import { inspectProcessCensus } from ${JSON.stringify(Bun.resolveSync("removely", dirname(fileURLToPath(import.meta.url))))};
        const census = async () => {
          const observed = await inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2000 });
          const pids = [process.pid, process.ppid];
          for (const pid of pids) if (!observed.rows.some(row => row.pid === pid)) throw new Error("fixture PID missing: " + pid);
          const unreadable = (observed.coverage.unreadable ?? []).filter(row => pids.includes(row.pid));
          return { ...observed, rows: observed.rows.filter(row => pids.includes(row.pid)), coverage: { ...observed.coverage, unreadable, complete: unreadable.length === 0 } };
        };
        try {
          process.exitCode = await closeEnvironment(process.argv[2], { json: true }, {
            cwd: process.cwd(), color: false, stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
          }, census);
        } catch (error) { console.error(error.message); process.exitCode = 2; }
      `,
      )
      const closed = await command(
        path,
        [
          "sh",
          "-c",
          'printf "shell-pid=%s\\n" "$$" >&2; "$1" "$2" "$3"; result=$?; exit "$result"',
          "yrd-close-shell",
          process.execPath,
          nativeEntry,
          path,
        ],
        process.env,
      )

      expect(closed.exit, closed.stderr).toBe(0)
      const shellPid = closed.stderr.match(/^shell-pid=(\d+)$/mu)?.[1]
      expect(shellPid).toBeTypeOf("string")
      expect(closed.stderr).toMatch(new RegExp(`exempt PIDs: [^\\n]*\\b${shellPid}\\b`, "u"))
      expect(JSON.parse(closed.stdout)).toEqual({ closed: path })
      expect(existsSync(path)).toBe(false)
      expect(await w.git(["worktree", "list", "--porcelain"])).not.toContain(path)
    },
  )

  // #27156: existence admission precedes teardown and every child-content read.
  it.each([false, true])("private custody gates close before teardown: initialized=%s", async (initialized) => {
    const w = await world(":", "printf touched > ../private-teardown-ran.txt")
    await addMaterializedDependency(w)
    await w.git(["config", "-f", ".gitmodules", "submodule.vendor/dependency.private", "true"])
    await w.git(["add", ".gitmodules"])
    await w.git(["commit", "--quiet", "-m", "declare private dependency"])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const gitfile = join(path, "vendor/dependency/.git")
    expect(existsSync(gitfile)).toBe(false)
    if (initialized) {
      // A fixture-only historical checkout. Read only its gitfile's existence.
      await w.git(["-C", path, "submodule", "update", "--init", "vendor/dependency"])
      expect(existsSync(gitfile)).toBe(true)
    }
    const closed = capture(w.work)
    const exit = await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io)
    const teardown = join(dirname(path), "private-teardown-ran.txt")
    if (initialized) {
      expect(exit, closed.stderr()).toBe(2)
      expect(closed.stderr()).toContain("vendor/dependency")
      expect(closed.stderr()).toContain("custody unproven until 27058's merge exclusion; operator decision pending")
      expect(existsSync(path)).toBe(true)
      expect(existsSync(gitfile)).toBe(true)
      expect(existsSync(teardown)).toBe(false)
    } else {
      expect(exit, closed.stderr()).toBe(0)
      expect(existsSync(path)).toBe(false)
      expect(existsSync(teardown)).toBe(true)
    }
  })

  it("opens, lists and closes a workdir configured through a symlink", async () => {
    const w = await world(":")
    const actual = join(w.work, "state-actual")
    const alias = join(w.work, "state-alias")
    mkdirSync(actual)
    symlinkSync(actual, alias)
    await w.git(["config", "yrd.workdir", alias])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const physical = realpathSync(path)
    const listed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    expect(JSON.parse(listed.stdout())).toMatchObject({ environments: [{ path: physical, head: selected }] })
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: physical })
    expect(existsSync(path)).toBe(false)
  })

  it("closes its environment when the preview sweep fails after the subject's roots are retired (27510)", async () => {
    const w = await world(":")
    await addMaterializedDependency(w)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    await gitIn(path)(["switch", "--quiet", "-c", "task/closing"])
    // A custody root recording a component commit its store does not hold: the sweep's closure read fails.
    const missing = "1".repeat(40)
    const vendor = (await w.git(["ls-tree", `${selected}:vendor`])).replace(
      /^160000 commit \S+\tdependency$/mu,
      `160000 commit ${missing}\tdependency`,
    )
    expect(vendor).toContain(missing)
    const vendorTree = (await w.git(["mktree", "--missing"], vendor)).trim()
    const top = (await w.git(["ls-tree", selected])).replace(
      /^040000 tree \S+\tvendor$/mu,
      `040000 tree ${vendorTree}\tvendor`,
    )
    expect(top).toContain(vendorTree)
    const tree = (await w.git(["mktree"], top)).trim()
    const recorded = (
      await w.git(["commit-tree", tree, "-p", selected, "-m", "custody root with a missing component"])
    ).trim()
    const root = `${previewSubjectPrefix(previewCloneKey(join(w.work, ".git")), "task/closing")}${recorded}`
    await w.git(["update-ref", "--create-reflog", root, recorded])

    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)

    expect(existsSync(path)).toBe(false)
    expect((await w.git(["for-each-ref", "refs/yrd/preview/"])).trim()).toBe("")
    expect(closed.stderr()).toContain("yrd: env close left a preview anchor")
    expect(closed.stderr()).toContain("the orphan sweep after retiring task/closing failed")
  })

  it("lists and closes newline-containing paths from a nested caller using the same Git registry", async () => {
    const w = await world(":")
    await w.git(["config", "yrd.workdir", join(w.work, "state\nwith spaces")])
    const nested = join(w.work, "nested")
    mkdirSync(nested)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(nested, selected)
    const listed = capture(nested)
    expect(await runYrdProcess(["bun", "yrd", "env", "list", "--json"], listed.io)).toBe(0)
    expect(JSON.parse(listed.stdout())).toMatchObject({ environments: [{ path, head: selected }] })
    const closed = capture(nested)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", relative(nested, path), "--json"], closed.io),
      closed.stderr(),
    ).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: path })
    expect(existsSync(path)).toBe(false)
  })

  it("refuses dirty submodules even when repository configuration normally hides them", async () => {
    const w = await world(":", "printf touched > ../teardown-ran.txt")
    await addMaterializedDependency(w)
    await w.git(["config", "submodule.vendor/dependency.ignore", "all"])
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const userWork = join(path, "vendor/dependency/READY")
    writeFileSync(userWork, "user edits\n")
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io)).toBe(2)
    expect(closed.stderr()).toContain("dirty")
    expect(readFileSync(userWork, "utf8")).toBe("user edits\n")
    expect(existsSync(join(dirname(path), "teardown-ran.txt"))).toBe(false)
  })

  it.each([false, true])("closes a registered clean environment with declared teardown=%s", async (teardown) => {
    const w = await world(":", teardown ? 'printf "%s\\n" "$YRD_CANDIDATE_SHA" > ../closed.txt' : undefined)
    if (teardown) await addMaterializedDependency(w)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    // Close reads the retained commit, never the caller's edited declaration.
    writeFileSync(join(w.work, ".yrd.yml"), "teardown: exit 23\n")
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: path })
    expect(existsSync(path)).toBe(false)
    expect(await w.git(["worktree", "list", "--porcelain", "-z"])).not.toContain(path)
    if (teardown) {
      expect(readFileSync(join(dirname(path), "closed.txt"), "utf8")).toBe(`${selected}\n`)
      expect(closed.stderr()).toContain("retained environment removal proof")
      const proofLine = closed
        .stderr()
        .split("\n")
        .find((line) => line.startsWith("retained environment removal proof "))
      expect(proofLine).toBeTypeOf("string")
      const proof = proofLine!.slice("retained environment removal proof ".length)
      expect(readFileSync(proof, "utf8")).toContain("vendor/dependency/config")
    }
  })

  /**
   * @failure `yrd env close` read the retained environment's own `.yrd.yml` through the strict
   *          parser, so an environment opened through a newer Yrd — the documented cure for
   *          `env open` — refused to close from a week-old slot with only `unknown key ...`,
   *          the same old-reader gap 27187 closed for `submit`.
   * @level   l2 (real bare remote, the declaration at the retained commit, real worktree)
   * @consumer every seat closing an environment whose declaration its checkout postdates
   * @testonly none
   */
  it("closes an environment whose declaration carries a top-level key this Yrd does not know, warning once", async () => {
    const w = await world(":")
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    // Close reads the retained commit, so the newer key is committed in the environment itself.
    const declared = join(path, ".yrd.yml")
    writeFileSync(declared, `${readFileSync(declared, "utf8")}futurekey: from a newer queue\n`)
    await gitIn(path)(["add", ".yrd.yml"])
    await gitIn(path)([
      "-c",
      "user.email=env-open@yrd.test",
      "-c",
      "user.name=yrd",
      "commit",
      "--quiet",
      "-m",
      "declare a key this Yrd does not know",
    ])
    const closed = capture(w.work)

    expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], closed.io), closed.stderr()).toBe(0)

    expect(closed.stderr()).toContain("futurekey:")
    expect(closed.stderr()).toMatch(/this environment's Yrd does not know/iu)
    expect(closed.stderr().match(/futurekey:/gu)).toHaveLength(1)
    expect(existsSync(path)).toBe(false)
  })

  it.each(["unknown", "outside", "symlink-outside", "dirty-tracked", "dirty-untracked", "locked"])(
    "refuses %s before running teardown or removing data",
    async (kind) => {
      const w = await world(":", "printf touched > ../teardown-ran.txt")
      const selected = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path } = await openEnvironment(w.work, selected)
      let target = path
      if (kind === "unknown") {
        target = join(dirname(path), "unregistered")
        mkdirSync(target)
      } else if (kind === "outside" || kind === "symlink-outside") {
        const outside = join(w.work, "outside")
        await w.git(["worktree", "add", "--quiet", "--detach", outside, selected])
        target = outside
        if (kind === "symlink-outside") {
          target = join(dirname(path), "escape")
          symlinkSync(outside, target)
        }
      } else if (kind === "dirty-tracked") writeFileSync(join(path, ".yrd.yml"), "local edits\n")
      else if (kind === "dirty-untracked") writeFileSync(join(path, "user-work.txt"), "uncommitted work\n")
      else await w.git(["worktree", "lock", "--reason", "active owner", path])

      const before = await w.git(["worktree", "list", "--porcelain", "-z"])
      const closed = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", target, "--json"], closed.io)).toBe(2)
      expect(closed.stdout()).toBe("")
      expect(closed.stderr()).toContain(
        kind.startsWith("dirty")
          ? "dirty"
          : kind === "locked"
            ? "locked"
            : kind === "unknown"
              ? "not registered"
              : "outside",
      )
      expect(await w.git(["worktree", "list", "--porcelain", "-z"])).toBe(before)
      expect(existsSync(target)).toBe(true)
      expect(existsSync(join(dirname(path), "teardown-ran.txt"))).toBe(false)
      expect(existsSync(join(w.work, "teardown-ran.txt"))).toBe(false)
    },
  )

  it.each(["fail", "dirty"])("preserves the worktree when teardown ends %s", async (kind) => {
    const w = await world(
      ":",
      kind === "fail" ? "printf 'teardown exploded\\n' >&2; exit 23" : "printf changed > teardown-left.txt",
    )
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path } = await openEnvironment(w.work, selected)
    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", path], closed.io)).toBe(2)
    expect(closed.stdout()).toBe("")
    expect(closed.stderr()).toContain(kind === "fail" ? "teardown exploded" : "dirty")
    expect(existsSync(path)).toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain", "-z"])).toContain(path)
    if (kind === "dirty") expect(readFileSync(join(path, "teardown-left.txt"), "utf8")).toBe("changed")
  })

  /**
   * @failure Automatic close can discard GitSuper's borrowed KEEP result or fail to forward its no-rehome policy.
   * @level l2
   * @consumer Yrd automatic cleanup and manual environment close
   */
  it.each([{ noRehome: false }, { noRehome: true }])(
    "closes or keeps a lender environment with live borrowers (noRehome=$noRehome)",
    async ({ noRehome }) => {
      const w = await world(":")
      await addMaterializedDependency(w)
      const selected = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path: lender } = await openEnvironment(w.work, selected)

      const openBorrower = capture(lender)
      expect(
        await runYrdProcess(["bun", "yrd", "env", "open", selected, "--bay", "borrower", "--json"], openBorrower.io),
        openBorrower.stderr(),
      ).toBe(0)
      const { path: borrower } = JSON.parse(openBorrower.stdout()) as { path: string }

      const lenderGitDir = (
        await command(join(lender, "vendor/dependency"), ["git", "rev-parse", "--absolute-git-dir"])
      ).stdout.trim()
      const borrowerGitDir = (
        await command(join(borrower, "vendor/dependency"), ["git", "rev-parse", "--absolute-git-dir"])
      ).stdout.trim()
      const altFile = join(borrowerGitDir, "objects", "info", "alternates")
      const existingAlt = existsSync(altFile) ? readFileSync(altFile, "utf8") : ""
      const loan = `${join(lenderGitDir, "objects")}\n${existingAlt}`
      writeFileSync(altFile, loan)

      const closed = capture(w.work)
      if (noRehome) {
        const options = { json: true, noRehome }
        expect(await closeEnvironment(lender, options, closed.io), closed.stderr()).toBe(0)
        expect(JSON.parse(closed.stdout())).toEqual({ kept: lender, reason: "borrowed", borrowers: [borrower] })
        expect(existsSync(lender)).toBe(true)
        expect(readFileSync(altFile, "utf8")).toBe(loan)
        expect(await w.git(["worktree", "list", "--porcelain"])).toContain(lender)
        return
      }
      expect(await runYrdProcess(["bun", "yrd", "env", "close", lender, "--json"], closed.io), closed.stderr()).toBe(0)
      expect(JSON.parse(closed.stdout())).toEqual({ closed: lender })
      expect(existsSync(lender)).toBe(false)

      const fsckSub = await command(join(borrower, "vendor/dependency"), ["git", "fsck", "--full"])
      expect(fsckSub.exit).toBe(0)
      expect(fsckSub.stderr).toBe("")

      const closeBorrower = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", borrower, "--json"], closeBorrower.io)).toBe(0)
    },
  )

  it("closes a packed lender environment with a unique commit and leaves the borrower clean (25908 cure)", async () => {
    const w = await world(":")
    await addMaterializedDependency(w)
    const selected = (await w.git(["rev-parse", "HEAD"])).trim()
    const { path: lender } = await openEnvironment(w.work, selected)

    const openBorrower = capture(lender)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "open", selected, "--bay", "borrower", "--json"], openBorrower.io),
      openBorrower.stderr(),
    ).toBe(0)
    const { path: borrower } = JSON.parse(openBorrower.stdout()) as { path: string }

    const lenderSub = join(lender, "vendor/dependency")
    const borrowerSub = join(borrower, "vendor/dependency")

    await command(lenderSub, ["git", "commit", "--allow-empty", "-m", "lender unique"])
    const uniqueSha = (await command(lenderSub, ["git", "rev-parse", "HEAD"])).stdout.trim()

    await command(lenderSub, ["git", "repack", "-a", "-d"])

    await command(lender, ["git", "add", "vendor/dependency"])
    await command(lender, ["git", "commit", "-m", "update dependency pin"])

    const lenderGitDir = (
      await command(lenderSub, ["git", "rev-parse", "--path-format=absolute", "--git-dir"])
    ).stdout.trim()
    const borrowerGitDir = (
      await command(borrowerSub, ["git", "rev-parse", "--path-format=absolute", "--git-dir"])
    ).stdout.trim()
    const altFile = join(borrowerGitDir, "objects", "info", "alternates")
    const existingAlt = existsSync(altFile) ? readFileSync(altFile, "utf8") : ""
    writeFileSync(altFile, `${join(lenderGitDir, "objects")}\n${existingAlt}`)

    const updateRefRes = await command(borrowerSub, ["git", "update-ref", "refs/heads/main", uniqueSha])
    expect(updateRefRes.exit).toBe(0)
    await command(borrowerSub, ["git", "symbolic-ref", "HEAD", "refs/heads/main"])

    const closed = capture(w.work)
    expect(await runYrdProcess(["bun", "yrd", "env", "close", lender, "--json"], closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toEqual({ closed: lender })
    expect(existsSync(lender)).toBe(false)

    const fsckSub = await command(borrowerSub, ["git", "fsck", "--full"])
    expect(fsckSub.exit).toBe(0)
    expect(fsckSub.stderr).toBe("")

    const catSub = await command(borrowerSub, ["git", "cat-file", "-t", uniqueSha])
    expect(catSub.exit).toBe(0)
    expect(catSub.stdout.trim()).toBe("commit")

    await command(borrower, ["git", "add", "vendor/dependency"])
    await command(borrower, ["git", "commit", "-m", "update dependency pin in borrower"])

    const closeBorrower = capture(w.work)
    expect(
      await runYrdProcess(["bun", "yrd", "env", "close", borrower, "--json"], closeBorrower.io),
      closeBorrower.stderr(),
    ).toBe(0)
  })

  /**
   * @failure 22894: a caller whose own same-UID CWD census cannot read every pid
   *          may neither certify the close nor state an intent: it refuses, and
   *          the environment waits for a human. The intent belongs to a context
   *          whose census reads every pid.
   * @level   l1 (injected incomplete census at the existing process-census boundary)
   * @consumer every seat whose sandbox scopes ptrace over other same-UID pids
   */
  it.runIf(process.platform === "linux")(
    "queues the close for a capable context when this caller's census is incomplete (22894 T1)",
    async () => {
      const w = await world(":")
      const state = join(dirname(w.work), "state")
      await w.git(["config", "yrd.workdir", state])
      const head = (await w.git(["rev-parse", "HEAD"])).trim()
      const { path } = await openEnvironment(w.work, head)
      const workdir = await workdirOf(w.git, { cwd: w.work })
      processCensus.mockResolvedValue(await incompleteCensus())
      const run = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], run.io), run.stderr()).toBe(4)
      const receipt = JSON.parse(run.stdout()) as Record<string, unknown>
      const file = closeRequestFile(workdir, path)
      expect(receipt, run.stderr()).toMatchObject({
        queued: path,
        reason: "incomplete-census",
        request: file,
        census: { mechanism: "proc", complete: false, rows: 0, unreadable: 1, uncleared: 1 },
      })
      expect(run.stderr()).toContain("cannot certify the close")
      expect(run.stderr()).toContain("queued request")
      expect(readCloseRequest(file)).toMatchObject({
        name: basename(path),
        path,
        requester: requesterOf(process.env),
        predicate: "direct-admission",
        options: {},
        head,
      })
      // The request is intent, never a removal: the environment is untouched.
      expect(existsSync(path)).toBe(true)
      expect(await w.git(["worktree", "list", "--porcelain"])).toContain(path)
      // Re-filing the same intent is idempotent (create-or-match), and the first
      // requester and time survive.
      const standing = readCloseRequest(file)
      const again = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], again.io), again.stderr()).toBe(4)
      expect(JSON.parse(again.stdout())).toMatchObject({ queued: path, alreadyQueued: true })
      expect(readCloseRequest(file)).toEqual(standing)
      // A request for the same path with DIFFERENT options is a conflict, named
      // with the standing requester, never overwritten.
      const conflict = capture(w.work)
      expect(
        await runYrdProcess(
          ["bun", "yrd", "env", "close", path, "--json", "--retain", join(state, "elsewhere")],
          conflict.io,
        ),
        conflict.stderr(),
      ).toBe(2)
      expect(conflict.stderr()).toContain("already stands")
      expect(conflict.stderr()).toContain(requesterOf(process.env))
      expect(readCloseRequest(file)).toEqual(standing)
    },
  )

  /**
   * @failure 22894: the readable-holder refusal (28120) must stay a refusal. It
   *          must never become a queued delegation, which would put a close the
   *          caller can already judge in front of the queue.
   * @level   l1 (injected complete census carrying one readable holder)
   * @consumer the caller whose environment genuinely has a process inside it
   */
  it.runIf(process.platform === "linux")(
    "a readable holder still refuses the direct close and files no request (28120, 22894 T4)",
    async () => {
      const w = await world(":")
      const state = join(dirname(w.work), "state")
      await w.git(["config", "yrd.workdir", state])
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      const workdir = await workdirOf(w.git, { cwd: w.work })
      processCensus.mockResolvedValue(await holderCensus(4242, path))
      const run = capture(w.work)
      expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], run.io), run.stderr()).toBe(2)
      expect(run.stderr()).toContain("process 4242 has CWD")
      expect(run.stderr()).toContain("was preserved")
      expect(existsSync(path)).toBe(true)
      expect(listCloseRequests(workdir)).toEqual([])
    },
  )

  /**
   * @failure 22894: a request this caller cannot write must be a loud refusal
   *          naming the file and the cure, never a silent `queued` for a close
   *          that will never happen.
   * @level   l1 (an unwritable request directory)
   * @consumer a sandboxed seat with no write to the queue workdir
   */
  it.runIf(process.platform === "linux")(
    "refuses loudly, and writes nothing, when the request cannot be written (22894 T5)",
    async () => {
      const w = await world(":")
      const state = join(dirname(w.work), "state")
      await w.git(["config", "yrd.workdir", state])
      const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
      const workdir = await workdirOf(w.git, { cwd: w.work })
      const directory = closeRequestsDirectory(workdir)
      mkdirSync(directory, { recursive: true })
      chmodSync(directory, 0o500)
      processCensus.mockResolvedValue(await incompleteCensus())
      try {
        const run = capture(w.work)
        expect(await runYrdProcess(["bun", "yrd", "env", "close", path, "--json"], run.io), run.stderr()).toBe(2)
        expect(run.stderr()).toContain("could not be written")
        expect(run.stderr()).toContain(directory)
        expect(run.stderr()).toContain("read every same-UID pid")
        expect(existsSync(path)).toBe(true)
        expect(listCloseRequests(workdir)).toEqual([])
      } finally {
        chmodSync(directory, 0o700)
      }
    },
  )

  /**
   * @failure 22894: the delegation split must not disturb the identity-clearing
   *          exemption the shared admission already owns (removely's
   *          `clearedByIdentity`) — a cleared denial is evidence, not a gap.
   * @level   l1 (injected denied census at the existing process-census boundary)
   * @consumer the shared admission policy, both callers
   */
  it.runIf(process.platform === "linux")("clears identity-denied pids and still admits (28120, 22894 T6)", async () => {
    const w = await world(":")
    const { path } = await openEnvironment(w.work, (await w.git(["rev-parse", "HEAD"])).trim())
    const observed = await removely.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2_000 })
    const io = capture(w.work)
    const admission = await admitEnvironmentClose(path, io.io, async () => ({
      rows: [],
      coverage: {
        ...observed.coverage,
        complete: false,
        unreadable: [unreadableDenial(["/usr/lib/systemd/systemd", "--user"])],
      },
    }))
    expect(admission).toEqual({ kind: "admitted" })
  })
})
