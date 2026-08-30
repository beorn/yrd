/**
 * The superproject-plus-submodule fixture `yrd gitlink advance` is tested against.
 *
 * Extracted from `gitlink-advance.test.ts` when a second suite needed the same ground:
 * everything an advance touches is real here — two bare remotes, a working submodule
 * checkout, a `.yrd.yml`-shaped config — and a second copy of that would be a second thing
 * to keep true.
 */

import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { safeRemove } from "removely"
import { join } from "node:path"
import { createLogger } from "loggily"
import { createDefaultYrdApp, type YrdCliApp, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { createJournal } from "@yrd/persistence"
import { createProcess, type Process } from "@yrd/process"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
import { runYrd as runYrdRaw } from "../src/run.ts"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const cleanups: Array<() => Promise<void>> = []

/** Every test file using this fixture calls it from its own `afterEach`. */
export async function cleanupGitlinkFixtures(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
}

export async function gitProbe(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr || stdout}`)
  return stdout.trim()
}

async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await gitProbe(path, "init", "-q", "-b", "main")
  await gitProbe(path, "config", "user.name", "Yrd Test")
  await gitProbe(path, "config", "user.email", "yrd@example.invalid")
}

/**
 * A manifest and a REAL lockfile, so a bay opened here provisions the way a bay of the
 * repository this verb actually serves does.
 *
 * The single dependency is a `file:` sibling: a genuine `bun install --frozen-lockfile`
 * resolves it in about a millisecond and never reaches the network, so the provisioning step
 * under test is the real one rather than a stand-in that could agree with a broken caller.
 */
async function installableManifest(root: string): Promise<void> {
  await mkdir(join(root, "local"), { recursive: true })
  await writeFile(
    join(root, "local", "package.json"),
    `${JSON.stringify({ name: "local-thing", version: "0.0.0", private: true }, null, 2)}\n`,
  )
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "advance-fixture-root",
        version: "0.0.0",
        private: true,
        dependencies: { "local-thing": "file:./local" },
      },
      null,
      2,
    )}\n`,
  )
  const install = Bun.spawn(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [output, code] = await Promise.all([new Response(install.stderr).text(), install.exited])
  if (code !== 0) throw new Error(`fixture lockfile generation failed: ${output}`)
}

/**
 * A `pre-commit` hook on the fixture repository — which every bay of it inherits, because
 * linked work trees share the common hooks directory. This is how the repositories this verb
 * serves refuse: their guard runs at authoring time, inside the bay, on the commit the verb
 * is writing.
 */
export async function installPreCommitHook(root: string, script: string): Promise<void> {
  const path = join(root, ".git", "hooks", "pre-commit")
  await mkdir(join(root, ".git", "hooks"), { recursive: true })
  await writeFile(path, script)
  await chmod(path, 0o755)
}

/**
 * A pre-commit guard shaped like the one that refused this verb's first real use: it reads
 * the staged gitlink and asks THIS work tree's submodule to prove the move is a
 * fast-forward. A store that does not hold the target cannot answer, and the guard reads
 * that silence as merged work being dropped.
 *
 * It exits early when the gitlink is unchanged, exactly as the real guard does — otherwise
 * it would also refuse the bay's own checkpoint commit, which writes no gitlink.
 */
export const FAST_FORWARD_PRE_COMMIT_HOOK = `#!/bin/sh
staged=$(git ls-files -s dep | awk '{print $2}')
recorded=$(git rev-parse HEAD:dep 2>/dev/null)
[ -z "$staged" ] && exit 0
[ "$staged" = "$recorded" ] && exit 0
# The submodule question must not inherit the superproject's repo-scoped git env. Git
# exports GIT_DIR and GIT_INDEX_FILE to hook children, so a bare 'git -C dep' asks the
# SUPERPROJECT about submodule commits and calls both of them invalid — indistinguishable
# from the cold store this guard is looking for. The guard being modelled here drops the
# same variables for exactly this reason.
if ! (unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY
      git -C dep merge-base --is-ancestor "$recorded" "$staged") 2>/dev/null; then
  echo "PIN-GUARD REFUSAL (pre-commit): 1 gitlink move would drop merged submodule work" >&2
  echo "cure: fetch $staged into dep and check it out, then retry" >&2
  exit 1
fi
exit 0
`

