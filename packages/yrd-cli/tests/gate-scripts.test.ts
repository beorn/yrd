/**
 * @failure A change that edits its own gate script is admitted by the script it edited: `.yrd.yml` is read from the base ref while the scripts it names execute from the candidate tree, so the gate a reviewer trusts is candidate-controlled (23183).
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { failureFact } from "@yrd/core"
import { createProcess } from "@yrd/process"
import { overlayGateScripts } from "@yrd/queue"
import { createLogger } from "loggily"
import { createYrdHost as createYrdHostRaw } from "../src/host.ts"
import { parseYrdConfig } from "../src/config.ts"

const silentLog = createLogger("test", [{ level: "silent" }])
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function createYrdHost(options: Parameters<typeof createYrdHostRaw>[0] = {}) {
  return createYrdHostRaw({ ...options, log: options.log ?? silentLog })
}

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

/** The base's gate: refuse any candidate that carries `forbidden.txt`. A
 * change weakening this exact script is the attack 23183 closes. */
const BASE_GATE = '#!/usr/bin/env bash\nif [ -f forbidden.txt ]; then echo "forbidden file present" >&2; exit 1; fi\n'
const WEAKENED_GATE = "#!/usr/bin/env bash\nexit 0\n"

const GATED_CONFIG =
  'base: main\nbatch: 1\nchecks:\n  - {gate: {run: "bash tools/gate.sh", scripts: [tools/gate.sh]}}\n'

async function gatedRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-gate-scripts-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, ".yrd.yml"), GATED_CONFIG)
  await mkdir(join(repo, "tools"), { recursive: true })
  await writeFile(join(repo, "tools", "gate.sh"), BASE_GATE)
  await mkdir(join(repo, "bin"), { recursive: true })
  await writeFile(join(repo, "bin", "yrd"), "#!/usr/bin/env bun\n")
  await git(repo, "add", ".yrd.yml", "tools/gate.sh", "bin/yrd")
  await git(repo, "commit", "-qm", "gated queue config")
  return repo
}

async function branchWith(repo: string, name: string, files: Readonly<Record<string, string>>): Promise<string> {
  await git(repo, "switch", "-qc", name)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  await git(repo, "add", ".")
  await git(repo, "commit", "-qm", name)
  const sha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return sha
}

describe("config: per-check gate scripts", () => {
  it("parses declared scripts and refuses absolute paths, traversal, duplicates, and waiting runners", () => {
    const parsed = parseYrdConfig(
      Bun.YAML.parse('checks:\n  - {gate: {run: "bash tools/gate.sh", scripts: [tools/gate.sh, .githooks]}}\n'),
    )
    const gate = parsed.checks[0] as Readonly<Record<string, { scripts?: readonly string[] }>>
    expect(gate.gate?.scripts).toEqual(["tools/gate.sh", ".githooks"])
    for (const bad of [
      "scripts: [/etc/passwd]",
      "scripts: [../outside.sh]",
      "scripts: [tools/../../outside.sh]",
      "scripts: [tools/gate.sh, tools/gate.sh]",
      "scripts: []",
    ]) {
      expect(() => parseYrdConfig(Bun.YAML.parse(`checks:\n  - {gate: {run: "true", ${bad}}}\n`)), bad).toThrow()
    }
    expect(() =>
      parseYrdConfig(Bun.YAML.parse('checks:\n  - {gate: {run: "true", runner: waiting, scripts: [tools/gate.sh]}}\n')),
    ).toThrow(/only supported by the local runner/u)
  })
})

