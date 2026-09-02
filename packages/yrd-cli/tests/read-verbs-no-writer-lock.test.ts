/**
 * @failure A read verb (mr list, pr view, pr list, queue list, watch's read
 * path) parks on the journal writer lock behind a live pass, mutates the
 * store or its lock file, or cannot be torn down by TERM while it waits
 * (24019, measured 2026-09-01).
 * @level l2
 * @consumer @yrd/cli read verbs through an active host (every non-viewer
 * posture, and every embedding host through createYrdHost)
 */
import { readFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createExclusive } from "@yrd/persistence"
import { runYrd, type YrdCliIO } from "@yrd/cli"
import { createLogger } from "loggily"
import { afterEach, describe, expect, it } from "vitest"
import { createYrdHost as createYrdHostRaw } from "../src/host.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"

const silentLog = createLogger("test", [{ level: "silent" }])
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/** The same synthetic repository host.test.ts uses, with its store initialized. */
async function repository(): Promise<{ repo: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-read-verbs-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), 'checks: [{check: {run: "true"}}]\n')
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "switch", "-qc", "issue/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "-qm", `feature\n\nChange-Id: I${"cafe".repeat(10)}`)
  await git(repo, "switch", "-q", "main")
  const initialized = await createYrdHostRaw({ cwd: repo, log: silentLog })
  await initialized.close()
  return { repo, stateDir: join(repo, ".git", "yrd") }
}

async function heldBy(dir: string, holder: string): Promise<() => Promise<void>> {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = createExclusive(dir).run(
    async () => {
      entered.resolve()
      await release.promise
    },
    { holder },
  )
  await entered.promise
  return async () => {
    release.resolve()
    await held
  }
}

function collectingIO(repo: string): YrdCliIO & { text(): { stdout: string; stderr: string } } {
  let stdout = ""
  let stderr = ""
  return {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    cwd: repo,
    columns: 120,
    interactive: false,
    text: () => ({ stdout, stderr }),
  }
}

async function within<Result>(
  ms: number,
  operation: Promise<Result>,
): Promise<Readonly<{ outcome: "finished"; result: Result } | { outcome: string }>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<{ outcome: string }>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: `timed out after ${ms}ms` }), ms)
  })
  try {
    return await Promise.race([operation.then((result) => ({ outcome: "finished" as const, result })), expired])
  } finally {
    clearTimeout(timer)
  }
}

type StoreFacts = Readonly<{ headCursor: string; refs: string; receiverRefs: string; lock: string }>

async function storeFacts(repo: string, stateDir: string): Promise<StoreFacts> {
  using database = new Database(join(stateDir, "journal.sqlite"), { readonly: true, strict: true })
  const headCursor =
    database.query<{ value: string }, []>("SELECT value FROM journal_metadata WHERE key = 'head_cursor'").get()
      ?.value ?? "missing"
  return {
    headCursor,
    refs: await git(repo, "for-each-ref"),
    receiverRefs: await git(join(stateDir, "prs.git"), "for-each-ref"),
    lock: await readFile(join(stateDir, "writer.lock"), "utf8"),
  }
}

const READ_VERBS: readonly (readonly string[])[] = [
  ["mr", "list", "--json"],
  ["pr", "view", "PR1", "--json"],
  ["pr", "list", "--json"],
  ["queue", "list", "--json"],
  // `watch` canonicalizes to `queue list --watch`; its read path is the
  // same createQueueListSnapshotLoader `queue list` reads through.
  ["queue", "list", "--json", "--latest"],
]