/**
 * The second guard the verb met on the same night: the repository's own typecheck, run at
 * authoring time on a gitlink move, against a bay that had never been provisioned.
 */
export const DEPENDENCIES_PRE_COMMIT_HOOK = `#!/bin/sh
staged=$(git ls-files -s dep | awk '{print $2}')
recorded=$(git rev-parse HEAD:dep 2>/dev/null)
[ -z "$staged" ] && exit 0
[ "$staged" = "$recorded" ] && exit 0
if [ ! -d node_modules/local-thing ]; then
  echo "PIN-GUARD REFUSAL (pre-commit): root typecheck failed for a gitlink move" >&2
  echo "TYPECHECK BLOCKED: dependencies are not installed in this work tree" >&2
  echo "Run: bun install --frozen-lockfile" >&2
  exit 1
fi
exit 0
`

const config: ResolvedYrdProjectConfig = {
  base: "main",
  batch: 1,
  steps: ["check", "merge"],
  requires: [],
  definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
  contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
}

export type Fixture = Readonly<{
  root: string
  submodule: string
  /** The submodule's three main commits, oldest first. */
  main: readonly [string, string, string]
  /** A commit pushed to the submodule's origin but never merged on its main. */
  offMain: string
  /** A commit that exists only locally in the submodule and descends from its main. */
  descendant: string
}>

/**
 * A superproject with its own origin, recording a submodule whose main carries three
 * commits, with the gitlink parked on the first.
 */
