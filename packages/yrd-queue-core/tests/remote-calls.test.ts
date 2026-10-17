/**
 * @failure The fleet's GitHub logins were refused in bursts (25282) and nobody could say how many remote calls one
 *          round or one submit made: yrd's journal saw only its own Git rows, never Gitomic's reads or git-super's
 *          children, and no row counted SSH logins (25570 row 3).
 * @level   l2 (real git processes writing git's own trace2 event log; a stand-in ssh that runs upload-pack locally)
 * @consumer the round's `remote-calls` journal row and submit's stderr summary
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { createLegacyBackend, invokeGit, readRemoteCommit } from "../src/git.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { readComponentMain } from "../src/reference.ts"
import {
  DERIVE_COMPONENT_MAIN_SEAM,
  readRemoteCalls,
  roundRemoteCallsRow,
  traceRemoteCalls,
  withRemoteSeam,
} from "../src/remote-calls.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

describe("remote calls are counted from git's trace2 event log", () => {
  it("counts each remote verb once per process and each ssh transport as a login", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-remote-calls-"))
    roots.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    const git = gitIn(seed)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git([
      "-c",
      "user.email=calls@yrd.test",
      "-c",
      "user.name=yrd",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "one",
    ])
    const remote = join(root, "remote.git")
    await gitIn(root)(["clone", "--quiet", "--bare", seed, remote])
    // An ssh that runs the remote command here: git still classifies the child as transport/ssh.
    const ssh = join(root, "fake-ssh")
    writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
    chmodSync(ssh, 0o755)
    const trace = join(root, "trace2")
    mkdirSync(trace)
    const traced = gitIn(root, undefined, undefined, {
      env: { ...process.env, GIT_TRACE2_EVENT: trace, GIT_SSH_COMMAND: ssh },
    })

    await traced(["ls-remote", `ssh://calls.invalid${remote}`, "refs/heads/main"])
    await traced(["-C", seed, "fetch", "--quiet", "--no-tags", `ssh://calls.invalid${remote}`, "refs/heads/main"])
    await traced(["-C", seed, "fetch", "--quiet", "--no-tags", remote, "refs/heads/main"])
    await traced(["rev-parse", "--git-dir"]).catch(() => "")

    const calls = readRemoteCalls(trace)
    expect(calls.verbs).toEqual({ fetch: 2, "ls-remote": 1 })
    expect(calls.sshChildren).toBe(2)
    expect(calls.remoteMs).toBeGreaterThan(0)
    expect(calls.unreadable).toBe(0)
    expect(calls.processes).toBeGreaterThanOrEqual(4)
  }, 60_000)

  /** @failure Bare Git reads omitted repository identity, so the round could not prove its SSH split (26282).
   * @level l2: real Git's bare discovery and Gitomic's explicit git-directory invocation.
   * @consumer the round's durable refresh/beyond-refresh counts; no test-only production seam.
   */
  it.each([
    ["configured origin", "working"],
    ["captured URL", "working"],
    ["configured origin", "bare"],
    ["captured URL", "git-dir"],
    ["configured origin", "git-dir-equals"],
  ])(
    "keeps a proven refresh split for %s in %s after Trace2 is removed (26232, 26282)",
    async (source, mode) => {
      const root = mkdtempSync(join(tmpdir(), "yrd-round-refresh-"))
      roots.push(root)
      const seed = join(root, "seed")
      mkdirSync(seed)
      const git = gitIn(seed)
      await git(["init", "--quiet", "--initial-branch=main"])
      await git([
        "-c",
        "user.email=calls@yrd.test",
        "-c",
        "user.name=yrd",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "one",
      ])
      const remote = join(root, "remote.git")
      await gitIn(root)(["clone", "--quiet", "--bare", seed, remote])
      const repository = mode === "working" ? seed : join(root, "mirror.git")
      if (mode !== "working") await gitIn(root)(["clone", "--quiet", "--bare", seed, repository])
      const prefix =
        mode === "git-dir" ? ["--git-dir", repository] : mode === "git-dir-equals" ? [`--git-dir=${repository}`] : []
      const caller = (env: NodeJS.ProcessEnv) => {
        const invoke = gitIn(repository, undefined, undefined, { env })
        return (args: string[]) => invoke([...prefix, ...args])
      }
      const ssh = join(root, "fake-ssh")
      writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
      chmodSync(ssh, 0o755)
      const trace = traceRemoteCalls(join(root, "trace2"), { refresh: true })
      const base = { ...process.env, ...trace.env, GIT_SSH_COMMAND: ssh }
      const url = `ssh://calls.invalid${remote}`
      const selected = source === "captured URL" ? url : "origin"
      await gitIn(repository)(["remote", mode === "working" ? "add" : "set-url", "origin", url])
      await caller({ ...base, GIT_SUPER_PHASE: "refresh" })([
        "fetch",
        "--no-tags",
        selected,
        "+refs/heads/main:refs/remotes/origin/main",
      ])
      await caller(base)(["ls-remote", url, "refs/heads/main"])
      const row = roundRemoteCallsRow(trace.end())
      expect(row).toMatchObject({
        ssh_children: 2,
        refresh_ssh_children: 1,
        beyond_refresh_ssh_children: 1,
        unreadable: 0,
      })
      expect(row.refresh_calls).toEqual([`1 fetch @ ${repository}`])
      expect(row.beyond_refresh_calls).toEqual([`1 ls-remote @ ${repository}`])
      expect(existsSync(join(root, "trace2"))).toBe(false)

      // An older git-super still makes the same refresh fetch but cannot mark it. The split is unproven, and
      // 29730 (@cto 316f70ff R1) journals that as a row carrying its counts: never a plausible zero, and never
      // no row at all, which is what this used to be when the throw came out of end() inside the row write.
      const oldTrace = traceRemoteCalls(join(root, "old-trace2"), { refresh: true })
      await caller({ ...process.env, ...oldTrace.env, GIT_SSH_COMMAND: ssh })([
        "fetch",
        "--no-tags",
        selected,
        "+refs/heads/main:refs/remotes/origin/main",
      ])
      const oldRow = roundRemoteCallsRow(oldTrace.end())
      expect(oldRow).toMatchObject({ ssh_split: "unproven", ssh_children: 1, fetch: 1, unreadable: 0 })
      expect(String(oldRow.ssh_split_reason)).toMatch(/untagged component-main refresh fetch/u)
      // The whole key set (@cto 1ce8f965, fold 4): an unproven row carries its counts and its reason, and NO
      // split field at all - asserting three absences let every other split field slip through unasserted.
      expect(Object.keys(oldRow).sort()).toEqual([
        "fetch",
        "processes",
        "remote_ms",
        "seam.unattributed.fetch",
        "seam.unattributed.remote_ms",
        "seam.unattributed.ssh_children",
        "ssh_children",
        "ssh_split",
        "ssh_split_reason",
        "unreadable",
      ])
      expect(existsSync(join(root, "old-trace2"))).toBe(false)

      // Submit observes the same Git call but has no round refresh boundary.
      const submitTrace = traceRemoteCalls(join(root, "submit-trace2"), { seams: true })
      await caller({ ...process.env, ...submitTrace.env, GIT_SSH_COMMAND: ssh })([
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ])
      expect(submitTrace.end().sshChildren).toBe(1)
    },
    60_000,
  )

  const roundFixture = async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-round-unproven-"))
    roots.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    const git = gitIn(seed)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git([
      "-c",
      "user.email=calls@yrd.test",
      "-c",
      "user.name=yrd",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "one",
    ])
    const remote = join(root, "remote.git")
    await gitIn(root)(["clone", "--quiet", "--bare", seed, remote])
    const ssh = join(root, "fake-ssh")
    writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
    chmodSync(ssh, 0o755)
    const url = `ssh://calls.invalid${remote}`
    await gitIn(seed)(["remote", "add", "origin", url])
    return { root, seed, remote, ssh, url }
  }

  /**
   * @failure 29730 R1 (@cto 316f70ff): the guard's proof ran inside the row write, so a round that tripped it
   *          journaled no remote-calls row at all and lost every count it had measured. A trip keeps the row,
   *          its counts, and says in its own text that the split is unproven.
   * @level   l2 (real git processes writing git's own trace2 event log; a stand-in ssh that runs upload-pack locally)
   * @consumer the round's remote-calls journal row
   */
  it("journals the round's own untagged component-main read as a row with its counts and an unproven split", async () => {
    const { root, seed, ssh } = await roundFixture()
    const caller = (env: NodeJS.ProcessEnv) => gitIn(seed, undefined, undefined, { env })
    const untagged = traceRemoteCalls(join(root, "untagged-trace2"), { refresh: true, seams: true })
    await caller({ ...process.env, ...untagged.env, GIT_SSH_COMMAND: ssh })([
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ])
    const untaggedRow = roundRemoteCallsRow(untagged.end())
    // The whole key set, so an unproven split can never carry a split field that reads as a measured zero.
    expect(Object.keys(untaggedRow).sort()).toEqual([
      "fetch",
      "processes",
      "remote_ms",
      "seam.unattributed.fetch",
      "seam.unattributed.remote_ms",
      "seam.unattributed.ssh_children",
      "ssh_children",
      "ssh_split",
      "ssh_split_reason",
      "unreadable",
    ])
    expect(untaggedRow).toMatchObject({ ssh_split: "unproven", ssh_children: 1, fetch: 1, unreadable: 0 })
    expect(String(untaggedRow.ssh_split_reason)).toMatch(/untagged component-main refresh fetch/u)
  }, 60_000)

  /**
   * @failure 29730 R2 (@cto 316f70ff): a refresh tag on a call that is not component-main-shaped must never be
   *          absorbed as a refresh. The split is proven by a positive marker ON the shape it names.
   * @level   l2 (real git processes writing git's own trace2 event log; a stand-in ssh that runs upload-pack locally)
   * @consumer roundRemoteCallsRow's unproven arm
   */
  it("reports unproven, never refresh, when a refresh tag rides a call that is not component-main-shaped", async () => {
    const { root, seed, ssh, url } = await roundFixture()
    const caller = (env: NodeJS.ProcessEnv) => gitIn(seed, undefined, undefined, { env })
    const mistagged = traceRemoteCalls(join(root, "mistagged-trace2"), { refresh: true, seams: true })
    await caller({ ...process.env, ...mistagged.env, GIT_SSH_COMMAND: ssh, GIT_SUPER_PHASE: "refresh" })([
      "ls-remote",
      url,
      "refs/heads/main",
    ])
    const mistaggedRow = roundRemoteCallsRow(mistagged.end())
    expect(mistaggedRow).toMatchObject({ ssh_split: "unproven", ssh_children: 1, "ls-remote": 1 })
    expect(String(mistaggedRow.ssh_split_reason)).toMatch(/tagged a non-component-main SSH call as refresh/u)
    // The whole key set (@cto 1ce8f965, fold 4), not a sample: a mistagged call keeps its counts, its seam row
    // and its reason, and gains none of the split fields it did not earn.
    expect(Object.keys(mistaggedRow).sort()).toEqual([
      "ls-remote",
      "processes",
      "remote_ms",
      "seam.unattributed.ls-remote",
      "seam.unattributed.remote_ms",
      "seam.unattributed.ssh_children",
      "ssh_children",
      "ssh_split",
      "ssh_split_reason",
      "unreadable",
    ])
  }, 60_000)

  /**
   * @failure 29730 R2 (@cto 316f70ff, fold 1): yrd's own component-main read carries no git-super marker, so the
   *          classifier proves it by the round's own seam. This drives the PRODUCTION call under a caller's
   *          wider seam, so deleting the production seam changes this row instead of leaving it green.
   * @level   l2 (real git processes writing git's own trace2 event log; a stand-in ssh that runs upload-pack locally)
   * @consumer roundRemoteCallsRow's derive bucket
   */
  it("proves the round's own component-main read through readComponentMain under a caller's wider seam", async () => {
    const { root, seed, ssh, url } = await roundFixture()
    const store = join(root, "store.git")
    await gitIn(root)(["init", "--bare", "--quiet", store])
    await gitIn(store)(["remote", "add", "origin", url])
    const expected = (await gitIn(seed)(["rev-parse", "HEAD"])).trim()
    const named = traceRemoteCalls(join(root, "named-trace2"), { refresh: true, seams: true })
    const env = { ...process.env, ...named.env, GIT_SSH_COMMAND: ssh }
    const main = await withRemoteSeam("compose", () =>
      readComponentMain(
        (cwd) => gitIn(cwd, undefined, undefined, { env }),
        store,
        () => {},
      ),
    )
    const namedRow = roundRemoteCallsRow(named.end())
    expect(main).toBe(expected)
    expect(namedRow).toMatchObject({
      ssh_children: 1,
      refresh_ssh_children: 0,
      derive_ssh_children: 1,
      beyond_refresh_ssh_children: 0,
      unreadable: 0,
    })
    expect(namedRow.ssh_split).toBeUndefined()
    expect(namedRow.derive_calls).toEqual([`1 fetch @ ${store}`])
    expect(namedRow.refresh_calls).toEqual([])
    expect(namedRow.beyond_refresh_calls).toEqual([])
    expect(namedRow.derive_boundary).toBe(`YRD_SEAM=${DERIVE_COMPONENT_MAIN_SEAM} on component-main fetch`)
    // The seam also names the read in the ordinary seam row, so its cost is measurable beside the rest.
    expect(namedRow[`seam.${DERIVE_COMPONENT_MAIN_SEAM}.fetch`]).toBe(1)
  }, 60_000)

  it("names an SSH clone even when Git has not defined its destination repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-round-clone-"))
    roots.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    const git = gitIn(seed)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git([
      "-c",
      "user.email=calls@yrd.test",
      "-c",
      "user.name=yrd",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "one",
    ])
    const remote = join(root, "remote.git")
    await gitIn(root)(["clone", "--quiet", "--bare", seed, remote])
    const ssh = join(root, "fake-ssh")
    writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
    chmodSync(ssh, 0o755)
    for (const [label, source] of [
      ["uri", `ssh://calls.invalid${remote}`],
      ["scp", `git@calls.invalid:${remote}`],
    ] as const) {
      const trace = traceRemoteCalls(join(root, `trace2-${label}`), { refresh: true })
      await gitIn(root, undefined, undefined, {
        env: { ...process.env, ...trace.env, GIT_SSH_COMMAND: ssh },
      })(["clone", "--quiet", "--bare", source, join(root, `target-${label}.git`)])

      expect(roundRemoteCallsRow(trace.end())).toMatchObject({
        ssh_children: 1,
        refresh_ssh_children: 0,
        beyond_refresh_ssh_children: 1,
        beyond_refresh_calls: [`1 clone @ ${source}`],
      })
    }
  }, 60_000)

  it("removes its trace directory once it has counted it, so no round leaves its trace2 log behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-remote-calls-removed-"))
    roots.push(root)
    const directory = join(root, "logs", "round", "trace2")
    const traced = traceRemoteCalls(directory)
    await gitIn(root, undefined, undefined, { env: { ...process.env, ...traced.env } })([
      "init",
      "-q",
      join(root, "repo"),
    ])
    expect(traced.end().processes).toBeGreaterThanOrEqual(1)
    expect(existsSync(directory)).toBe(false)

    // A trace that cannot be read is still removed: the count failing is reported, the directory never kept.
    const unread = traceRemoteCalls(join(root, "unread", "trace2"))
    rmSync(join(root, "unread", "trace2"), { recursive: true })
    expect(() => unread.end()).toThrow(/trace2 directory/u)
    expect(existsSync(join(root, "unread", "trace2"))).toBe(false)
  })

  /** @failure Candidate composition bypassed gitIn's label overlay and left 16 SSH children unlabelled (26292).
   * @level l2: direct supervised Git invocation and SSH child events, using a local upload-pack transport.
   * @consumer submit's operation groups; no test-only production seam.
   * @testonly none
   */
  it("attributes Git, Gitomic and direct supervised reads to their calling seams (25626, 26292)", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-remote-seams-"))
    roots.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    const git = gitIn(seed)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git([
      "-c",
      "user.email=seams@yrd.test",
      "-c",
      "user.name=yrd",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "one",
    ])
    const remote = join(root, "remote.git")
    await gitIn(root)(["clone", "--quiet", "--bare", seed, remote])
    const traced = traceRemoteCalls(join(root, "trace2"), { seams: true })
    const caller = gitIn(seed, undefined, undefined, { env: { ...process.env, ...traced.env } })
    expect(await withRemoteSeam("readRemoteCommit", () => readRemoteCommit(caller, remote, "refs/heads/main"))).toMatch(
      /^[0-9a-f]{40}$/u,
    )
    await withRemoteSeam("listBranch", () => caller(["ls-remote", remote, "refs/heads/main"]))
    const ssh = join(root, "fake-ssh")
    writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
    chmodSync(ssh, 0o755)
    const composeEnv = {
      ...process.env,
      ...traced.env,
      GIT_SSH_COMMAND: ssh,
    }
    await using runner = createProcess({ cwd: seed, env: composeEnv })
    const composed = await withRemoteSeam("composeSubmit", () =>
      invokeGit(
        runner,
        { cwd: seed, args: ["ls-remote", `ssh://seams.invalid${remote}`, "refs/heads/main"] },
        {},
        composeEnv,
        undefined,
      ),
    )
    expect(composed.failure).toBeUndefined()
    expect(composed.result?.exitCode, composed.result?.stderr).toBe(0)
    expect(composeEnv).not.toHaveProperty("YRD_SEAM")
    await caller(["ls-remote", remote, "refs/heads/main"])
    const calls = traced.end()
    expect(calls.seams).toMatchObject({
      readRemoteCommit: { fetch: 1 },
      listBranch: { "ls-remote": 1 },
      composeSubmit: { "ls-remote": 1, ssh_children: 1 },
    })
    expect(calls.seams.unattributed).toMatchObject({ "ls-remote": 1 })
    expect(calls.unreadable).toBe(0)
  })

  it("labels a child at the spawn, never at runner or store creation (29697, @cto R1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-remote-seam-spawn-"))
    roots.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    const git = gitIn(seed)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git([
      "-c",
      "user.email=spawn@yrd.test",
      "-c",
      "user.name=yrd",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "one",
    ])
    const remote = join(root, "remote.git")
    await gitIn(root)(["clone", "--quiet", "--bare", seed, remote])
    const traced = traceRemoteCalls(join(root, "trace2"), { seams: true })
    const creationEnv = { ...process.env, ...traced.env }
    // A runner created INSIDE a labelled step must not carry that step's name in what it was created with: a
    // later call through it, made after the step ended, would otherwise spawn a caller that did not make it.
    const created = withRemoteSeam("compose", () => gitIn(seed, undefined, undefined, { env: creationEnv }))
    // No assertion on `creationEnv` itself (29697, @cto R2): gitIn copies the options it is handed
    // (git.ts `{ ...(options.env ?? globalThis.process.env) }`), so reading the caller's own literal back is
    // unmutated whatever the spawn does — it passed on revert and proved nothing. The spawn rule is what the two
    // calls below measure: the same runner's child is unattributed outside a step, and `compose` inside one.
    // Outside every step the same runner's child carries no label at all.
    await created(["ls-remote", remote, "refs/heads/main"])
    // Inside a step it carries that step's name, which is the whole point of labelling at the spawn.
    await withRemoteSeam("compose", () => created(["ls-remote", remote, "refs/heads/main"]))
    const calls = traced.end()
    expect(calls.seams).toMatchObject({ compose: { "ls-remote": 1 }, unattributed: { "ls-remote": 1 } })
  })

  it("labels each fetch on one long-lived Gitomic backend with its calling seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-gitomic-seams-"))
    roots.push(root)
    const seed = join(root, "seed")
    mkdirSync(seed)
    const git = gitIn(seed)
    await git(["init", "--quiet", "--initial-branch=main"])
    await git([
      "-c",
      "user.email=seams@yrd.test",
      "-c",
      "user.name=yrd",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "one",
    ])
    const remote = join(root, "remote.git")
    await gitIn(root)(["clone", "--quiet", "--bare", seed, remote])
    const traced = traceRemoteCalls(join(root, "trace2"), { seams: true })
    const backend = createLegacyBackend()
    const store = (await git(["rev-parse", "--absolute-git-dir"])).trim()
    if (backend.fetchRefs === undefined) throw new Error("Gitomic backend lacks fetchRefs")
    await withRemoteSeam("firstRead", () => backend.fetchRefs!(store, "refs/heads/main", remote))
    await withRemoteSeam("secondRead", () => backend.fetchRefs!(store, "refs/heads/main", remote))
    const calls = traced.end()
    expect(calls.seams.firstRead?.fetch).toBe(1)
    expect(calls.seams.secondRead?.fetch).toBe(1)
    expect(calls.seams.unattributed).toBeUndefined()
  })

  /** @failure Missing trace or process identity must not satisfy a round SSH-count check (26282).
   * @level l0: incomplete native event shapes at the count consumer.
   * @consumer roundRemoteCallsRow's named unknown-data warning; no test-only production seam.
   */
  it("refuses missing trace or process identity, rather than reporting zero calls", () => {
    expect(() => readRemoteCalls(join(tmpdir(), "yrd-remote-calls-absent-25570"))).toThrow(/trace2 directory/u)
    const directory = mkdtempSync(join(tmpdir(), "yrd-remote-calls-incomplete-"))
    roots.push(directory)
    for (const identity of [
      [
        { event: "start", argv: ["git", "ls-remote", "origin"] },
        { event: "def_repo", worktree: "/repo" },
      ],
      [
        { event: "start", argv: ["git", "ls-remote", "origin"] },
        { event: "cmd_name", name: "ls-remote" },
      ],
      [
        { event: "start", argv: ["git", "--git-dir=relative.git", "ls-remote", "origin"] },
        { event: "cmd_name", name: "ls-remote" },
      ],
    ]) {
      writeFileSync(
        join(directory, "process"),
        [...identity, { event: "child_start", child_class: "transport/ssh" }]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      )
      const calls = readRemoteCalls(directory)
      expect(calls.sshChildren).toBe(1)
      expect(() => roundRemoteCallsRow(calls)).toThrow(/transport child lacks its Git command or repository/u)
    }
  })

  /**
   * @failure 29730 fold 2 (@cto 5b4fb097): the derive seam is accepted by NAME, not by the presence of any seam.
   *          A caller's own name on a component-main-shaped fetch stays unproven, so loosening the equality to a
   *          mere presence check would move this row rather than passing it. This row asserts that only: the
   *          positive half - that the derive seam DOES prove the round's own read - is row (c)'s, which drives
   *          the production readComponentMain.
   * @level   l0 (synthetic trace2 events at the count consumer)
   * @consumer roundRemoteCallsRow's unproven arm
   */
  it("keeps a component-main fetch unproven under a caller's own seam", () => {
    const directory = mkdtempSync(join(tmpdir(), "yrd-round-seam-exact-"))
    roots.push(directory)
    writeFileSync(
      join(directory, "process"),
      [
        {
          event: "start",
          argv: ["git", "fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
        },
        { event: "def_repo", worktree: "/repo" },
        { event: "def_param", param: "YRD_SEAM", value: "compose" },
        { event: "cmd_name", name: "fetch" },
        { event: "child_start", child_class: "transport/ssh" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    )
    const row = roundRemoteCallsRow(readRemoteCalls(directory, { requireRefreshTag: true }))
    expect(Object.keys(row).sort()).toEqual([
      "fetch",
      "processes",
      "remote_ms",
      "seam.compose.fetch",
      "seam.compose.remote_ms",
      "seam.compose.ssh_children",
      "ssh_children",
      "ssh_split",
      "ssh_split_reason",
      "unreadable",
    ])
    expect(row.ssh_split).toBe("unproven")
    expect(String(row.ssh_split_reason)).toMatch(/untagged component-main refresh fetch/u)
  })

  /**
   * @failure 29730 fold 3 (@cto 5b4fb097): the mirror of the refresh trip, for the round's own name. A call
   *          carrying the derive seam that is not component-main-shaped has no business in the derive bucket —
   *          it reports unproven with its own reason rather than falling through as `beyond`.
   * @level   l0 (synthetic trace2 events at the count consumer)
   * @consumer roundRemoteCallsRow's unproven arm
   */
  it("reports unproven, never beyond, when the derive seam rides a call that is not component-main-shaped", () => {
    const directory = mkdtempSync(join(tmpdir(), "yrd-round-seam-mirror-"))
    roots.push(directory)
    writeFileSync(
      join(directory, "process"),
      [
        { event: "start", argv: ["git", "ls-remote", "origin", "refs/heads/main"] },
        { event: "def_repo", worktree: "/repo" },
        { event: "def_param", param: "YRD_SEAM", value: DERIVE_COMPONENT_MAIN_SEAM },
        { event: "cmd_name", name: "ls-remote" },
        { event: "child_start", child_class: "transport/ssh" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    )
    const row = roundRemoteCallsRow(readRemoteCalls(directory, { requireRefreshTag: true }))
    expect(Object.keys(row).sort()).toEqual([
      "ls-remote",
      "processes",
      "remote_ms",
      `seam.${DERIVE_COMPONENT_MAIN_SEAM}.ls-remote`,
      `seam.${DERIVE_COMPONENT_MAIN_SEAM}.remote_ms`,
      `seam.${DERIVE_COMPONENT_MAIN_SEAM}.ssh_children`,
      "ssh_children",
      "ssh_split",
      "ssh_split_reason",
      "unreadable",
    ])
    expect(row.ssh_split).toBe("unproven")
    expect(String(row.ssh_split_reason)).toMatch(/tagged a non-component-main SSH call as deriveComponentMain/u)
  })

  /**
   * @failure 29730 review (@cto 1ce8f965): a call wearing BOTH the refresh tag and the derive seam was counted
   *          as refresh by a tie-break nobody wrote down, so a contradictory call would have read as measured.
   *          No path builds one, and the row now says so in its own text instead of picking a bucket.
   * @level   l0 (synthetic trace2 events at the count consumer)
   * @consumer roundRemoteCallsRow's unproven arm
   */
  it("reports unproven when one component-main fetch wears both the refresh tag and the derive seam", () => {
    const directory = mkdtempSync(join(tmpdir(), "yrd-round-both-markers-"))
    roots.push(directory)
    writeFileSync(
      join(directory, "process"),
      [
        {
          event: "start",
          argv: ["git", "fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
        },
        { event: "def_repo", worktree: "/repo" },
        { event: "def_param", param: "GIT_SUPER_PHASE", value: "refresh" },
        { event: "def_param", param: "YRD_SEAM", value: DERIVE_COMPONENT_MAIN_SEAM },
        { event: "cmd_name", name: "fetch" },
        { event: "child_start", child_class: "transport/ssh" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    )
    const row = roundRemoteCallsRow(readRemoteCalls(directory, { requireRefreshTag: true }))
    expect(Object.keys(row).sort()).toEqual([
      "fetch",
      "processes",
      "remote_ms",
      `seam.${DERIVE_COMPONENT_MAIN_SEAM}.fetch`,
      `seam.${DERIVE_COMPONENT_MAIN_SEAM}.remote_ms`,
      `seam.${DERIVE_COMPONENT_MAIN_SEAM}.ssh_children`,
      "ssh_children",
      "ssh_split",
      "ssh_split_reason",
      "unreadable",
    ])
    expect(row.ssh_split).toBe("unproven")
    expect(String(row.ssh_split_reason)).toMatch(/both refresh and deriveComponentMain/u)
  })
})