describe("overlayGateScripts", () => {
  it("pins declared paths to the base, handles adds and deletes both ways, and restores the candidate exactly", async () => {
    const repo = await gatedRepository()
    // Base also carries a file the candidate deletes, and the candidate adds
    // one the base never had — both under the declared directory.
    await writeFile(join(repo, "tools", "helper.sh"), "base helper\n")
    await git(repo, "add", "tools/helper.sh")
    await git(repo, "commit", "-qm", "base helper")
    const baseSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-qc", "issue/edit")
    await writeFile(join(repo, "tools", "gate.sh"), WEAKENED_GATE)
    await writeFile(join(repo, "tools", "added.sh"), "candidate addition\n")
    await git(repo, "rm", "-q", "tools/helper.sh")
    await git(repo, "add", "tools/gate.sh", "tools/added.sh")
    await git(repo, "commit", "-qm", "edit gate scripts")
    const candidateSha = await git(repo, "rev-parse", "HEAD")

    await using process = createProcess({ cwd: repo })
    const gitPort = {
      run: async (cwd: string, args: readonly string[]) => {
        const outcome = await process.run({ argv: ["git", "-C", cwd, ...args], cwd })
        return { code: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr }
      },
    }
    const overlay = await overlayGateScripts(gitPort, repo, baseSha, candidateSha, ["tools"])
    expect([...overlay.differing].toSorted()).toEqual(["tools/added.sh", "tools/gate.sh", "tools/helper.sh"])
    expect(await readFile(join(repo, "tools", "gate.sh"), "utf8")).toBe(BASE_GATE)
    expect(await readFile(join(repo, "tools", "helper.sh"), "utf8")).toBe("base helper\n")
    await expect(readFile(join(repo, "tools", "added.sh"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })

    await overlay.restore()
    expect(await readFile(join(repo, "tools", "gate.sh"), "utf8")).toBe(WEAKENED_GATE)
    expect(await readFile(join(repo, "tools", "added.sh"), "utf8")).toBe("candidate addition\n")
    await expect(readFile(join(repo, "tools", "helper.sh"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    // An untouched declared path mutates nothing and restores nothing.
    const untouched = await overlayGateScripts(gitPort, repo, candidateSha, candidateSha, ["tools"])
    expect(untouched.differing).toEqual([])
  })

  it("refuses a declared path the base does not hold, naming the next-change rule", async () => {
    const repo = await gatedRepository()
    const baseSha = await git(repo, "rev-parse", "HEAD")
    await using process = createProcess({ cwd: repo })
    const gitPort = {
      run: async (cwd: string, args: readonly string[]) => {
        const outcome = await process.run({ argv: ["git", "-C", cwd, ...args], cwd })
        return { code: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr }
      },
    }
    const refusal = await overlayGateScripts(gitPort, repo, baseSha, baseSha, ["tools/never-existed.sh"]).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(failureFact(refusal)).toMatchObject({ kind: "refusal", code: "gate-script-missing-at-base" })
    expect(refusal).toMatchObject({ message: expect.stringContaining("takes effect for the NEXT change") })
  })
})

describe("gate scripts execute at the base ref's version", () => {
  it("pre-submit: a change weakening its own gate is judged by the pre-edit script and refused", async () => {
    const repo = await gatedRepository()
    const attacker = await branchWith(repo, "issue/weaken", {
      "forbidden.txt": "contraband\n",
      "tools/gate.sh": WEAKENED_GATE,
    })
    const host = await createYrdHost({ cwd: repo })
    try {
      const checks = host.services.checks
      if (checks === undefined) throw new Error("expected configured checks")
      // The candidate's own gate.sh says pass; the base's says refuse. The
      // base's version judges (23183) — without the base pin this exits 0.
      const judged = await checks.run("gate", repo, { ref: attacker })
      expect(judged.exitCode, judged.stderr).not.toBe(0)
      expect(judged.stderr).toContain("forbidden file present")

      // A compliant change that edits the same script passes — judged by the
      // pre-edit script, which finds nothing forbidden; the edit takes effect
      // for the NEXT change.
      const compliant = await branchWith(repo, "issue/legit-edit", { "tools/gate.sh": WEAKENED_GATE })
      const allowed = await checks.run("gate", repo, { ref: compliant })
      expect(allowed.exitCode, allowed.stderr).toBe(0)
    } finally {
      await host.close()
    }
  })

  it("queue run: the same weakening change is refused by the check step, and a passing change merges its OWN script version", async () => {
    const repo = await gatedRepository()
    const attacker = await branchWith(repo, "issue/weaken", {
      "forbidden.txt": "contraband\n",
      "tools/gate.sh": WEAKENED_GATE,
    })
    const host = await createYrdHost({ cwd: repo })
    try {
      await host.app.bays.recordBranchSubmit({ branch: "issue/weaken", sha: attacker, base: "main" })
      const run = (await host.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]
      expect(run).toMatchObject({ status: "completed", conclusion: "failure" })
      const gateJob = run?.steps.find((step) => step.name === "gate")?.job
      expect(gateJob).toMatchObject({ status: "completed", conclusion: "failure" })
    } finally {
      await host.close()
    }

    // The compliant editor merges, and main receives the CANDIDATE's script —
    // the base pin judged the run but never entered the merged result.
    const editor = await branchWith(repo, "issue/legit-edit", { "tools/gate.sh": WEAKENED_GATE })
    const host2 = await createYrdHost({ cwd: repo })
    try {
      // S7: the branch and its standing submit fact ARE the change, so
      // isolating the compliant editor means retiring the attacker's fact
      // rather than selecting one record out of a store. Without this the
      // selectorless drain would compose the still-submitted attacker too.
      await host2.app.bays.recordBranchUnsubmit({ branch: "issue/weaken", reason: "archived" })
      await host2.app.bays.recordBranchSubmit({ branch: "issue/legit-edit", sha: editor, base: "main" })
      expect(Object.keys(host2.app.state().bays.submits)).toEqual(["issue/legit-edit"])
      const run = (await host2.app.queue.run({}, { runner: "test", leaseMs: 60_000 }))[0]
      expect(run).toMatchObject({ status: "completed", conclusion: "success" })
      expect(await git(repo, "show", "main:tools/gate.sh")).toBe(WEAKENED_GATE.trimEnd())
    } finally {
      await host2.close()
    }
  })

  it("folds the script's base sha into the step revision, so a landed script edit is a plan change the audit sees", async () => {
    const repo = await gatedRepository()
    const host = await createYrdHost({ cwd: repo })
    try {
      // Same config bytes, edited script committed on the base: the tip's
      // derived revision moves, so leg c reports this process stale — a
      // gate-script edit propagates exactly like a config edit.
      await writeFile(join(repo, "tools", "gate.sh"), `${BASE_GATE}# tightened\n`)
      await git(repo, "add", "tools/gate.sh")
      await git(repo, "commit", "-qm", "tighten the gate")
      const audit = await host.services.queue?.auditEnvironment?.({ recordedRuns: 0 })
      expect(audit?.findings.map((finding) => finding.code)).toEqual(["installed-plan-stale"])
      expect(audit?.findings[0]?.message).toContain("step 'gate' revision")
    } finally {
      await host.close()
    }
  })

  it("refuses at startup a declared script the base does not hold", async () => {
    const repo = await gatedRepository()
    await writeFile(
      join(repo, ".yrd.yml"),
      'base: main\nbatch: 1\nchecks:\n  - {gate: {run: "bash tools/other.sh", scripts: [tools/other.sh]}}\n',
    )
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "declare a script main does not hold")
    const failure = await createYrdHost({ cwd: repo }).then(
      (host) => host.close().then(() => undefined),
      (reason: unknown) => reason,
    )
    expect(failureFact(failure)).toMatchObject({ kind: "configuration", code: "gate-script-missing-at-base" })
  })
})
