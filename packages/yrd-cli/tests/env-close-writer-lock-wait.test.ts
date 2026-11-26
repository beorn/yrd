/**
 * @failure 37624: `yrd env close` exited 2 saying it could not close after a writer-lock wait that
 *          ran out while another writer had removed the worktree, its registration and the ref — and a
 *          retry then refused "not registered at an existing path". A close that removed nothing must
 *          still fail, so the two halves are driven through the real close against a wrapper git.
 * @level l2 (a real repository, a real worktree registration, and git-super's own busy refusal text)
 * @consumer an author or queue round closing an environment while a second writer holds the lock
 * @reach fs-walk <fixture-only: temporary repositories and one removed environment>
 * @testonly none
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { BUSY_PREFIX } from "git-super/exclusive"
import { inspectProcessCensus, type ProcessCensus } from "removely"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { closeEnvironment, isWriterLockWaitFailure } from "../src/env-commands.ts"
import type { YrdCliIO } from "../src/types.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{ git: ReturnType<typeof gitIn>; work: string }>

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      localBranchProtections: null,
      color: false,
      cwd,
      stderr: (text) => void (stderr += text),
      stdout: (text) => void (stdout += text),
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-close-lock-wait-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "close-lock-wait@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), 'setup: ":"\n')
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "declare no setup work"])
  await git(["push", "--quiet", "origin", "main"])
  return { git, work }
}

/** The environment must declare a submodule: an ordinary close would otherwise take the plain-git route. */
async function addMaterializedDependency(w: World): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yrd-close-lock-wait-submodule-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "close-lock-wait@yrd.test"])
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

async function openEnvironment(cwd: string, commit: string): Promise<Readonly<{ path: string; head: string }>> {
  const run = capture(cwd)
  expect(
    await runYrdProcess(["bun", "yrd", "env", "open", commit, "--json", "--expires", "1d"], run.io),
    run.stderr(),
  ).toBe(0)
  return JSON.parse(run.stdout()) as { path: string; head: string }
}

/**
 * A `yrd.git` executable that answers the git-super removal with the refusal git-super itself prints when its
 * 4-minute writer-lock wait runs out.
 *
 * `gone` is the reported race's end state: the other writer finished, so the wrapper removes the worktree the
 * way `git worktree remove --force --force` does and writes no retained copy. `present` leaves everything in
 * place — the close that removed nothing must still fail. `progress` carries only the contention line the
 * waiter prints while it waits, which is not a refusal and must never settle a close.
 */
function busyGit(root: string, mode: "gone" | "present" | "progress"): string {
  const wrapper = join(root, `git-busy-${mode}.sh`)
  const busy = join(root, `busy-${mode}.txt`)
  writeFileSync(
    busy,
    mode === "progress"
      ? "git-super worktree: waiting for writer lock held by live holder: locks: writer.lock 4242 FLOCK WRITE 0-EOF; recorded note, not authority: git super worktree remove (pid:4242, age 240s)\ngit-super worktree: removal refused: component custody blocked at vendor/dependency\n"
      : `${BUSY_PREFIX}240000ms (timeout=240000ms; live holder: pid 4242 FLOCK WRITE 0-EOF; recorded note, not authority: holder=worktree remove; age=240s; owner=pid:4242; contender=pid:5252); <repo>/.git/yrd-worktree-mutations/writer.lock\n`,
  )
  const removeWorktree =
    mode === "gone"
      ? [
          'prev=""',
          'target=""',
          'for arg in "$@"; do',
          '  if [ "$prev" = "remove" ]; then target="$arg"; fi',
          '  prev="$arg"',
          "done",
          'git worktree remove --force --force "$target" >/dev/null 2>&1 || true',
          "git worktree prune >/dev/null 2>&1 || true",
        ]
      : []
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'case " $* " in',
      '  *" super "*" worktree remove "*)',
      ...removeWorktree,
      `    cat ${JSON.stringify(busy)} >&2`,
      "    exit 2 ;;",
      "esac",
      'exec git "$@"',
      "",
    ].join("\n"),
  )
  chmodSync(wrapper, 0o755)
  return wrapper
}

/**
 * One constant, two shapes: the in-process removal throws git-super's own Error, and the CLI route leaves the
 * same text in a GitExit. The contention line a waiting close prints is progress, and settling on it would let a
 * close that is still waiting claim an outcome it has not seen.
 */
it.each([
  { shape: "isExclusiveBusy Error", error: new Error(`${BUSY_PREFIX}240000ms (timeout=240000ms)`) },
  {
    shape: "GitExit message carrying the prefix",
    error: new Error(
      `git super --json worktree remove /env in /repo exited 2: ${BUSY_PREFIX}240000ms (timeout=240000ms)`,
      { cause: new Error("outer") },
    ),
  },
  {
    shape: "wrapped busy error",
    error: new Error("environment /env could not close through git super worktree remove", {
      cause: new Error(`${BUSY_PREFIX}240000ms (timeout=240000ms)`),
    }),
  },
] as const)("recognizes a writer-lock wait refusal: $shape (37624)", ({ error }) => {
  expect(isWriterLockWaitFailure(error)).toBe(true)
})

