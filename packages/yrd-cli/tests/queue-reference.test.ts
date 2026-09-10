/**
 * @failure The queue-owned clone is handed to every compose without an object store for a
 *          single gitlink, so `yrd check`, `yrd env` and every queue run clone from the network.
 * @level   l2 (a real local remote with a real submodule, and the real queue-owned clone)
 * @consumer every command that resolves a queue location and then composes from it
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn } from "@yrd/queue-core"
import { resolveQueueLocation } from "../src/queue-location.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=queue-reference@yrd.test", "-c", "user.name=yrd"] as const

async function repository(path: string, file: string): Promise<void> {
  mkdirSync(path, { recursive: true })
  const git = gitIn(path)
  await git(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(path, file), `${file}\n`)
  await git(["add", "--all"])
  await git([...author, "commit", "--quiet", "--message", `add ${file}`])
}

describe("resolveQueueLocation", () => {
  it("returns a queue-owned clone every gitlink can be borrowed from", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-cli-queue-reference-"))
    roots.push(root)
    const dependency = join(root, "dependency")
    const product = join(root, "product")
    await repository(dependency, "dep.txt")
    await repository(product, "product.txt")
    const productGit = gitIn(product)
    await productGit(["submodule", "add", "--quiet", dependency, "vendor/dep"])
    await productGit([...author, "commit", "--quiet", "--message", "add vendor/dep"])
    // Its own state root, so the test never reads or writes the machine's queue.
    const env = { ...process.env, XDG_STATE_HOME: join(root, "state") }
    const outside = join(root, "outside")
    mkdirSync(outside, { recursive: true })

    const location = await resolveQueueLocation(outside, `${product}#main`, env)

    // The clone itself is unchanged: `--no-checkout`, because the queue reads
    // objects out of it and never files.
    expect(existsSync(join(location.repo, "product.txt"))).toBe(false)
    expect(location.referenceStores.map(({ path }) => path)).toEqual(["vendor/dep"])
    const store = join(location.repo, "vendor/dep")
    expect((await gitIn(store)(["rev-parse", "--path-format=absolute", "--show-toplevel"])).trim()).toBe(store)
    expect(await gitIn(store)(["for-each-ref", "--format=%(refname)"])).toContain("refs/remotes/origin/main")

    // Opening the same queue again finds it self-contained and creates nothing.
    // A populate that ran per command would put a clone on the critical path of
    // every `yrd queue list`.
    const reopened = await resolveQueueLocation(outside, `${product}#main`, env)
    expect(reopened.repo).toBe(location.repo)
    expect(reopened.referenceStores).toEqual([])
  }, 60_000)
})