describe("read verbs beside a live writer (24019)", { timeout: 60_000 }, () => {
  it("acceptance 1: mr list through an active host returns within 10 s while a writer holds the lock", async () => {
    const { repo, stateDir } = await repository()
    const release = await heldBy(stateDir, "queue-run pass")
    try {
      const io = collectingIO(repo)
      const run = within(
        10_000,
        (async () => {
          await using host = await createYrdHostRaw({ cwd: repo, log: silentLog })
          return runYrd(host.app, ["mr", "list", "--json"], io)
        })(),
      )
      const outcome = await run
      expect(outcome.outcome).toBe("finished")
      expect(JSON.parse(io.text().stdout)).toMatchObject({ command: "pr.list" })
    } finally {
      await release()
    }
  })

  it("acceptance 3: no read verb mutates the journal head, the refs, or the lock file — lock held or free", async () => {
    const { repo, stateDir } = await repository()

    // Lock HELD by a live writer: every verb completes inside the bound and
    // changes nothing. (The holder's own acquire writes writer.lock, so the
    // baseline is taken once it holds.)
    const release = await heldBy(stateDir, "queue-run pass")
    const before = await storeFacts(repo, stateDir)
    try {
      for (const argv of READ_VERBS) {
        const io = collectingIO(repo)
        const outcome = await within(
          10_000,
          (async () => {
            await using host = await createYrdHostRaw({ cwd: repo, log: silentLog })
            return runYrd(host.app, [...argv], io)
          })(),
        )
        expect({ argv, outcome: outcome.outcome }).toEqual({ argv, outcome: "finished" })
        expect({ argv, after: await storeFacts(repo, stateDir) }).toEqual({ argv, after: before })
      }
    } finally {
      await release()
    }

    // Lock FREE: a read verb that took the lock would rewrite writer.lock with
    // its own pid and holder (that is how "journal-read" got into the file).
    // Releasing flock leaves the body as the last holder wrote it.
    const beforeFree = await storeFacts(repo, stateDir)
    for (const argv of READ_VERBS) {
      const io = collectingIO(repo)
      await using host = await createYrdHostRaw({ cwd: repo, log: silentLog })
      await runYrd(host.app, [...argv], io)
      await host.close()
      expect({ argv, after: await storeFacts(repo, stateDir) }).toEqual({ argv, after: beforeFree })
    }
  })

  it("acceptance 2: SIGTERM reaps a yrd process parked on the writer lock within 5 s, exit non-zero, one-line reason", async () => {
    const { repo, stateDir } = await repository()
    const release = await heldBy(stateDir, "queue-run pass")
    try {
      // `queue resume` boots (lock-free), arms the shutdown binding, then
      // appends — and the append parks behind the held lock.
      const child = Bun.spawn(["bun", "bin/yrd", "queue", "resume", "main"], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      })
      const stdout = new Response(child.stdout).text()
      let stderr = ""
      const reader = child.stderr.getReader()
      const decoder = new TextDecoder()
      const parked = (async () => {
        while (!/waiting up to \d+ms for the writer lock/u.test(stderr)) {
          const chunk = await reader.read()
          if (chunk.done) return
          stderr += decoder.decode(chunk.value)
        }
      })()
      // Base never prints the waiting row (it parks silently at boot), so the
      // TERM goes after 8 s regardless; on the branch it goes the moment the
      // row lands.
      await Promise.race([parked, Bun.sleep(8_000)])
      const termAt = performance.now()
      child.kill("SIGTERM")
      const exited = await within(5_000, child.exited)
      const drained = (async () => {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return
          stderr += decoder.decode(chunk.value)
        }
      })()
      await Promise.race([drained, Bun.sleep(1_000)])
      expect(exited.outcome).toBe("finished")
      expect(performance.now() - termAt).toBeLessThan(5_000)
      expect(await stdout).toBe("")
      expect(child.exitCode ?? child.signalCode).not.toBe(0)
      // The wait announced itself once with the holder's pid and command, and
      // the stop is one typed line naming the holder and the signal.
      const waiting = stderr.split("\n").filter((line) => /is waiting up to \d+ms for the writer lock/u.test(line))
      expect(waiting).toHaveLength(1)
      expect(waiting[0]).toMatch(/held by pid:\d+ \(queue-run pass\)/u)
      const reason = stderr.split("\n").filter((line) => line.startsWith("error: "))
      expect(reason).toHaveLength(1)
      expect(reason[0]).toMatch(
        /^error: journal-append stopped waiting for the writer lock held by pid:\d+ \(queue-run pass\): stopped by SIGTERM/u,
      )
    } finally {
      await release()
    }
  })
})
