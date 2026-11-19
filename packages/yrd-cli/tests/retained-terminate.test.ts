/**
 * @failure #35047: a TERM to `yrd env retained --retire-expired` killed the CLI but left its GitSuper retire-batch
 *   child (a detached process-group leader) running, so it kept writing evidence after the caller's deadline
 *   (2026-11-19, twice: once under `timeout`, once under a process-group kill of the CLI).
 * @level l2 (a real yrd CLI process, a real child and grandchild tree, real signals)
 * @consumer every caller that bounds a retained-store batch: a seat's `timeout`, a supervisor's stop, Ctrl-C.
 * @testonly none
 */
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const roots: string[] = []
const spawned: number[] = []
afterAll(() => {
  // Positive-control cleanup only: a failing run must not leave its fixture tree behind.
  for (const pid of spawned) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // silent-fallback-allow: ESRCH means cleanup already reached the asserted dead state.
    }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false
    throw error
  }
}

async function until(what: string, ok: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function fixture(): Promise<
  Readonly<{ work: string; retain: string; proof: string; pids: string; beat: string }>
> {
  const root = mkdtempSync(join(tmpdir(), "yrd-retained-terminate-"))
  roots.push(root)
  const work = join(root, "work")
  const git = gitIn(root)
  await git(["init", "--quiet", "--initial-branch=main", work])
  const inWork = gitIn(work)
  await inWork(["config", "user.email", "terminate@yrd.test"])
  await inWork(["config", "user.name", "yrd"])
  await inWork(["commit", "--quiet", "--allow-empty", "-m", "initial"])
  const retain = join(root, "retained-modules")
  mkdirSync(join(retain, "old"), { recursive: true })
  writeFileSync(
    join(retain, "old", "manifest.json"),
    JSON.stringify({ retainUntil: "2020-01-01T00:00:00Z", writerLocks: [], notCompared: [] }),
  )
  const pids = join(root, "pids")
  const beat = join(root, "beat")
  // Stands in for GitSuper's retire-batch: a child that writes evidence and a grandchild that ignores TERM, so only
  // the Process owner's group settlement (TERM, then KILL after its grace) can end the tree. Every other call is git.
  const wrapper = join(root, "git-wrapper.sh")
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'case " $* " in *" super "*" retire-batch "*)',
      `  echo "child $$" >> ${JSON.stringify(pids)}`,
      `  sh -c 'trap "" TERM; echo "grandchild $$" >> ${pids}; while :; do echo g >> ${beat}; sleep 0.1; done' &`,
      `  while :; do echo c >> ${JSON.stringify(beat)}; sleep 0.1; done ;;`,
      "esac",
      'exec git "$@"',
      "",
    ].join("\n"),
  )
  chmodSync(wrapper, 0o755)
  await inWork(["config", "--local", "yrd.git", JSON.stringify({ executable: wrapper, contract: "native" })])
  const entry = join(root, "yrd-entry.ts")
  writeFileSync(entry, `import { runYrdExecutable } from ${JSON.stringify(CLI)}\nawait runYrdExecutable({})\n`)
  return { work, retain, proof: join(root, "proof"), pids, beat }
}

function startRetained(w: Awaited<ReturnType<typeof fixture>>): ChildProcess {
  const entry = join(dirname(w.work), "yrd-entry.ts")
  const cli = spawn(
    "bun",
    [
      entry,
      "env",
      "retained",
      "--retire-expired",
      "--retain",
      w.retain,
      "--namespace",
      dirname(w.work),
      "--artifact-dir",
      w.proof,
      "--entry",
      "old",
      "--json",
    ],
    { cwd: w.work, stdio: ["ignore", "pipe", "pipe"] },
  )
  if (cli.pid !== undefined) spawned.push(cli.pid)
  return cli
}

function treePids(path: string): Map<string, number> {
  const rows = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : []
  return new Map(rows.filter(Boolean).map((row) => [row.split(" ")[0] as string, Number(row.split(" ")[1])]))
}

it("a TERM to the retained CLI settles its retire-batch child and TERM-ignoring grandchild before the CLI dies", async () => {
  const w = await fixture()
  const cli = startRetained(w)
  let stderr = ""
  cli.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    cli.once("exit", (code, signal) => resolve({ code, signal })),
  )

  // Positive control: the whole tree is live and writing before the signal.
  await until("the batch child and grandchild to start", () => treePids(w.pids).size === 2, 30_000)
  const tree = treePids(w.pids)
  const child = tree.get("child") as number
  const grandchild = tree.get("grandchild") as number
  spawned.push(child, grandchild)
  expect(alive(child) && alive(grandchild)).toBe(true)
  const before = statSync(w.beat).size
  await until("evidence to grow", () => statSync(w.beat).size > before, 5_000)

  cli.kill("SIGTERM")
  const { signal } = await exited

  // The CLI died OF the signal, after the owner's settlement: nothing in its tree survives, and the evidence stops.
  expect(signal, stderr).toBe("SIGTERM")
  expect({ child: alive(child), grandchild: alive(grandchild) }).toEqual({ child: false, grandchild: false })
  expect(stderr).toContain("SIGTERM received; settling the GitSuper child before exit")
  const settled = statSync(w.beat).size
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(statSync(w.beat).size).toBe(settled)
}, 60_000)
