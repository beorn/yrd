import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createProcess, type Process } from "@yrd/process"
import { gitIn } from "../src/git.ts"
import * as gitRunner from "../src/git.ts"
import { openLog, readRunLog } from "../src/log.ts"
import { gitSuperExecution } from "../src/verifying.ts"

it("requires a Git runner's fixed selection before opening Gitomic", () => {
  const selected = {
    executable: "/tmp/yrd-selected-git",
    contract: "native" as const,
    scope: "local" as const,
    origin: "fixture",
  }
  const runner = gitIn("/tmp", undefined, selected)
  expect(gitRunner.selectionFor(runner)).toBe(selected)
  expect(gitRunner.executableFor(runner)).toBe(selected.executable)
  expect(() => gitRunner.selectionFor(async () => "")).toThrow(/needs a Yrd Git runner with a resolved selection/u)
})

function temporaryRoot(name: string): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `yrd-git-runner-${name}-`))
}

function declareGit(root: string, value: string, file?: string): void {
  // Native Git accepts an empty value; Process intentionally rejects empty
  // argv words, so fixture authoring must not depend on that wrapper.
  const result = spawnSync("git", ["config", ...(file === undefined ? [] : ["--file", file]), "yrd.git", value], {
    cwd: root,
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`fixture config failed in ${root}: ${result.stderr}`)
}

describe("the git runner", () => {
  // 25282: a settled SSH refusal used to end the read immediately. This test
  // proves the retry traverses the real supervised runner and retains BOTH
  // invocations, which a predicate-only unit test would miss.
  it.each([1, 2])(
    "retries one exact publickey refusal, preserving both invocations (failures=%i)",
    async (failures) => {
      const root = temporaryRoot("publickey-read")
      const executable = publickeyExecutable(root, failures)
      const log = openLog(join(root, "logs"))
      const announced = vi.spyOn(console, "error").mockImplementation(() => {})
      const git = gitIn(
        root,
        undefined,
        { executable, contract: "native", scope: "local", origin: "fixture" },
        {
          env: { ...process.env, GIT_SSH_COMMAND: "ssh -i /tmp/fleet-key -o IdentitiesOnly=yes" },
          openOutput: log.openGitOutput,
          onInvocation: log.writeGitInvocation,
        },
      )
      try {
        const read = git(["ls-remote", "origin", "refs/heads/main"])
        if (failures === 1) expect(await read).toContain("refs/heads/main")
        else {
          const error = await read.catch((error: unknown) => error)
          expect(error).toBeInstanceOf(gitRunner.GitExit)
          if (!(error instanceof gitRunner.GitExit)) throw new Error("Expected the second refusal to fail")
          expect(error.message).toContain("git ls-remote origin refs/heads/main")
          expect(error.message).toContain("Permission denied (publickey).")
        }
        expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toHaveLength(2)
        const rows = readRunLog(join(root, "logs"), log.id)
        expect(rows).toHaveLength(2)
        const first = rows[0]
        const second = rows[1]
        expect(first).toMatchObject({ kind: "git", complete: true })
        expect(second).toMatchObject({ kind: "git", complete: true })
        const firstEvidence = JSON.parse(readFileSync(String(first?.evidence), "utf8")) as {
          artifacts: { stderr: string }
        }
        const secondEvidence = JSON.parse(readFileSync(String(second?.evidence), "utf8")) as {
          artifacts: { stderr: string }
        }
        expect(readFileSync(firstEvidence.artifacts.stderr, "utf8")).toContain("Permission denied (publickey).")
        expect(readFileSync(secondEvidence.artifacts.stderr, "utf8")).toContain("Offering public key: fleet-key")
        expect(announced).toHaveBeenCalledOnce()
      } finally {
        announced.mockRestore()
      }
    },
  )

  it("retries one dropped SSH session through the runner, with no key trace", async () => {
    const root = temporaryRoot("session-drop-read")
    const drop =
      "Connection to github.com closed by remote host.\nfatal: Could not read from remote repository.\n\n" +
      "Please make sure you have the correct access rights\nand the repository exists."
    const executable = publickeyExecutable(root, 1, drop)
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const git = gitIn(root, undefined, { executable, contract: "native", scope: "local", origin: "fixture" })
      expect(await git(["ls-remote", "origin", "refs/heads/main"])).toContain("refs/heads/main")
      expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toHaveLength(2)
      expect(announced).toHaveBeenCalledOnce()
      expect(announced.mock.calls[0]?.[0]).toContain("SSH session dropped; retry 2/2 after 3000ms")
      expect(announced.mock.calls[0]?.[0]).not.toContain(" -v")
    } finally {
      announced.mockRestore()
    }
  })

  it.each([
    ["push", "git@github.com: Permission denied (publickey)."],
    ["ls-remote", "fatal: repository not found"],
    [
      "ls-remote",
      "ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.",
    ],
  ] as const)("never retries %s after %s", async (verb, refusal) => {
    const root = temporaryRoot("nonretry")
    const executable = publickeyExecutable(root, 1, refusal)
    const git = gitIn(root, undefined, { executable, contract: "native", scope: "local", origin: "fixture" })
    await expect(git([verb, "origin"])).rejects.toThrow(refusal)
    expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toHaveLength(1)
  })

  it.each(["exit 128", "timeout"] as const)(
    "keeps the first refusal and names a failed SSH config lookup (%s)",
    async (failure) => {
      const root = temporaryRoot("config-read-failure")
      const executable = publickeyExecutable(root, 1)
      const bin = join(root, "bin")
      mkdirSync(bin)
      writeFileSync(
        join(bin, "git"),
        failure === "exit 128"
          ? "#!/bin/sh\nprintf 'fatal: broken config\\n' >&2\nexit 128\n"
          : "#!/usr/bin/env bun\nawait Bun.sleep(6000)\n",
        { mode: 0o700 },
      )
      const announced = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        const git = gitIn(
          root,
          undefined,
          { executable, contract: "native", scope: "local", origin: "fixture" },
          { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } },
        )
        await expect(git(["ls-remote", "origin"])).rejects.toThrow("Permission denied (publickey).")
        expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toHaveLength(1)
        expect(announced.mock.calls[0]?.[0]).toContain("SSH retry skipped")
        expect(announced.mock.calls[0]?.[0]).toContain("cannot read core.sshCommand")
      } finally {
        announced.mockRestore()
      }
    },
  )

  it("aborts during publickey backoff without running a second Git read", async () => {
    const root = temporaryRoot("publickey-abort")
    const executable = publickeyExecutable(root, 1)
    const controller = new AbortController()
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const git = gitIn(
        root,
        undefined,
        { executable, contract: "native", scope: "local", origin: "fixture" },
        {
          env: { ...process.env, GIT_SSH_COMMAND: "ssh -i /tmp/fleet-key" },
          signal: controller.signal,
          onInvocation: () => setTimeout(() => controller.abort(), 50),
        },
      )
      await expect(git(["fetch", "origin"])).rejects.toThrow("Permission denied (publickey).")
      expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toHaveLength(1)
      expect(announced).toHaveBeenCalledOnce()
    } finally {
      announced.mockRestore()
    }
  })

  // 25282: legacy event-ref reads spawn Gitomic's shell backend directly.
  // The gitIn case above cannot catch a retry omitted from this seam.
  it.each([
    ["ls-remote", 1],
    ["ls-remote", 2],
    ["fetch", 1],
    ["fetch", 2],
  ] as const)("retries a Gitomic %s publickey refusal once (failures=%i)", async (verb, failures) => {
    const { repo, ssh, calls } = legacyPublickeyRepo(failures)
    const previous = process.env.GIT_SSH_COMMAND
    const previousVariant = process.env.GIT_SSH_VARIANT
    process.env.GIT_SSH_COMMAND = ssh
    process.env.GIT_SSH_VARIANT = "ssh"
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const backend = gitRunner.createLegacyBackend()
      const read =
        verb === "fetch"
          ? backend.fetchRefs!(repo, ["refs/heads/main"], "git@github.com:fixture")
          : backend.listRefs!(repo, "refs/heads/", "git@github.com:fixture")
      if (failures === 1) expect((await read).get("refs/heads/main")).toMatch(/^[a-f0-9]{40}$/u)
      else {
        const error = await read.catch((error: unknown) => error)
        expect(error).toBeInstanceOf(Error)
        if (!(error instanceof Error)) throw new Error("Expected a second refusal")
        expect(error.message).toContain(`git ${verb}`)
        expect(error.message).toContain("Permission denied (publickey).")
        expect(error.message).toContain("Offering public key: fleet-key")
      }
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2)
      expect(announced).toHaveBeenCalledOnce()
      expect(announced.mock.calls[0]?.[0]).toContain("Permission denied (publickey).")
    } finally {
      announced.mockRestore()
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = previous
      if (previousVariant === undefined) delete process.env.GIT_SSH_VARIANT
      else process.env.GIT_SSH_VARIANT = previousVariant
    }
  })

  // 25616 row 2: a read whose SSH session dropped mid-read gets the same one announced retry, without the key trace.
  // The fixture ssh prints the direct connection's close line and exits 255, and real git adds its own fatal lines.
  it.each(["ls-remote", "fetch"] as const)("retries a Gitomic %s whose SSH session dropped, once", async (verb) => {
    const { repo, ssh, calls } = legacyPublickeyRepo(1, "Connection to github.com closed by remote host.")
    const previous = process.env.GIT_SSH_COMMAND
    const previousVariant = process.env.GIT_SSH_VARIANT
    process.env.GIT_SSH_COMMAND = ssh
    process.env.GIT_SSH_VARIANT = "ssh"
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const backend = gitRunner.createLegacyBackend()
      const read =
        verb === "fetch"
          ? backend.fetchRefs!(repo, ["refs/heads/main"], "git@github.com:fixture")
          : backend.listRefs!(repo, "refs/heads/", "git@github.com:fixture")
      expect((await read).get("refs/heads/main")).toMatch(/^[a-f0-9]{40}$/u)
      const attempts = readFileSync(calls, "utf8").trim().split("\n")
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).not.toContain(" -v ")
      expect(announced).toHaveBeenCalledOnce()
      expect(announced.mock.calls[0]?.[0]).toContain("SSH session dropped; retry 2/2 after 3000ms")
    } finally {
      announced.mockRestore()
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = previous
      if (previousVariant === undefined) delete process.env.GIT_SSH_VARIANT
      else process.env.GIT_SSH_VARIANT = previousVariant
    }
  })

  it("does not retry a different Gitomic SSH failure", async () => {
    const refusal = "fatal: repository not found"
    const { repo, ssh, calls } = legacyPublickeyRepo(1, refusal)
    const previous = process.env.GIT_SSH_COMMAND
    const previousVariant = process.env.GIT_SSH_VARIANT
    process.env.GIT_SSH_COMMAND = ssh
    process.env.GIT_SSH_VARIANT = "ssh"
    try {
      const backend = gitRunner.createLegacyBackend()
      await expect(backend.listRefs!(repo, "refs/heads/", "git@github.com:fixture")).rejects.toThrow(refusal)
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = previous
      if (previousVariant === undefined) delete process.env.GIT_SSH_VARIANT
      else process.env.GIT_SSH_VARIANT = previousVariant
    }
  })

  it("keeps Gitomic's first refusal when SSH config cannot be read", async () => {
    const { repo, ssh, calls } = legacyPublickeyRepo(1)
    const bin = join(resolve(repo, ".."), "bin")
    mkdirSync(bin)
    const nativeGit = Bun.which("git")
    if (nativeGit === null) throw new Error("Fixture needs native git")
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if [ "$1" = "config" ] && [ "$2" = "--get" ]; then
  printf 'fatal: broken config\\n' >&2
  exit 128
fi
exec ${JSON.stringify(nativeGit)} "$@"
`,
      { mode: 0o700 },
    )
    const previousCommand = process.env.GIT_SSH_COMMAND
    const previousProgram = process.env.GIT_SSH
    const previousVariant = process.env.GIT_SSH_VARIANT
    const previousPath = process.env.PATH
    delete process.env.GIT_SSH_COMMAND
    process.env.GIT_SSH = ssh
    process.env.GIT_SSH_VARIANT = "ssh"
    process.env.PATH = `${bin}:${previousPath ?? ""}`
    const announced = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const backend = gitRunner.createLegacyBackend()
      await expect(backend.listRefs!(repo, "refs/heads/", "git@github.com:fixture")).rejects.toThrow(
        "Permission denied (publickey).",
      )
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1)
      expect(announced.mock.calls[0]?.[0]).toContain("SSH retry skipped")
      expect(announced.mock.calls[0]?.[0]).toContain("cannot read core.sshCommand")
    } finally {
      announced.mockRestore()
      if (previousCommand === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = previousCommand
      if (previousProgram === undefined) delete process.env.GIT_SSH
      else process.env.GIT_SSH = previousProgram
      if (previousVariant === undefined) delete process.env.GIT_SSH_VARIANT
      else process.env.GIT_SSH_VARIANT = previousVariant
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it.each(["core.sshCommand", "GIT_SSH"] as const)(
    "keeps %s and records the same SSH program on retry",
    async (source) => {
      const { repo, ssh, calls } = legacyPublickeyRepo(
        1,
        undefined,
        source === "GIT_SSH" ? "fixture ssh" : "fixture-ssh",
      )
      const previousCommand = process.env.GIT_SSH_COMMAND
      const previousProgram = process.env.GIT_SSH
      const previousVariant = process.env.GIT_SSH_VARIANT
      delete process.env.GIT_SSH_COMMAND
      if (source === "core.sshCommand") {
        const config = spawnSync("git", ["config", "core.sshCommand", `${ssh} --identity-marker`], {
          cwd: repo,
          encoding: "utf8",
        })
        if (config.status !== 0) throw new Error(`fixture core.sshCommand: ${config.stderr}`)
        delete process.env.GIT_SSH
      } else process.env.GIT_SSH = ssh
      process.env.GIT_SSH_VARIANT = "ssh"
      const announced = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        const backend = gitRunner.createLegacyBackend()
        expect((await backend.listRefs!(repo, "refs/heads/", "git@github.com:fixture")).get("refs/heads/main")).toMatch(
          /^[a-f0-9]{40}$/u,
        )
        const attempts = readFileSync(calls, "utf8").trim().split("\n")
        expect(attempts).toHaveLength(2)
        expect(attempts[1]).toContain("-v")
        if (source === "core.sshCommand") {
          expect(attempts[0]).toContain("--identity-marker")
          expect(attempts[1]).toContain("--identity-marker")
        }
        expect(announced.mock.calls[0]?.[0]).toContain(ssh)
      } finally {
        announced.mockRestore()
        if (previousCommand === undefined) delete process.env.GIT_SSH_COMMAND
        else process.env.GIT_SSH_COMMAND = previousCommand
        if (previousProgram === undefined) delete process.env.GIT_SSH
        else process.env.GIT_SSH = previousProgram
        if (previousVariant === undefined) delete process.env.GIT_SSH_VARIANT
        else process.env.GIT_SSH_VARIANT = previousVariant
      }
    },
  )

  // D2/T1: the old runner always launches Git and has no declaration or
  // provenance. Native recursion tests cannot distinguish absent from invalid.
  it("resolves one file-scoped executable declaration, preserving absence and successful provenance", async () => {
    const root = temporaryRoot("selection")
    const git = gitIn(root)
    await git(["init", "-q", "-b", "main"])
    const initial = await gitRunner.resolveGitSelection(root)
    expect(initial).toMatchObject({ contract: "native", scope: "default", origin: "yrd.git absent" })
    expect(initial.executable.startsWith("/")).toBe(true)
    const selected = join(root, "selected git")
    symlinkSync(initial.executable, selected)
    declareGit(root, JSON.stringify({ executable: selected, contract: "native" }))
    const declared = await gitRunner.resolveGitSelection(root)
    expect(declared).toEqual({ executable: selected, contract: "native", scope: "local", origin: "file:.git/config" })
    // A captured declaration does not re-read a replacement during invocation.
    declareGit(root, "")
    await expect(gitIn(root, undefined, declared)(["--version"])).resolves.toMatch(/^git version /u)
    await expect(gitRunner.resolveGitSelection(root)).rejects.toThrow(/yrd\.git.*empty/u)
  })

  it.each([
    ["empty", "", "a present value is empty"],
    ["malformed", "{", "expected a JSON executable/contract declaration"],
    ["missing field", '{"executable":"git"}', "expected exactly executable and contract"],
    [
      "unknown field",
      '{"executable":"git","contract":"native","observe":true}',
      "expected exactly executable and contract",
    ],
    ["unknown contract", '{"executable":"git","contract":"later"}', "expected exactly executable and contract"],
    ["array contract", '{"executable":"git","contract":["root-v1"]}', "expected exactly executable and contract"],
    [
      "relative executable",
      '{"executable":"./git","contract":"native"}',
      "executable must be one absolute path or bare command name",
    ],
    ["missing executable", '{"executable":"/no/such/yrd-git-executable","contract":"native"}', "is unavailable"],
  ])("refuses a present %s selection rather than using native Git", async (_reason, value, reason) => {
    const root = temporaryRoot("invalid-selection")
    const git = gitIn(root)
    await git(["init", "-q", "-b", "main"])
    declareGit(root, value)
    const outcome = await gitRunner.resolveGitSelection(root).catch((error: unknown) => error)
    expect(outcome).toBeInstanceOf(Error)
    if (!(outcome instanceof Error)) throw new Error("Expected selection to fail")
    for (const expected of ["yrd.git", root, "file:.git/config", reason]) expect(outcome.message).toContain(expected)
  })

  it.each(["", "{", '{"executable":"/no/such/lower-git","contract":"native"}'])(
    "uses the winning file value over an invalid lower value (%s)",
    async (lower) => {
      const root = temporaryRoot("selection-precedence")
      await gitIn(root)(["init", "-q", "-b", "main"])
      const global = join(root, "global-config")
      declareGit(root, lower, global)
      declareGit(root, '{"executable":"git","contract":"native"}')
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: global,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: undefined,
      }
      expect(await gitRunner.resolveGitSelection(root, { env })).toMatchObject({
        contract: "native",
        scope: "local",
        origin: "file:.git/config",
      })
      declareGit(root, "")
      await expect(gitRunner.resolveGitSelection(root, { env })).rejects.toThrow(
        /file:\.git\/config.*a present value is empty/u,
      )
    },
  )

  it("rejects command-scope selection and preserves an unreadable config as an error", async () => {
    const root = temporaryRoot("selection-scope")
    await gitIn(root)(["init", "-q", "-b", "main"])
    declareGit(root, '{"executable":"git","contract":"native"}')
    const env = {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "yrd.git",
      GIT_CONFIG_VALUE_0: '{"executable":"git","contract":"native"}',
    }
    await expect(gitRunner.resolveGitSelection(root, { env })).rejects.toThrow(/yrd\.git.*command/u)
    await using runner = createProcess({ cwd: root })
    await expect(gitRunner.resolveGitSelection(root, { env, process: runner })).rejects.toThrow(/yrd\.git.*command/u)
    appendFileSync(join(root, ".git", "config"), "\n[broken\n")
    await expect(gitRunner.resolveGitSelection(root)).rejects.toThrow(/yrd\.git.*cannot read/u)
  })

  it.each([0, 1])("bounds bootstrap and refuses incomplete settlement even with native exit %i", async (exitCode) => {
    const root = temporaryRoot("selection-settlement")
    await gitIn(root)(["init", "-q", "-b", "main"])
    await using runner = createProcess({ cwd: root })
    let calls = 0
    const process = {
      run: async (request: Parameters<typeof runner.run>[0]) => {
        calls += 1
        expect(request.timeoutMs).toBeGreaterThan(0)
        return { ...(await runner.run(request)), exitCode, signal: "SIGTERM" as const }
      },
    }
    await expect(gitRunner.resolveGitSelection(root, { process })).rejects.toThrow(/did not settle completely/u)
    expect(calls).toBe(1)
  })

  // D3/T2/T3: the native exit tests have no separate descriptor and cannot
  // distinguish a semantic refusal or malformed protocol from native exit 1.
  // A successful ref read with no object is also an error, never absence;
  // only a clean exit 1 with both streams empty establishes absence. The
  // diagnostic-output row previously hid a corrupt ref behind the same exit.
  it.each([
    ["success", 0, undefined, false],
    ["empty ref", 0, undefined, true],
    ["native absence", 1, undefined, true],
    ["native failure", 1, undefined, false],
    ["waiting", 1, "waiting", false],
    ["rejected", 1, "rejected", false],
    ["unjudged", 1, "unjudged", false],
  ] as const)("retains invocation evidence for a selected producer: %s", async (_name, exit, refusal, empty) => {
    const root = temporaryRoot("protocol-result")
    const stdout = empty ? [] : [111, 117, 116, 0, 255, 10]
    const stderr = empty ? [] : [101, 114, 114, 0, 254, 10]
    const executable = protocolExecutable(
      root,
      `
      frame({version:1, token, ready:true});
      writeSync(1, Buffer.from(${JSON.stringify(stdout)}));
      writeSync(2, Buffer.from(${JSON.stringify(stderr)}));
      ${refusal === undefined ? "" : `frame({version:1, token, refusal:${JSON.stringify(refusal)}, message:"  complete\\nhuman text  "});`}
      closeSync(3); process.exit(${exit});
    `,
    )
    await using runner = createProcess({ cwd: root })
    const git = gitIn(root, runner, { executable, contract: "root-v1", scope: "local", origin: "file:.git/config" })
    const outcome = await git(["status"], "ordinary input").catch((error: unknown) => error)
    if (exit === 0) expect(outcome).toBe(empty ? "" : "out\0�\n")
    else expect(outcome).toBeInstanceOf(gitRunner.GitExit)
    const evidence = git.lastInvocation
    expect(Array.from(evidence?.result?.rawOutput?.stdout.head ?? [])).toEqual(stdout)
    expect(Array.from(evidence?.result?.rawOutput?.stderr.head ?? [])).toEqual(stderr)
    expect(evidence?.protocol).toMatchObject({ ready: true })
    expect(evidence?.failure).toBeUndefined()
    expect(evidence?.protocol?.refusal?.kind).toBe(refusal)
    if (refusal !== undefined) expect(evidence?.protocol?.refusal?.message).toBe("  complete\nhuman text  ")
    expect(evidence?.selection?.executable).toBe(executable)
    expect(evidence?.result?.extraStdio?.eof).toBe(true)
    if (outcome instanceof gitRunner.GitExit) expect(outcome.evidence).toBe(evidence)
    // Diagnostics and generic refusals must reach the caller, even with exit 1.
    if (refusal === undefined && exit === 1) {
      if (empty) await expect(gitRunner.refAt(git, "missing")).resolves.toBeUndefined()
      else await expect(gitRunner.refAt(git, "missing")).rejects.toThrow(/err/u)
    }
    if (refusal !== undefined) await expect(gitRunner.refAt(git, "missing")).rejects.toThrow(/complete\nhuman text/u)
    if (empty && exit === 0) {
      await expect(gitRunner.refAt(git, "refs/heads/missing")).rejects.toThrow(
        /rev-parse --verify --quiet refs\/heads\/missing\^\{commit\}.*empty/u,
      )
    }
  })

  it.each([
    ["missing ready", "", "missing ready"],
    [
      "unknown refusal",
      'frame({version:1,token,ready:true}); frame({version:1,token,refusal:"later",message:"opaque"});',
      "unknown refusal",
    ],
    ["wrong token", 'frame({version:1,token:"wrong",ready:true});', "token"],
    ["duplicate ready", "frame({version:1,token,ready:true}); frame({version:1,token,ready:true});", "duplicate"],
    ["unknown field", 'frame({version:1,token,ready:true,child:"secret"});', "fields"],
    ["incomplete frame", 'writeSync(3,Buffer.from("{"));', "incomplete"],
    ["invalid UTF-8", "writeSync(3,Buffer.from([255,10]));", "UTF-8"],
    ["refusal before ready", 'frame({version:1,token,refusal:"waiting",message:"opaque"});', "before ready"],
    [
      "duplicate refusal",
      'frame({version:1,token,ready:true}); frame({version:1,token,refusal:"waiting",message:"opaque"}); frame({version:1,token,refusal:"waiting",message:"opaque"});',
      "duplicate",
    ],
  ])("keeps %s visible instead of interpreting exit 1 as an absent ref", async (_name, body, reason) => {
    const root = temporaryRoot("protocol-invalid")
    const executable = protocolExecutable(root, `${body} closeSync(3); process.exit(1);`)
    await using runner = createProcess({ cwd: root, killGraceMs: 20 })
    const git = gitIn(root, runner, { executable, contract: "root-v1", scope: "local", origin: "fixture" })
    await expect(gitRunner.refAt(git, "missing")).rejects.toThrow(reason)
    expect(git.lastInvocation?.failure).toContain(reason)
  })

  it("rejects refusal with exit zero and a would-be refusal after abnormal settlement", async () => {
    const root = temporaryRoot("protocol-settlement")
    const executable = protocolExecutable(
      root,
      'frame({version:1,token,ready:true}); frame({version:1,token,refusal:"waiting",message:"opaque"}); closeSync(3); process.exit(0);',
    )
    await using runner = createProcess({ cwd: root })
    const selection = { executable, contract: "root-v1", scope: "local", origin: "fixture" } as const
    const git = gitIn(root, runner, selection)
    await expect(git(["status"])).rejects.toThrow("refusal with exit 0")
    const abnormal = gitIn(
      root,
      { run: async (request) => ({ ...(await runner.run(request)), signal: "SIGTERM", exitCode: 1 }) },
      selection,
    )
    await expect(gitRunner.refAt(abnormal, "missing")).rejects.toThrow("settle completely")
    expect(abnormal.lastInvocation?.protocol?.refusal?.kind).toBe("waiting")
    expect(abnormal.lastInvocation?.failure).toContain("settle completely")
  })

  it("bounds a missing readiness acknowledgement through the existing Process cancellation", async () => {
    const root = temporaryRoot("protocol-ready-deadline")
    const executable = protocolExecutable(root, "await Bun.sleep(60_000);")
    await using runner = createProcess({ cwd: root, killGraceMs: 20 })
    let defaultBound: number | undefined
    const git = gitIn(
      root,
      {
        run: (request) => {
          defaultBound = request.timeoutMs
          return runner.run(request)
        },
      },
      { executable, contract: "root-v1", scope: "local", origin: "fixture" },
    )
    await expect(git(["status"])).rejects.toThrow("missing ready after 5000 ms")
    expect(defaultBound).toBe(300_000)
    expect(git.lastInvocation?.protocol?.ready).toBe(false)
    expect(git.lastInvocation?.result?.signal).not.toBeNull()
  }, 15_000)

  it("retains a shorter total deadline and never accepts a refusal from the timed-out process", async () => {
    const root = temporaryRoot("protocol-total-deadline")
    const executable = protocolExecutable(
      root,
      'frame({version:1,token,ready:true}); frame({version:1,token,refusal:"waiting",message:"not a completed outcome"}); await Bun.sleep(60_000);',
    )
    await using runner = createProcess({ cwd: root, killGraceMs: 20 })
    const git = gitIn(
      root,
      runner,
      { executable, contract: "root-v1", scope: "local", origin: "fixture" },
      { timeoutMs: 500 },
    )
    await expect(gitRunner.refAt(git, "missing")).rejects.toThrow("settle completely")
    expect(git.lastInvocation?.result?.timedOut).toBe(true)
    expect(git.lastInvocation?.protocol?.refusal?.kind).toBe("waiting")
  })

  // Addendum 2: the existing display log decodes bytes and cannot prove raw
  // evidence survives truncation or that completed paths were actually closed.
  it("keeps complete raw run artifacts when the display capture has a gap", async () => {
    const root = temporaryRoot("raw-log")
    const executable = protocolExecutable(
      root,
      "frame({version:1,token,ready:true}); writeSync(1,Buffer.from([0,255,1,2,3,4,5,6])); writeSync(2,Buffer.from([0,254,9,8,7,6,5,4])); closeSync(3); process.exit(0);",
    )
    const log = openLog(join(root, "logs"))
    await using runner = createProcess({ cwd: root, maxOutputBytes: 4 })
    const git = gitIn(
      root,
      runner,
      { executable, contract: "root-v1", scope: "local", origin: "fixture" },
      {
        openOutput: log.openGitOutput,
        onInvocation: log.writeGitInvocation,
      },
    )
    // The truncation is the point of this test, so it owns the two warnings the
    // process layer logs for it (stdout and stderr) instead of leaking them.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(git(["status"])).rejects.toThrow("capture is incomplete")
      const warned = warn.mock.calls.map((call) => call.map(String).join(" "))
      expect(warned).toHaveLength(2)
      for (const line of warned) expect(line).toContain("produced more output than Yrd captures")
    } finally {
      warn.mockRestore()
    }
    const artifacts = git.lastInvocation?.artifacts
    expect(artifacts?.complete).toBe(true)
    if (artifacts === undefined) throw new Error("Missing raw artifact paths")
    expect([...readFileSync(artifacts.stdout)]).toEqual([0, 255, 1, 2, 3, 4, 5, 6])
    expect([...readFileSync(artifacts.stderr)]).toEqual([0, 254, 9, 8, 7, 6, 5, 4])
    const rows = readRunLog(join(root, "logs"), log.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "git", executable, contract: "root-v1", complete: true })
    const metadata = JSON.parse(readFileSync(String(rows[0]?.evidence), "utf8")) as {
      result: { outputTruncation: readonly unknown[]; extraStdio: { bytesBase64: string } }
      protocol: { ready: boolean }
    }
    expect(metadata.result.outputTruncation).toHaveLength(2)
    expect(metadata.protocol.ready).toBe(true)
    expect(Buffer.from(metadata.result.extraStdio.bytesBase64, "base64").toString()).toContain('"ready":true')
  })

  it.each(["write", "close"] as const)(
    "keeps a raw sink %s failure loud and its artifacts incomplete",
    async (phase) => {
      const root = temporaryRoot("raw-sink-failure")
      const log = openLog(join(root, "logs"))
      const git = gitIn(root, undefined, undefined, {
        openOutput: (invocation) => {
          const sink = log.openGitOutput(invocation)
          return {
            ...sink,
            onOutput: (output) => {
              if (phase === "write") throw new Error("fixture raw write failure")
              sink.onOutput(output)
            },
            close: () => {
              sink.close()
              if (phase === "close") throw new Error("fixture raw close failure")
            },
          }
        },
        onInvocation: log.writeGitInvocation,
      })
      await expect(git(["--version"])).rejects.toThrow(`fixture raw ${phase} failure`)
      expect(git.lastInvocation?.artifacts?.complete).toBe(false)
      expect(readRunLog(join(root, "logs"), log.id)[0]).toMatchObject({ kind: "git", complete: false })
    },
  )

  it("preserves the settled Git failure when publishing its evidence fails", async () => {
    const root = temporaryRoot("raw-publication-failure")
    const log = openLog(join(root, "logs"))
    let metadata = ""
    const git = gitIn(root, undefined, undefined, {
      openOutput: (invocation) => {
        const sink = log.openGitOutput(invocation)
        metadata = `${sink.stdout}.json`
        writeFileSync(metadata, "existing evidence", { flag: "wx" })
        return sink
      },
      onInvocation: log.writeGitInvocation,
    })
    const error = await git(["rev-parse", "HEAD"]).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(gitRunner.GitExit)
    if (!(error instanceof gitRunner.GitExit)) throw new Error("Expected a GitExit retaining the failed invocation")
    expect(error.exitCode).toBe(128)
    expect(error.evidence?.result?.stderr).toContain("not a git repository")
    expect(error.evidence?.failure).toContain("evidence publication failed")
    expect(error.evidence?.failure).toContain("EEXIST")
    expect(error.message).toContain(error.evidence?.artifacts?.stderr)
    expect(error.evidence).toBe(git.lastInvocation)
    expect(readFileSync(metadata, "utf8")).toBe("existing evidence")
  })

  // P1/T1: only the actual selected binary can prove environment authority,
  // original stdin and native delegation survive the new invocation option.
  it("uses the actual Git Super executable with the native runner's environment and stdin authority", async () => {
    const root = temporaryRoot("actual-selected")
    const native = await gitRunner.resolveGitSelection(root)
    await gitIn(root)(["init", "-q", "-b", "main"])
    const env = {
      ...process.env,
      GIT_DIR: join(root, "wrong-repository"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "probe.authority",
      GIT_CONFIG_VALUE_0: "  kept configuration\nsecond line  ",
      GIT_AUTHOR_NAME: "invocation author",
      GIT_AUTHOR_EMAIL: "invocation@example.test",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000",
    }
    const plain = gitIn(root, undefined, native, { env })
    const selected = gitIn(
      root,
      undefined,
      {
        executable: resolve(import.meta.dirname, "../../../../git-super/bin/git-super"),
        contract: "root-v1",
        scope: "local",
        origin: "actual binary fixture",
      },
      { env },
    )
    for (const args of [
      ["rev-parse", "--git-dir"],
      ["config", "--get", "probe.authority"],
      ["var", "GIT_AUTHOR_IDENT"],
    ]) {
      expect(await selected(args)).toBe(await plain(args))
      expect(selected.lastInvocation?.protocol).toMatchObject({ ready: true })
      expect(selected.lastInvocation?.failure).toBeUndefined()
    }
    expect(await selected(["hash-object", "--stdin"], "input\0with whitespace\n")).toBe(
      await plain(["hash-object", "--stdin"], "input\0with whitespace\n"),
    )
    expect(await selected(["config", "--get", "probe.authority"])).toBe("  kept configuration\nsecond line  \n")
  })

  // D1: the observer has a separate stdin/stdout protocol on the SAME
  // selected executable. Ordinary Git/refusal tests cannot prove this path.
  it.each([
    ["observed", 0, [{ id: "opaque-id", text: "complete producer notice" }]],
    ["changed-during-read", 3, []],
    ["unavailable-transport", 4, []],
    ["invalid", 2, []],
  ] as const)("observes once with a matching %s envelope and complete raw evidence", async (outcome, exit, notices) => {
    const root = temporaryRoot("observation")
    const input = {
      version: 1 as const,
      root: { remote: "https://example.test/owner/root", targetRef: "refs/heads/main", targetOid: "a".repeat(40) },
      checked: [],
      fence: { prefixes: ["refs/yrd/main/"], refs: [] },
    }
    const envelope = { version: 1, outcome, message: "Captured root and selected repositories examined", notices }
    const executable = protocolExecutable(
      root,
      `
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["super", "observe", "--protocol=1"])) throw new Error("wrong observer argv");
      if (JSON.stringify(JSON.parse(await Bun.stdin.text())) !== ${JSON.stringify(JSON.stringify(input))}) throw new Error("wrong root input");
      writeSync(1, ${JSON.stringify(JSON.stringify(envelope))});
      writeSync(2, Buffer.from([0, 255, 10]));
      process.exit(${exit});
    `,
      true,
    )
    await using process = createProcess({ cwd: root })
    let calls = 0
    const runner = {
      run: async (request: Parameters<typeof process.run>[0]) => {
        calls++
        expect(request.extraStdio).toBeUndefined()
        expect(request.timeoutMs).toBe(300_000)
        return process.run(request)
      },
    }
    const log = openLog(join(root, "logs"))
    const git = gitIn(
      root,
      runner,
      { executable, contract: "root-v1", scope: "local", origin: "fixture" },
      {
        openOutput: log.openGitOutput,
        onInvocation: log.writeGitInvocation,
      },
    )
    expect(await git.observe(input)).toEqual({ contract: "root-v1", ...envelope })
    expect(calls).toBe(1)
    expect(git.lastInvocation?.protocol).toBeUndefined()
    expect(git.lastInvocation?.artifacts?.complete).toBe(true)
    expect([...readFileSync(git.lastInvocation!.artifacts!.stderr)]).toEqual([0, 255, 10])
    const absent = gitIn(root, runner, { executable, contract: "native", scope: "local", origin: "fixture" })
    expect(await absent.observe(input)).toMatchObject({ contract: "native", notices: [] })
    expect(calls).toBe(1)
  })

  it.each([
    ["mismatched exit", '{"version":1,"outcome":"observed","message":"examined","notices":[]}', 3],
    [
      "notices on failure",
      '{"version":1,"outcome":"invalid","message":"failed","notices":[{"id":"stale","text":"discard"}]}',
      2,
    ],
    ["unknown field", '{"version":1,"outcome":"observed","message":"examined","notices":[],"child":"hidden"}', 0],
    ["blank explanation", '{"version":1,"outcome":"observed","message":"","notices":[]}', 0],
    ["unknown version", '{"version":2,"outcome":"observed","message":"examined","notices":[]}', 0],
    ["invalid UTF-8", "\u00ff", 0],
  ])("keeps %s observer output invalid with its raw evidence", async (_name, stdout, exit) => {
    const root = temporaryRoot("invalid-observation")
    const bytes = stdout === "\u00ff" ? [255] : [...new TextEncoder().encode(stdout)]
    const executable = protocolExecutable(
      root,
      `writeSync(1, Buffer.from(${JSON.stringify(bytes)})); process.exit(${exit});`,
      true,
    )
    const git = gitIn(root, undefined, { executable, contract: "root-v1", scope: "local", origin: "fixture" })
    await expect(
      git.observe({
        version: 1,
        root: { remote: "r", targetRef: "refs/heads/main", targetOid: "a".repeat(40) },
        checked: [],
        fence: { prefixes: [], refs: [] },
      }),
    ).rejects.toThrow(/observation/u)
    expect(git.lastInvocation?.failure).toContain("observation")
    expect(git.lastInvocation?.result?.rawOutput?.stdout.totalBytes).toBe(bytes.length)
  })

  it("never recurses a fetch or a push into submodules, whatever the repository's config says", async () => {
    // A superproject with one submodule whose remote is unreachable, under
    // `submodule.recurse=true` as the root's checkout has it. A plain fetch
    // recurses and fails on the submodule; the runner's fetch does not recurse.
    const root = temporaryRoot("recurse")
    const sub = join(root, "sub")
    const remote = join(root, "remote.git")
    const main = join(root, "main")
    const plain = (cwd: string, args: string[]) =>
      spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" })
    plain(root, ["init", "-q", "-b", "main", sub])
    plain(sub, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "sub"])
    plain(root, ["init", "-q", "--bare", "-b", "main", remote])
    plain(root, ["init", "-q", "-b", "main", main])
    plain(main, ["submodule", "add", "-q", sub, "sub"])
    plain(main, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main with sub"])
    plain(main, ["remote", "add", "origin", remote])
    plain(main, ["push", "-q", "origin", "main"])
    plain(main, ["config", "submodule.recurse", "true"])
    plain(main, ["config", "submodule.sub.url", join(root, "gone")])
    plain(main, ["-C", "sub", "remote", "set-url", "origin", join(root, "gone")])
    const control = plain(main, ["fetch", "origin"])
    expect(control.status, `the control fetch was expected to recurse and fail: ${control.stderr}`).not.toBe(0)
    await expect(gitIn(main)(["fetch", "origin"])).resolves.toBe("")
    // The same for a push: the superproject commit moves the gitlink to a commit
    // the submodule's remote does not have. Under `submodule.recurse=true` a
    // plain push recurses on demand into the submodule, whose remote is
    // unreachable, and fails; the runner's push does not recurse.
    plain(join(main, "sub"), [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "sub moved",
    ])
    plain(main, ["add", "sub"])
    plain(main, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main moves the gitlink"])
    const pushControl = plain(main, ["push", "-q", "origin", "main:refs/heads/control"])
    expect(pushControl.status, `the control push was expected to recurse and fail: ${pushControl.stderr}`).not.toBe(0)
    await expect(gitIn(main)(["push", "-q", "origin", "main:refs/heads/runner"])).resolves.toBe("")
  })

  it("answers for its own repository even when the caller's GIT_DIR points elsewhere", async () => {
    const root = temporaryRoot("gitdir")
    const git = gitIn(root)
    await git(["init", "-q", "-b", "main"])
    process.env.GIT_DIR = join(root, "not-a-repository")
    try {
      expect((await git(["rev-parse", "--git-dir"])).trim()).toBe(".git")
    } finally {
      delete process.env.GIT_DIR
    }
  })
})

function publickeyExecutable(
  root: string,
  failures: number,
  refusal = "git@github.com: Permission denied (publickey).",
): string {
  const executable = join(root, "publickey-producer")
  const calls = join(root, "calls")
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs"
const calls = ${JSON.stringify(calls)}
const attempt = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\\n").length + 1 : 1
appendFileSync(calls, String(attempt) + "\\n")
if (process.env.GIT_SSH_COMMAND?.includes(" -v")) process.stderr.write("debug1: Offering public key: fleet-key\\n")
if (attempt <= ${String(failures)}) {
  process.stderr.write(${JSON.stringify(refusal + "\n")})
  process.exit(128)
}
process.stdout.write("abc123\\trefs/heads/main\\n")
`,
    { mode: 0o700 },
  )
  return executable
}