it.each([
  {
    shape: "the contention progress line",
    error: new Error(
      "git-super worktree: waiting for writer lock held by live holder: locks: writer.lock 4242 FLOCK WRITE 0-EOF; recorded note, not authority: git super worktree remove (pid:4242, age 240s)",
    ),
  },
  { shape: "an unrelated failure", error: new Error("worktree removal refused: component custody blocked") },
  { shape: "a non-Error", error: "busy" },
] as const)("does not settle a close on $shape (37624)", ({ error }) => {
  expect(isWriterLockWaitFailure(error)).toBe(false)
})

/** An idle same-UID host: the real census shape with no rows and complete coverage. */
async function idleCensus(): Promise<ProcessCensus<"same-uid">> {
  const observed = await inspectProcessCensus({ scope: "same-uid", sources: ["cwd", "fd"], deadlineMs: 2_000 })
  return { ...observed, rows: [], coverage: { ...observed.coverage, complete: true, unreadable: [] } }
}

it("settles a close whose writer-lock wait ran out after another writer removed the environment (37624)", async () => {
  const w = await world()
  await addMaterializedDependency(w)
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  const { path } = await openEnvironment(w.work, head)
  await w.git([
    "config",
    "--local",
    "yrd.git",
    JSON.stringify({ executable: busyGit(dirname(w.work), "gone"), contract: "native" }),
  ])
  const run = capture(w.work)
  // This row is about the writer-lock wait, not host process churn: a CI runner denies /proc/<pid> for a sibling
  // bun (EACCES), and the same-UID census then refuses the close before the wait is reached (yrd CI #1011). Inject
  // an idle host through the test-only census seam (28120): no rows, complete coverage.
  const exit = await closeEnvironment(path, { json: true }, run.io, idleCensus)
  expect(existsSync(path), run.stdout() + run.stderr()).toBe(false)
  expect(await w.git(["worktree", "list", "--porcelain"])).not.toContain(path)
  // The other writer's removal is a fact; the retained copy this close never wrote is not, and says so.
  expect(exit, run.stdout() + run.stderr()).toBe(1)
  expect(JSON.parse(run.stdout())).toMatchObject({ closed: path, retention: "unverified", retirement: "incomplete" })
  // The lock is what the refusal proves; who removed it is not established, so it is not claimed.
  expect(run.stderr()).toContain("another writer held the repository mutation lock for the whole wait")
  expect(run.stderr()).toMatch(/was admitted at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/u)
  expect(run.stderr()).not.toContain("another writer removed it")
  expect(run.stderr()).toContain("retained-modules")
})

it("keeps failing a close that removed nothing, even after a writer-lock wait ran out (37624)", async () => {
  const w = await world()
  await addMaterializedDependency(w)
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  const { path } = await openEnvironment(w.work, head)
  await w.git([
    "config",
    "--local",
    "yrd.git",
    JSON.stringify({ executable: busyGit(dirname(w.work), "present"), contract: "native" }),
  ])
  const run = capture(w.work)
  const failure = await closeEnvironment(path, { json: true }, run.io).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  // Two refusals keep this row's promise, and which one fires depends on the host: the worktree removal itself, or
  // the same-UID census refusing because it could not read a sibling pid (a CI runner denies /proc/<pid> with
  // EACCES while a local host reads it). Either way the close must be REFUSED, nothing removed, and the census
  // variant must name the pid it could not read — an unknown holder is never assumed absent.
  expect(failure, run.stdout() + run.stderr()).toBeDefined()
  if (failure?.includes("could not close through git super worktree remove") === true) {
    expect(failure, run.stdout() + run.stderr()).toContain("no plain-git fallback was attempted")
  } else {
    expect(failure, run.stdout() + run.stderr()).toMatch(/same-UID process (CWD|fd) census /u)
    expect(failure, run.stdout() + run.stderr()).toMatch(
      /could not read pid \d+ \S+ \(EACCES\)|incomplete: no readable coverage/u,
    )
    expect(failure, run.stdout() + run.stderr()).toContain("a holder among them cannot be ruled out")
  }
  expect(run.stdout()).toBe("")
  expect(existsSync(path)).toBe(true)
  expect(await w.git(["worktree", "list", "--porcelain"])).toContain(path)
})

it("keeps failing a close whose waiter only printed the contention line (37624)", async () => {
  const w = await world()
  await addMaterializedDependency(w)
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  const { path } = await openEnvironment(w.work, head)
  await w.git([
    "config",
    "--local",
    "yrd.git",
    JSON.stringify({ executable: busyGit(dirname(w.work), "progress"), contract: "native" }),
  ])
  const run = capture(w.work)
  // This row is about the waiter's contention line, not host process churn. A live same-UID process seen under the
  // environment makes close keep it and resolve 0 ("wait for its owner to leave"), which failed this row about one
  // run in five (yrd CI run 45881168598). Inject the idle host through the test-only census seam (28120), as the
  // settle row does.
  await expect(closeEnvironment(path, { json: true }, run.io, idleCensus)).rejects.toThrow(
    "could not close through git super worktree remove",
  )
  expect(existsSync(path)).toBe(true)
  expect(run.stderr()).not.toContain("another writer held the repository mutation lock")
})
