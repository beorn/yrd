/**
 * @reach fs-walk <fixture-only: a temporary bare remote and a real author clone with an issues.yml>
 * @failure A `Closes:` trailer closes its issue although the commit carrying it was undone again inside the same
 *          landing (the cdde7969 shape: hh's hab1 firewall was false-closed), and no merged event names the trailer
 *          commit or the commit that took its change back.
 * @level l2 (the real `yrd queue up` service against a bare remote and an issues.yml provider)
 * @consumer Yrd post-merge closer deciding whether a closing trailer survived its own landing (hh 38978)
 * @testonly none
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { safeRemoveSync } from "removely"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import type { IssueEventLaunch, IssueEventLaunchInput } from "../src/issue-event-edge.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { createEventStore, createEventQueue, readConfig, submit } from "@yrd/queue-core"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
})

const fakeProvider = join(import.meta.dirname, "support", "fake-issues-provider.ts")

/** One queue on a bare remote, an author clone, and a provider that logs each close key. */
const world = async () => {
  const root = mkdtempSync(join(tmpdir(), "yrd-38978-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "author")
  const workdir = join(root, "queue")
  mkdirSync(workdir)
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  const closeCalls = join(root, "close-calls.jsonl")
  await git(["config", "user.email", "provider@yrd.test"])
  await git(["config", "user.name", "fixture"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, ".yrd.yml"), JSON.stringify({}))
  writeFileSync(
    join(repo, "issues.yml"),
    JSON.stringify({
      resolve: [process.execPath, fakeProvider, "resolve", "<raw>"],
      // The placeholders a write verb carries: <key> <reason> <id>; the call log is the test's evidence.
      close: [
        "sh",
        "-c",
        'printf "%s\\t%s\\n" "$1" "$3" >> "$4"; printf \'{"applied":true}\\n\'',
        "close",
        "<key>",
        "<reason>",
        "<id>",
        closeCalls,
      ],
      // Declared so a merged event is writable at all; the launcher below is what records it here.
      event: ["sh", "-c", "exit 0", "event", "<kind>", "<raw>", "<source>", "<text>", "<id>"],
    }),
  )
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { remote: "origin", branch: "main" })
  if (config === undefined) throw new Error("fixture queue lost config")
  const store = createEventStore(repo, "origin", git.selection)
  await createEventQueue(store, "main", target, config, new Date())
  const queue = async (branch: string) => {
    await git(["checkout", "--quiet", "-b", branch, "origin/main"])
    return branch
  }
  return { root, repo, workdir, git, closeCalls, queue, store }
}

const closedKeys = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("\t")[0] as string)
    : []

/**
 * @cto ea5c5f52: a path with a glob character is a literal path here. Without `--literal-pathspecs` the trailer
 * commit's `rules[1].txt` would read as a glob matching the surviving `rules1.txt`, the net diff would look non-empty
 * and the reverted change would close an issue it never delivered.
 */
it("reads a path with a glob character as a literal path", async () => {
  const { repo, workdir, git, closeCalls, queue } = await world()
  const launches: IssueEventLaunchInput[] = []
  const capture = (input: IssueEventLaunchInput): IssueEventLaunch => {
    launches.push(input)
    return { launched: true, log: `${input.workdir}/logs/issue-events/${input.opId}.log` }
  }
  await queue("task/glob")
  writeFileSync(join(repo, "rules[1].txt"), "the change that is later taken back\n")
  await git(["add", "rules[1].txt"])
  await git(["commit", "--quiet", "-m", "feat: a ruleset with a bracketed name\n\nCloses: issue-glob"])
  const trailerCommit = (await git(["rev-parse", "HEAD"])).trim()
  await git(["rm", "--quiet", "rules[1].txt"])
  await git(["commit", "--quiet", "-m", "fix: take the bracketed ruleset out\n\nRefs: issue-glob"])
  const superseding = (await git(["rev-parse", "HEAD"])).trim()
  // The decoy: a surviving file the glob would match if the path were not literal.
  writeFileSync(join(repo, "rules1.txt"), "survives\n")
  await git(["add", "rules1.txt"])
  await git(["commit", "--quiet", "-m", "docs: the surviving sibling"])
  await submit(git, "origin", {
    branch: "task/glob",
    submitter: "fixture",
    target: { remote: "origin", branch: "main" },
  })
  await git(["checkout", "--quiet", "main"])

  const stop = new AbortController()
  const merged: string[] = []
  const diagnostics: string[] = []
  try {
    expect(
      await coreQueueCommand(
        repo,
        {
          cwd: repo,
          stdout: (line) => diagnostics.push(line),
          stderr: (line) => diagnostics.push(line),
          localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
        },
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          afterRound: async (outcome) => {
            merged.push(...outcome.merged)
            if (!merged.includes("task/glob")) return
            await vi.waitFor(() => expect(launches.some((launch) => launch.opId.includes("superseded"))).toBe(true), {
              timeout: 20000,
            })
            stop.abort()
          },
        },
        { workdir, json: true, launchEvent: capture, projectRoot: repo },
      ),
      diagnostics.join(" "),
    ).toBe(0)
  } finally {
    stop.abort()
  }

  expect(closedKeys(closeCalls), "the glob-matching sibling does not keep a reverted change alive").toEqual([])
  const refused = launches.find((launch) => launch.issue === "issue-glob" && launch.opId.includes("superseded"))
  expect(refused).toBeDefined()
  expect(refused?.text).toContain(trailerCommit.slice(0, 12))
  expect(refused?.text).toContain(superseding.slice(0, 12))
}, 180_000)