function legacyPublickeyRepo(
  failures: number,
  refusal = "git@github.com: Permission denied (publickey).",
  sshName = "fixture-ssh",
): { repo: string; ssh: string; calls: string } {
  const root = temporaryRoot("gitomic-publickey")
  const repo = join(root, "client")
  const remote = join(root, "remote.git")
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")} in ${cwd}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git(root, ["init", "-q", "--bare", remote])
  git(root, ["init", "-q", "-b", "main", repo])
  git(repo, ["config", "user.name", "test"])
  git(repo, ["config", "user.email", "test@example.invalid"])
  writeFileSync(join(repo, "file"), "fixture\n")
  git(repo, ["add", "file"])
  git(repo, ["commit", "-q", "-m", "fixture"])
  git(repo, ["push", "-q", remote, "main"])
  const ssh = join(root, sshName)
  const calls = join(root, "ssh-calls")
  writeFileSync(
    ssh,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case " $* " in *" -v "*) printf 'debug1: Offering public key: fleet-key\\n' >&2 ;; esac
if [ "$(wc -l < ${JSON.stringify(calls)})" -le ${String(failures)} ]; then
  printf '%s\\n' ${JSON.stringify(refusal)} >&2
  exit 255
fi
exec git-upload-pack ${JSON.stringify(remote)}
`,
    { mode: 0o700 },
  )
  return { repo, ssh, calls }
}

/** A selected executable testing the transport, not a substitute Git store. */
function protocolExecutable(root: string, body: string, observation = false): string {
  const path = join(root, "selected-producer")
  writeFileSync(
    path,
    observation
      ? `#!/usr/bin/env bun
import {writeSync} from "node:fs";
${body}
`
      : `#!/usr/bin/env bun
import {writeSync,closeSync} from "node:fs";
if (process.argv[2] !== "--protocol-fd=3") { process.stderr.write("protocol option absent"); process.exit(91); }
const reader = Bun.file(3).stream().getReader();
let input="";
while (!input.includes("\\n")) { const {value,done}=await reader.read(); if(done) throw new Error("no greeting"); input+=new TextDecoder().decode(value); }
reader.releaseLock();
const {token}=JSON.parse(input);
const frame = (row) => writeSync(3,Buffer.from(JSON.stringify(row)+"\\n"));
${body}
`,
    { mode: 0o700 },
  )
  return path
}

describe("offTheTarget", () => {
  async function ancestryRepo(): Promise<{
    git: Awaited<ReturnType<typeof gitIn>>
    root: string
    target: string
    onTarget: string
    offTarget: string
  }> {
    const root = temporaryRoot("off-the-target")
    const git = gitIn(root)
    await git(["init", "-q", "-b", "main"])
    await git(["config", "user.email", "t@t"])
    await git(["config", "user.name", "t"])
    writeFileSync(join(root, "f"), "0\n")
    await git(["add", "f"])
    await git(["commit", "-q", "-m", "base"])
    const onTarget = (await git(["rev-parse", "HEAD"])).trim()
    writeFileSync(join(root, "f"), "1\n")
    await git(["add", "f"])
    await git(["commit", "-q", "-m", "target"])
    const target = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "-q", "-b", "side", onTarget])
    writeFileSync(join(root, "f"), "side\n")
    await git(["add", "f"])
    await git(["commit", "-q", "-m", "off"])
    const offTarget = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "-q", "main"])
    return { git, root, target, onTarget, offTarget }
  }

  it("returns only candidate heads not on the target, from one rev-list", async () => {
    const { git, target, onTarget, offTarget } = await ancestryRepo()
    let revList = 0
    let mergeBase = 0
    const counting = async (args: readonly string[], input?: string) => {
      if (args.includes("rev-list")) revList++
      if (args.includes("merge-base")) mergeBase++
      return git(args, input)
    }
    const heads = [onTarget, offTarget, target, onTarget]
    const off = await gitRunner.offTheTarget(counting, heads, target)
    expect([...off].sort()).toEqual([offTarget])
    expect(revList).toBe(1)
    expect(mergeBase).toBe(0)
  })

  it("issues no git when heads is empty", async () => {
    const { git, target } = await ancestryRepo()
    let calls = 0
    const counting = async (args: readonly string[], input?: string) => {
      calls++
      return git(args, input)
    }
    const off = await gitRunner.offTheTarget(counting, [], target)
    expect(off.size).toBe(0)
    expect(calls).toBe(0)
  })

  it("ordinary off-target is false for isAncestor and present in offTheTarget", async () => {
    const { git, target, onTarget, offTarget } = await ancestryRepo()
    expect(await gitRunner.isAncestor(git, onTarget, target)).toBe(true)
    expect(await gitRunner.isAncestor(git, offTarget, target)).toBe(false)
    const off = await gitRunner.offTheTarget(git, [onTarget, offTarget], target)
    expect(off.has(offTarget)).toBe(true)
    expect(off.has(onTarget)).toBe(false)
  })

  it("a missing object is a loud failure, not a silent false", async () => {
    const { git, target, onTarget } = await ancestryRepo()
    const missing = "a".repeat(40)
    await expect(gitRunner.isAncestor(git, missing, target)).rejects.toThrow()
    await expect(gitRunner.offTheTarget(git, [onTarget, missing], target)).rejects.toThrow()
  })
})

describe("readRemoteCommit on a store with a dangling ref (hh 25051)", () => {
  it("does not recurse into a real child whose remote is broken when submodule.recurse=true", async () => {
    const root = temporaryRoot("gitomic-no-submodule-recursion")
    const childRemote = join(root, "child.git")
    const childWork = join(root, "child-work")
    const parentRemote = join(root, "parent.git")
    const parentWork = join(root, "parent-work")
    const decoyRemote = join(root, "decoy.git")
    const decoyWork = join(root, "decoy-work")
    const reader = join(root, "reader")
    const seed = gitIn(root)

    await seed(["init", "--quiet", "--bare", "--initial-branch=main", childRemote])
    await seed(["clone", "--quiet", childRemote, childWork])
    const child = gitIn(childWork)
    await child(["config", "user.email", "queue@yrd.test"])
    await child(["config", "user.name", "yrd"])
    writeFileSync(join(childWork, "child.txt"), "child\n")
    await child(["add", "child.txt"])
    await child(["commit", "--quiet", "-m", "child"])
    await child(["push", "--quiet", "origin", "main"])

    await seed(["init", "--quiet", "--bare", "--initial-branch=main", parentRemote])
    await seed(["clone", "--quiet", parentRemote, parentWork])
    const parent = gitIn(parentWork)
    await parent(["config", "user.email", "queue@yrd.test"])
    await parent(["config", "user.name", "yrd"])
    await parent(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", childRemote, "child"])
    await parent(["commit", "--quiet", "-m", "parent with child"])
    await parent(["push", "--quiet", "origin", "main"])

    await seed(["-c", "protocol.file.allow=always", "clone", "--quiet", "--recurse-submodules", parentRemote, reader])
    const read = gitIn(reader)
    await read(["config", "submodule.recurse", "true"])
    await gitIn(join(reader, "child"))([
      "remote",
      "set-url",
      "origin",
      join(root, "child-remote-must-not-be-contacted"),
    ])

    await parent(["commit", "--quiet", "--allow-empty", "-m", "parent advanced"])
    await parent(["push", "--quiet", "origin", "main"])
    const advanced = (await parent(["rev-parse", "HEAD"])).trim()

    await seed(["init", "--quiet", "--bare", "--initial-branch=main", decoyRemote])
    await seed(["clone", "--quiet", decoyRemote, decoyWork])
    const decoy = gitIn(decoyWork)
    await decoy(["config", "user.email", "decoy@yrd.test"])
    await decoy(["config", "user.name", "decoy"])
    await decoy(["commit", "--quiet", "--allow-empty", "-m", "different main"])
    await decoy(["push", "--quiet", "origin", "main"])

    const previousGitDir = process.env.GIT_DIR
    process.env.GIT_DIR = join(decoyWork, ".git")
    try {
      await expect(gitRunner.readRemoteCommit(read, "origin", "refs/heads/main")).resolves.toBe(advanced)
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
    }
  })

  // One packed ref whose object is gone makes every fetch fail with git's "bad
  // object" text, which can name a different ref. The failure must name the
  // dangling ref, its local object, origin's value, and the verified-delete cure.
  it("names each dangling ref with origin's value and the cure, instead of 'probably repo corruption'", async () => {
    const root = temporaryRoot("dangling")
    const origin = join(root, "origin")
    const clone = join(root, "clone")
    const run = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      })
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`)
      return result.stdout.trim()
    }
    spawnSync("git", ["init", "-q", "-b", "main", origin])
    run(origin, "commit", "-q", "--allow-empty", "-m", "one")
    spawnSync("git", ["clone", "-q", origin, clone])
    const ref = "refs/yrd/main/task/lost@abc"
    const lost = run(clone, "commit-tree", run(clone, "write-tree"), "-p", "HEAD", "-m", "record")
    run(clone, "update-ref", ref, lost)
    run(clone, "pack-refs", "--all")
    const { rmSync } = await import("node:fs")
    rmSync(join(clone, ".git", "objects", lost.slice(0, 2), lost.slice(2)))
    run(origin, "commit", "-q", "--allow-empty", "-m", "two")

    const failure = gitRunner.readRemoteCommit(gitIn(clone), "origin", "refs/heads/main")

    await expect(failure).rejects.toThrow(`${ref} local=${lost} origin=absent object missing locally`)
    await expect(failure).rejects.toThrow(`git update-ref -d ${ref} ${lost}`)
    await expect(failure).rejects.not.toThrow(/probably due to repo corruption/u)
  })

  it("gitSuperExecution preserves raw stderr and heartbeat lines in evidence (25475)", async () => {
    const root = temporaryRoot("git-super-evidence")
    const log = openLog(join(root, "logs"))
    const heartbeat = "git-super push: select-root 0/1 +0ms\ngit-super push: plan 0/1 +10000ms\n"
    const fakeProcess: Process = {
      async close() {},
      async [Symbol.asyncDispose]() {
        await this.close()
      },
      async run(request) {
        request.onOutput?.({ stream: "stdout", chunk: new TextEncoder().encode('{"state":"updated"}\n') })
        request.onOutput?.({ stream: "stderr", chunk: new TextEncoder().encode(heartbeat) })
        return {
          durationMs: 0,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: '{"state":"updated"}',
          stderr: heartbeat,
        }
      },
    }
    const result = await gitSuperExecution(
      {
        process: fakeProcess,
        gitOptions: {
          openOutput: log.openGitOutput,
          onInvocation: log.writeGitInvocation,
        },
      },
      root,
      ["push", "--recurse-submodules=only", "origin", "main"],
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe(heartbeat)

    const rows = readRunLog(join(root, "logs"), log.id)
    const pushRow = rows.find((r) => r.kind === "git" && Array.isArray(r.args) && r.args.includes("push"))
    expect(pushRow).toBeDefined()
    expect(typeof pushRow!.evidence).toBe("string")

    const evidence = JSON.parse(readFileSync(String(pushRow!.evidence), "utf8")) as {
      artifacts: { stdout: string; stderr: string }
    }
    expect(existsSync(evidence.artifacts.stderr)).toBe(true)
    expect(readFileSync(evidence.artifacts.stderr, "utf8")).toBe(heartbeat)
  })

  it("gitSuperExecution logs publication failure loudly rather than throwing after a successful push (25517)", async () => {
    const root = temporaryRoot("gse-pub-failure")
    const log = openLog(join(root, "logs"))
    const fakeProcess: Process = {
      async close() {},
      async [Symbol.asyncDispose]() {},
      async run(request) {
        request.onOutput?.({ stream: "stdout", chunk: new TextEncoder().encode('{"state":"updated"}\n') })
        return {
          durationMs: 0,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: '{"state":"updated"}',
          stderr: "",
        }
      },
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const result = await gitSuperExecution(
        {
          process: fakeProcess,
          gitOptions: {
            openOutput: log.openGitOutput,
            onInvocation: () => {
              throw new Error("disk full while writing evidence")
            },
          },
        },
        root,
        ["push", "--recurse-submodules=only", "origin", "main"],
      )
      expect(result.exitCode).toBe(0)
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Git evidence publication failed: Error: disk full while writing evidence/),
      )
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/raw stdout: .*1\.stdout\.bin; raw stderr: .*1\.stderr\.bin/),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("gitSuperExecution records a timed-out push as incomplete and throws (25517)", async () => {
    const root = temporaryRoot("gse-timeout")
    const log = openLog(join(root, "logs"))
    const fakeProcess: Process = {
      async close() {},
      async [Symbol.asyncDispose]() {},
      async run() {
        return {
          durationMs: 5000,
          exitCode: null as never,
          signal: "SIGKILL" as never,
          timedOut: true,
          stdout: "",
          stderr: "timed out waiting for lock\n",
        }
      },
    }
    let handedInvocation: gitRunner.GitInvocation | undefined
    await expect(
      gitSuperExecution(
        {
          process: fakeProcess,
          gitOptions: {
            openOutput: log.openGitOutput,
            onInvocation: (inv) => {
              handedInvocation = inv
            },
          },
        },
        root,
        ["push", "--recurse-submodules=only", "origin", "main"],
      ),
    ).rejects.toThrow(/did not settle normally/)

    expect(handedInvocation).toBeDefined()
    expect(handedInvocation!.failure).toMatch(/timedOut=true/)
    expect(handedInvocation!.artifacts).toBeDefined()
    expect(handedInvocation!.artifacts!.complete).toBe(false)
  })

  it("gitSuperExecution drops fallback file write and relies on streaming output (25517)", async () => {
    const root = temporaryRoot("gse-no-fallback-write")
    const log = openLog(join(root, "logs"))
    const fakeProcess: Process = {
      async close() {},
      async [Symbol.asyncDispose]() {},
      async run() {
        return {
          durationMs: 0,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: '{"state":"updated"}',
          stderr: "buffered output not streamed to onOutput",
        }
      },
    }
    let handedInvocation: gitRunner.GitInvocation | undefined
    const result = await gitSuperExecution(
      {
        process: fakeProcess,
        gitOptions: {
          openOutput: log.openGitOutput,
          onInvocation: (inv) => {
            handedInvocation = inv
          },
        },
      },
      root,
      ["push", "--recurse-submodules=only", "origin", "main"],
    )
    expect(result.exitCode).toBe(0)
    expect(handedInvocation).toBeDefined()
    expect(handedInvocation!.artifacts).toBeDefined()
    // The fallback write is dropped: unstreamed runner output is not written into the sink file
    expect(readFileSync(handedInvocation!.artifacts!.stderr, "utf8")).toBe("")
  })
})