export async function superprojectWithThreeCommitSubmodule(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "yrd-gitlink-advance-"))
  cleanups.push(() => safeRemove(parent, { within: tmpdir(), allowMissing: true }))
  const submodule = join(parent, "submodule")
  const submoduleRemote = join(parent, "submodule.git")
  const root = join(parent, "root")
  const rootRemote = join(parent, "root.git")

  await repository(submodule)
  const commit = async (text: string, message: string): Promise<string> => {
    await writeFile(join(submodule, "submodule.txt"), `${text}\n`)
    await gitProbe(submodule, "add", "submodule.txt")
    await gitProbe(submodule, "commit", "-qm", message)
    return gitProbe(submodule, "rev-parse", "HEAD")
  }
  const one = await commit("one", "submodule: the first thing")
  const two = await commit("two", "submodule: the second thing")
  const three = await commit("three", "submodule: the third thing")
  await gitProbe(parent, "init", "-q", "--bare", "-b", "main", submoduleRemote)
  await gitProbe(submodule, "remote", "add", "origin", submoduleRemote)
  await gitProbe(submodule, "push", "-q", "-u", "origin", "main")

  // Published on the submodule's origin, never merged on its main — a real, pushed commit
  // that is nevertheless not a min commit.
  await gitProbe(submodule, "checkout", "-q", "-b", "someones-wip", one)
  await writeFile(join(submodule, "wip.txt"), "wip\n")
  await gitProbe(submodule, "add", "wip.txt")
  await gitProbe(submodule, "commit", "-qm", "submodule: somebody's unmerged work")
  const offMain = await gitProbe(submodule, "rev-parse", "HEAD")
  await gitProbe(submodule, "push", "-q", "origin", `${offMain}:refs/heads/someones-wip`)

  // A local-only descendant of main — the case the verb is allowed to publish itself.
  await gitProbe(submodule, "checkout", "-q", "-b", "ahead", three)
  await writeFile(join(submodule, "submodule.txt"), "four\n")
  await gitProbe(submodule, "commit", "-qam", "submodule: the fourth thing")
  const descendant = await gitProbe(submodule, "rev-parse", "HEAD")
  await gitProbe(submodule, "checkout", "-q", "main")

  await repository(root)
  await writeFile(join(root, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n')
  await writeFile(join(root, ".gitignore"), "node_modules/\n")
  await installableManifest(root)
  await gitProbe(root, "add", ".yrd.yml", ".gitignore", "package.json", "bun.lock", "local/package.json")
  await gitProbe(root, "commit", "-qm", "yrd config")
  await gitProbe(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "dep")
  await gitProbe(join(root, "dep"), "remote", "set-url", "origin", submoduleRemote)
  await gitProbe(join(root, "dep"), "fetch", "-q", "origin")
  await gitProbe(join(root, "dep"), "checkout", "-q", one)
  await gitProbe(root, "add", "dep")
  await gitProbe(root, "commit", "-qm", "record dep at its first commit")
  await gitProbe(parent, "init", "-q", "--bare", "-b", "main", rootRemote)
  await gitProbe(root, "remote", "add", "origin", rootRemote)
  await gitProbe(root, "push", "-q", "-u", "origin", "main")

  return { root, submodule, main: [one, two, three], offMain, descendant }
}

export async function appFor(repo: string): Promise<{
  app: YrdCliApp
  process: ReturnType<typeof createProcess>
  journal: NonNullable<YrdCliServices["journal"]>
}> {
  const stateDir = join(repo, ".git", "yrd")
  const log = createLogger("yrd", [{ level: "silent" }])
  const runtimeProcess = createProcess({ cwd: repo })
  const journal = createJournal({ dir: stateDir, inject: { log } })
  const app = await createDefaultYrdApp({
    repo,
    stateDir,
    baysRoot: join(repo, ".bays"),
    journal,
    process: runtimeProcess,
    config,
    log,
  })
  cleanups.push(async () => {
    await app.close()
    await runtimeProcess.close()
  })
  // The mutable journal exposes its floor raise as a non-enumerable `administration`
  // capability; the CLI takes it as a service. `importOrphan` is required by that service
  // type and is not part of this suite — it throws rather than pretending to work.
  const { bump } = (journal as unknown as { administration: NonNullable<YrdCliServices["journal"]> }).administration
  const administration: NonNullable<YrdCliServices["journal"]> = {
    importOrphan: () => {
      throw new Error("gitlink-advance fixture installs no orphan journal importer")
    },
    ...(bump === undefined ? {} : { bump }),
  }
  return { app, process: runtimeProcess, journal: administration }
}

export function outputIO(repo: string): { io: YrdCliIO; stdout: () => string; stderr: () => string } {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      cwd: repo,
      runner: "cli-test",
      leaseMs: 60_000,
    } as YrdCliIO,
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

/**
 * A fresh fixture journal starts at floor v0 and refuses every write until the floor is
 * raised to the schema the running code requires.
 */
const JOURNAL_FLOOR = 3

/** One command the verb ran, in the order it ran it. */
export type RecordedRun = Readonly<{ argv: readonly string[]; cwd: string | undefined }>

/**
 * The real runtime process, with every invocation recorded first.
 *
 * Ordering is half of what this verb had to learn — fetch, check out, install, stage, commit,
 * and each step wrong-side-of the next was a separate refusal in the field — so the ORDER is
 * an assertable fact here, not something inferred from an end state that several orders can
 * produce.
 */
function recordingProcess(runtime: Process, into: RecordedRun[]): Process {
  return {
    run: async (request) => {
      into.push({ argv: request.argv, cwd: request.cwd })
      return runtime.run(request)
    },
    reapPath: (path) => runtime.reapPath(path),
    close: () => runtime.close(),
    [Symbol.asyncDispose]: () => runtime[Symbol.asyncDispose](),
  }
}

export async function fixtureAdvance(
  repo: string,
  args: readonly string[],
  recorded?: RecordedRun[],
): Promise<{ exit: number; stdout: string; stderr: string; app: YrdCliApp }> {
  const { app, process: runtime, journal } = await appFor(repo)
  const runtimeProcess = recorded === undefined ? runtime : recordingProcess(runtime, recorded)
  const services: YrdCliServices = {
    process: runtimeProcess,
    base: "main",
    journal,
    queueReadModel: testQueueReadModel(app),
    // The advance's own delivery is what this suite is about; the repository's required
    // checks are somebody else's contract, stubbed green so a check failure cannot be
    // mistaken for the composition failing.
    checks: {
      names: [],
      run: async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 0, timedOut: false }),
      install: async (cwd: string) => join(cwd, ".git/yrd/hooks/pre-submit"),
    },
  }
  const bump = outputIO(repo)
  const bumped = await runYrdRaw(app, ["yrd", "admin", "journal", "bump", String(JOURNAL_FLOOR)], bump.io, services)
  if (bumped !== 0) throw new Error(`journal floor raise failed: ${bump.stdout()}\n${bump.stderr()}`)
  const out = outputIO(repo)
  const exit = await runYrdRaw(app, ["yrd", ...args], out.io, services)
  return { exit, stdout: out.stdout(), stderr: out.stderr(), app }
}