/**
 * AC2: a branch or env issue link records a merged event at most. It is never closing intent, whatever the merge
 * commit's own `Issue:` header says.
 */
it("records a bound issue as a merged event and never closes it", async () => {
  const { repo, workdir, git, closeCalls, queue } = await world()
  const launches: IssueEventLaunchInput[] = []
  const capture = (input: IssueEventLaunchInput): IssueEventLaunch => {
    launches.push(input)
    return { launched: true, log: `${input.workdir}/logs/issue-events/${input.opId}.log` }
  }
  await queue("task/bound")
  writeFileSync(join(repo, "bound.txt"), "work with no closing trailer\n")
  await git(["add", "bound.txt"])
  await git(["commit", "--quiet", "-m", "docs: work bound to an issue, and no trailer"])
  await submit(git, "origin", {
    branch: "task/bound",
    submitter: "fixture",
    issue: "issue-bound",
    target: { remote: "origin", branch: "main" },
  })
  await git(["checkout", "--quiet", "main"])

  const stop = new AbortController()
  const merged: string[] = []
  const diagnostics: string[] = []
  try {
    expect(
      await coreQueueCommand(
        repo,
        {
          cwd: repo,
          stdout: (line) => diagnostics.push(line),
          stderr: (line) => diagnostics.push(line),
          localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
        },
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          afterRound: async (outcome) => {
            merged.push(...outcome.merged)
            if (!merged.includes("task/bound")) return
            await vi.waitFor(() => expect(launches.length).toBeGreaterThan(0), { timeout: 20000 })
            stop.abort()
          },
        },
        { workdir, json: true, launchEvent: capture, projectRoot: repo },
      ),
      diagnostics.join(" "),
    ).toBe(0)
  } finally {
    stop.abort()
  }

  expect(closedKeys(closeCalls), "a binding never closes").toEqual([])
  expect(launches.map((launch) => launch.issue)).toContain("issue-bound")
  expect(launches.every((launch) => launch.opId.includes("superseded") === false)).toBe(true)
}, 180_000)

/**
 * @cto 5db8edbf: an empty trailer commit carries no paths of its own, so the whole landing's net diff decides —
 * non-empty closes, empty does not.
 */
it("decides an empty trailer commit by the whole landing's net diff", async () => {
  const { repo, workdir, git, closeCalls, queue } = await world()
  const launches: IssueEventLaunchInput[] = []
  const capture = (input: IssueEventLaunchInput): IssueEventLaunch => {
    launches.push(input)
    return { launched: true, log: `${input.workdir}/logs/issue-events/${input.opId}.log` }
  }
  // A landing with a real change: the empty commit's trailer closes.
  await queue("task/empty-ok")
  await git(["commit", "--quiet", "--allow-empty", "-m", "hold nothing but the trailer\n\nCloses: issue-empty-ok"])
  writeFileSync(join(repo, "real-change.txt"), "real\n")
  await git(["add", "real-change.txt"])
  await git(["commit", "--quiet", "-m", "docs: the real change this landing carries"])
  await submit(git, "origin", {
    branch: "task/empty-ok",
    submitter: "fixture",
    target: { remote: "origin", branch: "main" },
  })
  await git(["checkout", "--quiet", "main"])
  // A landing that changes nothing: the same shape, and the trailer closes nothing.
  await queue("task/empty-bare")
  await git(["commit", "--quiet", "--allow-empty", "-m", "hold nothing at all\n\nCloses: issue-empty-bare"])
  await submit(git, "origin", {
    branch: "task/empty-bare",
    submitter: "fixture",
    target: { remote: "origin", branch: "main" },
  })
  await git(["checkout", "--quiet", "main"])

  const stop = new AbortController()
  const merged: string[] = []
  const diagnostics: string[] = []
  try {
    expect(
      await coreQueueCommand(
        repo,
        {
          cwd: repo,
          stdout: (line) => diagnostics.push(line),
          stderr: (line) => diagnostics.push(line),
          localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
        },
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          afterRound: async (outcome) => {
            merged.push(...outcome.merged)
            if (!merged.includes("task/empty-ok") || !merged.includes("task/empty-bare")) return
            await vi.waitFor(() => expect(closedKeys(closeCalls)).toContain("issue-empty-ok"), { timeout: 20000 })
            await vi.waitFor(() => expect(launches.some((launch) => launch.opId.includes("superseded"))).toBe(true), {
              timeout: 20000,
            })
            stop.abort()
          },
        },
        { workdir, json: true, launchEvent: capture, projectRoot: repo },
      ),
      diagnostics.join(" "),
    ).toBe(0)
  } finally {
    stop.abort()
  }

  expect(closedKeys(closeCalls), "a landing with a real change still closes").toEqual(["issue-empty-ok"])
  const refused = launches.find((launch) => launch.issue === "issue-empty-bare" && launch.opId.includes("superseded"))
  expect(refused, "the empty landing still leaves one named event").toBeDefined()
  expect(refused?.text).toContain("the landing itself changed nothing")
}, 180_000)

