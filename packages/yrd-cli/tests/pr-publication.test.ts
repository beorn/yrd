/**
 * @failure PR publication grows a second fetch/push engine or publishes the root before its recorded submodule commit.
 * @level l1
 * @consumer @yrd/cli credential-bearing PR publisher
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess, type Process } from "@yrd/process"
import { afterEach, describe, expect, it } from "vitest"
import { createChangePublicationService } from "../src/pr-publication.ts"
import { addedSubmodulePins, changedSubmodulePins, submodulePinPublications } from "../src/pr-submodule-publication.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(path, ["init", "-q", "-b", "main"])
  await git(path, ["config", "user.name", "Yrd Test"])
  await git(path, ["config", "user.email", "yrd@example.invalid"])
}

describe("PR publication Git transport", () => {
  it("discovers changed pins via git-super and judges each against its submodule's main", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yrd-pr-pin-availability-"))
    roots.push(fixture)
    const submodule = join(fixture, "submodule")
    const submoduleRemote = join(fixture, "submodule.git")
    const root = join(fixture, "root")

    await repository(submodule)
    await writeFile(join(submodule, "submodule.txt"), "one\n")
    await git(submodule, ["add", "submodule.txt"])
    await git(submodule, ["commit", "-qm", "submodule one"])
    await git(fixture, ["init", "-q", "--bare", "-b", "main", submoduleRemote])
    await git(submodule, ["remote", "add", "origin", submoduleRemote])
    await git(submodule, ["push", "-q", "-u", "origin", "main"])

    await repository(root)
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "dep"])
    await git(root, ["commit", "-qam", "record submodule one"])
    const baseSha = await git(root, ["rev-parse", "HEAD"])
    await git(join(root, "dep"), ["remote", "set-url", "origin", submoduleRemote])

    await writeFile(join(submodule, "submodule.txt"), "two\n")
    await git(submodule, ["commit", "-qam", "submodule two"])
    const pin = await git(submodule, ["rev-parse", "HEAD"])
    await git(join(root, "dep"), ["fetch", "-q", submodule, pin])
    await git(join(root, "dep"), ["checkout", "-q", pin])
    await git(root, ["add", "dep"])
    await git(root, ["commit", "-qm", "record submodule two"])
    const headSha = await git(root, ["rev-parse", "HEAD"])

    await using process = createProcess()
    const changed = await changedSubmodulePins({ process, repo: root, baseSha, headSha })
    expect(changed).toEqual([{ path: "dep", pin, repository: join(root, "dep") }])
    // Before the submodule lands the commit on its main: off it, with main's sha named.
    const mainBefore = await git(submoduleRemote, ["rev-parse", "refs/heads/main"])
    await expect(submodulePinPublications({ process, pins: changed })).resolves.toEqual([
      { state: "off-component-main", pin: changed[0], mainSha: mainBefore },
    ])

    await git(submodule, ["push", "-q", "origin", "main"])
    await expect(submodulePinPublications({ process, pins: changed })).resolves.toEqual([
      { state: "on-component-main", pin: changed[0] },
    ])
  })

  it("reports an unreachable submodule origin as undetermined, never as off-main", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yrd-pr-pin-undetermined-"))
    roots.push(fixture)
    const submodule = join(fixture, "submodule")
    const root = join(fixture, "root")

    await repository(submodule)
    await writeFile(join(submodule, "submodule.txt"), "one\n")
    await git(submodule, ["add", "submodule.txt"])
    await git(submodule, ["commit", "-qm", "submodule one"])

    await repository(root)
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "dep"])
    await git(root, ["commit", "-qam", "record submodule one"])
    const baseSha = await git(root, ["rev-parse", "HEAD"])

    await writeFile(join(submodule, "submodule.txt"), "two\n")
    await git(submodule, ["commit", "-qam", "submodule two"])
    const pin = await git(submodule, ["rev-parse", "HEAD"])
    await git(join(root, "dep"), ["fetch", "-q", submodule, pin])
    await git(join(root, "dep"), ["checkout", "-q", pin])
    await git(root, ["add", "dep"])
    await git(root, ["commit", "-qm", "record submodule two"])
    const headSha = await git(root, ["rev-parse", "HEAD"])

    // The submodule's origin stops existing between the author's fetch and the gate's probe.
    await git(join(root, "dep"), ["remote", "set-url", "origin", join(fixture, "gone.git")])

    await using process = createProcess()
    const changed = await changedSubmodulePins({ process, repo: root, baseSha, headSha })
    const publications = await submodulePinPublications({ process, pins: changed })

    // "Could not tell" and "not on main" have opposite remedies — one says land the commit,
    // the other says the probe never reached the submodule — so the state must say which.
    expect(publications).toHaveLength(1)
    expect(publications[0]).toMatchObject({ state: "undetermined", pin: changed[0] })
    const undetermined = publications[0] as Extract<(typeof publications)[number], { state: "undetermined" }>
    expect(undetermined.reason).toContain("could not refresh submodule main")
  })

  it("delegates exact component-first and root-last publication to git-super", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yrd-pr-publication-"))
    roots.push(fixture)
    const submoduleSource = join(fixture, "component-source")
    const rootSource = join(fixture, "root-source")
    const submoduleDestination = join(fixture, "component-destination")
    const rootDestination = join(fixture, "root-destination")
    const submoduleRemote = join(fixture, "submodule.git")
    const rootRemote = join(fixture, "root.git")

    await repository(submoduleSource)
    await writeFile(join(submoduleSource, "submodule.txt"), "published\n")
    await git(submoduleSource, ["add", "submodule.txt"])
    await git(submoduleSource, ["commit", "-qm", "submodule"])
    const submodulePin = await git(submoduleSource, ["rev-parse", "HEAD"])

    await repository(rootSource)
    await git(rootSource, ["commit", "-qm", "base", "--allow-empty"])
    const baseSha = await git(rootSource, ["rev-parse", "HEAD"])
    await git(rootSource, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSource, "dep"])
    await git(rootSource, ["commit", "-qam", "record submodule"])
    const headSha = await git(rootSource, ["rev-parse", "HEAD"])

    await git(fixture, ["init", "-q", "--bare", "-b", "main", submoduleRemote])
    await git(fixture, ["init", "-q", "--bare", "-b", "main", rootRemote])
    await repository(submoduleDestination)
    await git(submoduleDestination, ["remote", "add", "origin", submoduleRemote])
    await repository(rootDestination)
    await git(rootDestination, ["remote", "add", "origin", rootRemote])
    await mkdir(join(rootDestination, "dep"), { recursive: true })
    await git(join(rootDestination, "dep"), ["init", "-q", "-b", "main"])
    await git(join(rootDestination, "dep"), ["remote", "add", "origin", submoduleRemote])

    await using local = createProcess()
    const pushes: string[] = []
    const process: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("push")) {
          pushes.push(request.argv[2] ?? "missing")
        }
        return local.run(request)
      },
    }
    const service = createChangePublicationService({ repo: rootDestination, process })

    const result = await service.publish(
      {
        pr: "PR1",
        revision: 1,
        headSha,
        baseSha,
        branch: "issue/publication",
        sourceRoot: rootSource,
        components: [{ path: "dep", pin: submodulePin }],
        continuation: "none",
      },
      { id: "publication-test", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(result).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: {
        refs: [
          { path: "dep", sha: submodulePin, ref: "refs/heads/issue/publication" },
          { path: ".", sha: headSha, ref: "refs/heads/issue/publication" },
        ],
      },
    })
    expect(pushes).toEqual([join(rootSource, "dep"), rootSource])
    expect(await git(submoduleRemote, ["rev-parse", "refs/heads/issue/publication"])).toBe(submodulePin)
    expect(await git(rootRemote, ["rev-parse", "refs/heads/issue/publication"])).toBe(headSha)
  })
})

describe("addedSubmodulePins", () => {
  it("names a newly added gitlink, distinct from an existing one whose value moved", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yrd-pr-pin-added-"))
    roots.push(fixture)
    const submoduleA = join(fixture, "component-a")
    const submoduleB = join(fixture, "component-b")
    const root = join(fixture, "root")

    await repository(submoduleA)
    await writeFile(join(submoduleA, "a.txt"), "one\n")
    await git(submoduleA, ["add", "a.txt"])
    await git(submoduleA, ["commit", "-qm", "a one"])

    await repository(submoduleB)
    await writeFile(join(submoduleB, "b.txt"), "one\n")
    await git(submoduleB, ["add", "b.txt"])
    await git(submoduleB, ["commit", "-qm", "b one"])

    await repository(root)
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleA, "dep-a"])
    await git(root, ["commit", "-qam", "record submodule a"])
    const baseSha = await git(root, ["rev-parse", "HEAD"])

    // Base changes: an EXISTING gitlink (dep-a) advances, and a NEW gitlink (dep-b) is added.
    await writeFile(join(submoduleA, "a.txt"), "two\n")
    await git(submoduleA, ["commit", "-qam", "a two"])
    const pinA = await git(submoduleA, ["rev-parse", "HEAD"])
    await git(join(root, "dep-a"), ["fetch", "-q", submoduleA, pinA])
    await git(join(root, "dep-a"), ["checkout", "-q", pinA])
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleB, "dep-b"])
    await git(root, ["add", "dep-a"])
    await git(root, ["commit", "-qam", "advance dep-a, add dep-b"])
    const headSha = await git(root, ["rev-parse", "HEAD"])

    await using process = createProcess()
    const changed = await changedSubmodulePins({ process, repo: root, baseSha, headSha })
    expect(changed.map((pin) => pin.path)).toEqual(["dep-a", "dep-b"])

    const added = await addedSubmodulePins({ process, repo: root, baseSha, pins: changed })
    expect(added.map((pin) => pin.path)).toEqual(["dep-b"])
  })

  it("reports nothing added when every changed pin already existed at the base", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yrd-pr-pin-added-none-"))
    roots.push(fixture)
    const submodule = join(fixture, "submodule")
    const root = join(fixture, "root")

    await repository(submodule)
    await writeFile(join(submodule, "c.txt"), "one\n")
    await git(submodule, ["add", "c.txt"])
    await git(submodule, ["commit", "-qm", "c one"])

    await repository(root)
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "dep"])
    await git(root, ["commit", "-qam", "record submodule"])
    const baseSha = await git(root, ["rev-parse", "HEAD"])

    await writeFile(join(submodule, "c.txt"), "two\n")
    await git(submodule, ["commit", "-qam", "c two"])
    const pin = await git(submodule, ["rev-parse", "HEAD"])
    await git(join(root, "dep"), ["fetch", "-q", submodule, pin])
    await git(join(root, "dep"), ["checkout", "-q", pin])
    await git(root, ["add", "dep"])
    await git(root, ["commit", "-qm", "advance dep"])
    const headSha = await git(root, ["rev-parse", "HEAD"])

    await using process = createProcess()
    const changed = await changedSubmodulePins({ process, repo: root, baseSha, headSha })
    await expect(addedSubmodulePins({ process, repo: root, baseSha, pins: changed })).resolves.toEqual([])
  })
})
