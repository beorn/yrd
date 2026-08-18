/**
 * @failure PR publication grows a second fetch/push engine or publishes the root before its recorded component commit.
 * @level l1
 * @consumer @yrd/cli credential-bearing PR publisher
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess, type Process } from "@yrd/process"
import { afterEach, describe, expect, it } from "vitest"
import { createPrPublicationService } from "../src/pr-publication.ts"
import { changedSubmodulePins, submodulePinPublications } from "../src/pr-submodule-publication.ts"

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
  it("discovers changed pins via git-super and judges each against its component's main", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yrd-pr-pin-availability-"))
    roots.push(fixture)
    const component = join(fixture, "component")
    const componentRemote = join(fixture, "component.git")
    const root = join(fixture, "root")

    await repository(component)
    await writeFile(join(component, "component.txt"), "one\n")
    await git(component, ["add", "component.txt"])
    await git(component, ["commit", "-qm", "component one"])
    await git(fixture, ["init", "-q", "--bare", "-b", "main", componentRemote])
    await git(component, ["remote", "add", "origin", componentRemote])
    await git(component, ["push", "-q", "-u", "origin", "main"])

    await repository(root)
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", component, "dep"])
    await git(root, ["commit", "-qam", "record component one"])
    const baseSha = await git(root, ["rev-parse", "HEAD"])
    await git(join(root, "dep"), ["remote", "set-url", "origin", componentRemote])

    await writeFile(join(component, "component.txt"), "two\n")
    await git(component, ["commit", "-qam", "component two"])
    const pin = await git(component, ["rev-parse", "HEAD"])
    await git(join(root, "dep"), ["fetch", "-q", component, pin])
    await git(join(root, "dep"), ["checkout", "-q", pin])
    await git(root, ["add", "dep"])
    await git(root, ["commit", "-qm", "record component two"])
    const headSha = await git(root, ["rev-parse", "HEAD"])

    await using process = createProcess()
    const changed = await changedSubmodulePins({ process, repo: root, baseSha, headSha })
    expect(changed).toEqual([{ path: "dep", pin, repository: join(root, "dep") }])
    // Before the component lands the commit on its main: off it, with main's sha named.
    const mainBefore = await git(componentRemote, ["rev-parse", "refs/heads/main"])
    await expect(submodulePinPublications({ process, pins: changed })).resolves.toEqual([
      { state: "off-component-main", pin: changed[0], mainSha: mainBefore },
    ])

    await git(component, ["push", "-q", "origin", "main"])
    await expect(submodulePinPublications({ process, pins: changed })).resolves.toEqual([
      { state: "on-component-main", pin: changed[0] },
    ])
  })

  it("reports an unreachable component origin as undetermined, never as off-main", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yrd-pr-pin-undetermined-"))
    roots.push(fixture)
    const component = join(fixture, "component")
    const root = join(fixture, "root")

    await repository(component)
    await writeFile(join(component, "component.txt"), "one\n")
    await git(component, ["add", "component.txt"])
    await git(component, ["commit", "-qm", "component one"])

    await repository(root)
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", component, "dep"])
    await git(root, ["commit", "-qam", "record component one"])
    const baseSha = await git(root, ["rev-parse", "HEAD"])

    await writeFile(join(component, "component.txt"), "two\n")
    await git(component, ["commit", "-qam", "component two"])
    const pin = await git(component, ["rev-parse", "HEAD"])
    await git(join(root, "dep"), ["fetch", "-q", component, pin])
    await git(join(root, "dep"), ["checkout", "-q", pin])
    await git(root, ["add", "dep"])
    await git(root, ["commit", "-qm", "record component two"])
    const headSha = await git(root, ["rev-parse", "HEAD"])

    // The component's origin stops existing between the author's fetch and the gate's probe.
    await git(join(root, "dep"), ["remote", "set-url", "origin", join(fixture, "gone.git")])

    await using process = createProcess()
    const changed = await changedSubmodulePins({ process, repo: root, baseSha, headSha })
    const publications = await submodulePinPublications({ process, pins: changed })

    // "Could not tell" and "not on main" have opposite remedies — one says land the commit,
    // the other says the probe never reached the component — so the state must say which.
    expect(publications).toHaveLength(1)
    expect(publications[0]).toMatchObject({ state: "undetermined", pin: changed[0] })
    const undetermined = publications[0] as Extract<(typeof publications)[number], { state: "undetermined" }>
    expect(undetermined.reason).toContain("could not refresh component main")
  })

  it("delegates exact component-first and root-last publication to git-super", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "yrd-pr-publication-"))
    roots.push(fixture)
    const componentSource = join(fixture, "component-source")
    const rootSource = join(fixture, "root-source")
    const componentDestination = join(fixture, "component-destination")
    const rootDestination = join(fixture, "root-destination")
    const componentRemote = join(fixture, "component.git")
    const rootRemote = join(fixture, "root.git")

    await repository(componentSource)
    await writeFile(join(componentSource, "component.txt"), "published\n")
    await git(componentSource, ["add", "component.txt"])
    await git(componentSource, ["commit", "-qm", "component"])
    const componentPin = await git(componentSource, ["rev-parse", "HEAD"])

    await repository(rootSource)
    await git(rootSource, ["commit", "-qm", "base", "--allow-empty"])
    const baseSha = await git(rootSource, ["rev-parse", "HEAD"])
    await git(rootSource, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", componentSource, "dep"])
    await git(rootSource, ["commit", "-qam", "record component"])
    const headSha = await git(rootSource, ["rev-parse", "HEAD"])

    await git(fixture, ["init", "-q", "--bare", "-b", "main", componentRemote])
    await git(fixture, ["init", "-q", "--bare", "-b", "main", rootRemote])
    await repository(componentDestination)
    await git(componentDestination, ["remote", "add", "origin", componentRemote])
    await repository(rootDestination)
    await git(rootDestination, ["remote", "add", "origin", rootRemote])
    await mkdir(join(rootDestination, "dep"), { recursive: true })
    await git(join(rootDestination, "dep"), ["init", "-q", "-b", "main"])
    await git(join(rootDestination, "dep"), ["remote", "add", "origin", componentRemote])

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
    const service = createPrPublicationService({ repo: rootDestination, process })

    const result = await service.publish(
      {
        pr: "PR1",
        revision: 1,
        headSha,
        baseSha,
        branch: "issue/publication",
        sourceRoot: rootSource,
        components: [{ path: "dep", pin: componentPin }],
        continuation: "none",
      },
      { id: "publication-test", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(result).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: {
        refs: [
          { path: "dep", sha: componentPin, ref: "refs/heads/issue/publication" },
          { path: ".", sha: headSha, ref: "refs/heads/issue/publication" },
        ],
      },
    })
    expect(pushes).toEqual([join(rootSource, "dep"), rootSource])
    expect(await git(componentRemote, ["rev-parse", "refs/heads/issue/publication"])).toBe(componentPin)
    expect(await git(rootRemote, ["rev-parse", "refs/heads/issue/publication"])).toBe(headSha)
  })
})