it("leaves an issue open when its closing trailer's change did not survive the landing", async () => {
  const { repo, workdir, git, closeCalls, queue } = await world()
  const launches: IssueEventLaunchInput[] = []
  const capture = (input: IssueEventLaunchInput): IssueEventLaunch => {
    launches.push(input)
    return { launched: true, log: `${input.workdir}/logs/issue-events/${input.opId}.log` }
  }
  // The cdde7969 shape: a binding commit names the issue, the next commit adds the work with `Closes:`, an unrelated
  // commit after it deletes that work again, and a final commit carries the branch's real change.
  await queue("task/superseded")
  writeFileSync(join(repo, "seed.txt"), "seed\n")
  await git(["add", "seed.txt"])
  await git(["commit", "--quiet", "-m", "Bind work to issue-super\n\nRefs: issue-super"])
  writeFileSync(join(repo, "firewall.rules"), "open ssh to the world\n")
  await git(["add", "firewall.rules"])
  await git(["commit", "--quiet", "-m", "feat: the firewall, first attempt\n\nCloses: issue-super"])
  const trailerCommit = (await git(["rev-parse", "HEAD"])).trim()
  await git(["rm", "--quiet", "firewall.rules"])
  await git(["commit", "--quiet", "-m", "fix: the firewall is Rig's, take the first attempt out\n\nRefs: issue-super"])
  const superseding = (await git(["rev-parse", "HEAD"])).trim()
  writeFileSync(join(repo, "inventory.md"), "the tools inventory catches up\n")
  await git(["add", "inventory.md"])
  await git(["commit", "--quiet", "-m", "docs: the inventory catches up"])
  await submit(git, "origin", {
    branch: "task/superseded",
    submitter: "fixture",
    target: { remote: "origin", branch: "main" },
  })
  await git(["checkout", "--quiet", "main"])

  // The control: the same trailer on a commit whose change IS the landing.
  await queue("task/control")
  writeFileSync(join(repo, "kept.txt"), "kept\n")
  await git(["add", "kept.txt"])
  await git(["commit", "--quiet", "-m", "feat: work that lands and stays\n\nCloses: issue-control"])
  await submit(git, "origin", {
    branch: "task/control",
    submitter: "fixture",
    target: { remote: "origin", branch: "main" },
  })
  await git(["checkout", "--quiet", "main"])

  const stop = new AbortController()
  const merged: string[] = []
  const diagnostics: string[] = []
  try {
    expect(
      await coreQueueCommand(
        repo,
        {
          cwd: repo,
          stdout: (line) => diagnostics.push(line),
          stderr: (line) => diagnostics.push(line),
          localBranchProtections: async () => ({ protections: ["fixture hold"], evidence: [] }),
        },
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          afterRound: async (outcome) => {
            merged.push(...outcome.merged)
            if (!merged.includes("task/superseded") || !merged.includes("task/control")) return
            await vi.waitFor(
              () => {
                expect(closedKeys(closeCalls), diagnostics.join(" ")).toEqual(["issue-control"])
              },
              { timeout: 20000 },
            )
            // The superseded trailer's own event is launched by the closer; the control's merged event is separate.
            await vi.waitFor(() => expect(launches.some((launch) => launch.issue === "issue-super")).toBe(true), {
              timeout: 20000,
            })
            stop.abort()
          },
        },
        { workdir, json: true, launchEvent: capture, projectRoot: repo },
      ),
      diagnostics.join(" "),
    ).toBe(0)
  } finally {
    stop.abort()
  }

  expect(closedKeys(closeCalls), "only the surviving trailer closes").toEqual(["issue-control"])
  const supersededEvent = launches.find(
    (launch) => launch.issue === "issue-super" && launch.opId.includes("superseded"),
  )
  expect(supersededEvent, "the superseded trailer still leaves one merged event").toBeDefined()
  expect(supersededEvent?.kind).toBe("merged")
  expect(supersededEvent?.opId).toContain("superseded")
  expect(supersededEvent?.text, "the event names the trailer commit").toContain(trailerCommit.slice(0, 12))
  expect(supersededEvent?.text, "the event names the commit that took it back").toContain(superseding.slice(0, 12))
  expect(supersededEvent?.text).toContain("did not survive this landing")
  expect(diagnostics.join(" ")).toContain("did not survive this landing")
  expect(merged).toEqual(expect.arrayContaining(["task/superseded", "task/control"]))
}, 180_000)
