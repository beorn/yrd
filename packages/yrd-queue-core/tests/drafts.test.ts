/**
 * @failure  A branch pushed and never submitted was nowhere in `yrd watch`, and `yrd queue stats` counted
 *           "pushed, never submitted" by a second `ls-remote` with its own lenient parse, by branch, with the
 *           queue's own `yrd/*` pins, `preserve/*` keeps and heads already on the target all inside the count
 *           (@i/10-yrd/24196, A2-set-v3 Q2 and Q6, and the KPI ruling on 24163). The one definition of a draft:
 *           a head at the remote with no change ref AT THAT HEAD, off the target, outside `yrd/*` and
 *           `preserve/*`, committed inside the window; a head this repository has not read is off the target
 *           by its absence and counted undated.
 * @level    l2 (a real remote, real branches and real submits, read by the real queue read)
 * @consumer the operator's draft rows in `yrd watch`, and `yrd queue stats` `pushedNeverSubmitted`
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, readQueue, submit, type Git } from "../src/index.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type Draft = Readonly<{
  branch: string
  head: string
  committedAt?: Date
  author?: string
  movedSinceSubmit: boolean
}>
type DraftReading = Readonly<{ dated: readonly Draft[]; undated: readonly Draft[] }>
type ReadDrafts = (
  git: Git,
  read: Awaited<ReturnType<typeof readQueue>>,
  options: Readonly<{ targetSha: string; since?: Date }>,
) => Promise<DraftReading>

describe("the one definition of a draft (24196, A2-set-v3)", () => {
  it("is a head nobody submitted AT THAT HEAD, off the target, outside yrd/* and preserve/*, inside the window, read in three batches with the ancestry walk over present in-window heads only", async () => {
    const now = new Date("2026-09-03T12:00:00.000Z")
    const hour = 3_600_000
    const ago = (ms: number): Date => new Date(now.getTime() - ms)
    const root = mkdtempSync(join(tmpdir(), "yrd-core-drafts-"))
    roots.push(root)
    const remote = join(root, "remote.git")
    const work = join(root, "work")
    const other = join(root, "other")
    const seed = gitIn(root)
    await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
    await seed(["clone", "--quiet", remote, work])
    // Every commit is dated, so the window has exact edges to fall on either side of.
    const dated = (dir: string, at: Date) =>
      gitIn(dir, undefined, undefined, {
        env: { ...process.env, GIT_AUTHOR_DATE: at.toISOString(), GIT_COMMITTER_DATE: at.toISOString() },
      })
    const git = gitIn(work)
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
    await git(["checkout", "--quiet", "-b", "main"])
    writeFileSync(join(work, ".yrd.yml"), "{}\n")
    await git(["add", ".yrd.yml"])
    await dated(work, ago(6 * hour))(["commit", "--quiet", "-m", "declare the queue"])
    const behind = (await git(["rev-parse", "HEAD"])).trim()
    await dated(work, ago(5 * hour))(["commit", "--quiet", "--allow-empty", "-m", "the target moves on"])
    await git(["push", "--quiet", "origin", "main"])
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const commitOn = async (name: string, at: Date, author = "yrd"): Promise<string> => {
      await git(["checkout", "--quiet", name])
      writeFileSync(join(work, `${name.replaceAll("/", "-")}-${String(at.getTime())}.txt`), `${name}\n`)
      await git(["add", "."])
      await dated(work, at)(["-c", `user.name=${author}`, "commit", "--quiet", "-m", name])
      const head = (await git(["rev-parse", "HEAD"])).trim()
      await git(["checkout", "--quiet", "main"])
      await git(["push", "--quiet", "origin", `${head}:refs/heads/${name}`])
      return head
    }
    const pushed = async (name: string, at: Date, author?: string): Promise<string> => {
      await git(["branch", name, "main"])
      return commitOn(name, at, author)
    }
    const submitted = async (branch: string) =>
      submit(git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })

    await pushed("task/submitted", ago(2 * hour))
    await submitted("task/submitted")
    // Submitted once, then pushed again: the new head has no change ref of its own.
    await pushed("task/moved", ago(3 * hour))
    await submitted("task/moved")
    const moved = await commitOn("task/moved", ago(30 * 60_000), "grace")
    const recent = await pushed("task/recent", ago(hour), "ada")
    const old = await pushed("task/old", ago(10 * 24 * hour))
    await pushed("yrd/pin", ago(hour))
    await pushed("preserve/kept", ago(hour))
    await git(["push", "--quiet", "origin", `${behind}:refs/heads/task/behind-target`])
    await git(["push", "--quiet", "origin", `${target}:refs/heads/task/at-target`])
    // A head this clone never fetched, and a kept one it never fetched: absence decides nothing about exclusion.
    await seed(["clone", "--quiet", remote, other])
    const elsewhere = gitIn(other)
    await elsewhere(["config", "user.email", "queue@yrd.test"])
    await elsewhere(["config", "user.name", "yrd"])
    for (const name of ["task/elsewhere", "preserve/elsewhere"]) {
      await elsewhere(["checkout", "--quiet", "-b", name, "origin/main"])
      writeFileSync(join(other, `${name.replaceAll("/", "-")}.txt`), `${name}\n`)
      await elsewhere(["add", "."])
      await dated(other, ago(hour / 2))(["commit", "--quiet", "-m", name])
      await elsewhere(["push", "--quiet", "origin", name])
    }
    const absent = (await elsewhere(["rev-parse", "task/elsewhere"])).trim()

    const read = await readQueue(git, "origin", "main", target)
    const derivation = ((await import("../src/index.ts")) as unknown as Readonly<Record<string, unknown>>)[
      "readDrafts"
    ] as ReadDrafts | undefined
    const calls: { command: string; input: string }[] = []
    const counted: Git = async (args, input) => {
      calls.push({ command: args[0] ?? "", input: input ?? "" })
      return git(args, input)
    }
    const draftsFor = async (since: Date | undefined) => {
      calls.length = 0
      const reading =
        derivation === undefined
          ? { dated: [], undated: [] }
          : await derivation(counted, read, { targetSha: target, ...(since === undefined ? {} : { since }) })
      return {
        batches: calls.map((call) => call.command),
        dated: reading.dated.map((draft) => ({ ...draft, committedAt: draft.committedAt?.toISOString() })),
        undated: reading.undated,
        walked: calls.find((call) => call.command === "rev-list")?.input.includes(old) ?? false,
      }
    }

    expect({
      all: await draftsFor(undefined),
      week: await draftsFor(ago(7 * 24 * hour)),
    }).toEqual({
      all: {
        batches: ["cat-file", "log", "rev-list"],
        dated: [
          {
            author: "grace",
            branch: "task/moved",
            committedAt: ago(30 * 60_000).toISOString(),
            head: moved,
            movedSinceSubmit: true,
          },
          {
            author: "ada",
            branch: "task/recent",
            committedAt: ago(hour).toISOString(),
            head: recent,
            movedSinceSubmit: false,
          },
          {
            author: "yrd",
            branch: "task/old",
            committedAt: ago(10 * 24 * hour).toISOString(),
            head: old,
            movedSinceSubmit: false,
          },
        ],
        undated: [{ branch: "task/elsewhere", head: absent, movedSinceSubmit: false }],
        walked: true,
      },
      week: {
        batches: ["cat-file", "log", "rev-list"],
        dated: [
          {
            author: "grace",
            branch: "task/moved",
            committedAt: ago(30 * 60_000).toISOString(),
            head: moved,
            movedSinceSubmit: true,
          },
          {
            author: "ada",
            branch: "task/recent",
            committedAt: ago(hour).toISOString(),
            head: recent,
            movedSinceSubmit: false,
          },
        ],
        undated: [{ branch: "task/elsewhere", head: absent, movedSinceSubmit: false }],
        walked: false,
      },
    })
  })
})
