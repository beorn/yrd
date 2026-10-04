/**
 * @failure A queue's clone and name are read through `git remote get-url`, which expands
 *          `url.<base>.insteadOf`, so under any host-level transport rewrite (a lab fence, an
 *          ssh-to-https mapping) every command refuses its own owned clone as mismatched, and a
 *          queue named from inside a clone gets a second name, the rewritten path.
 * @level   l2 (a real repository reached through a real insteadOf rewrite in a test HOME, and the
 *          real queue-owned clone)
 * @consumer every command that resolves a queue location for a hosted address
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { queueName, remoteUrl } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { parseQueueAddress } from "../src/address.ts"
import { resolveDeclaredQueueLocations, resolveQueueLocation } from "../src/queue-location.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const author = ["-c", "user.email=queue-owned-clone@yrd.test", "-c", "user.name=yrd"] as const
// A host that never resolves: the rewrite is the only way to the repository, so a pass proves the
// clone went through the rewrite rather than the network.
const transport = "https://yrd-owned-clone.invalid/org/product.git"
const address = "yrd-owned-clone.invalid/org/product#main"

type Fixture = Readonly<{ root: string; product: string; env: NodeJS.ProcessEnv; outside: string }>

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-owned-clone-rewrite-"))
  roots.push(root)
  const product = join(root, "product")
  mkdirSync(product, { recursive: true })
  const productGit = gitIn(product)
  await productGit(["init", "--quiet", "--initial-branch=main"])
  writeFileSync(join(product, "product.txt"), "product\n")
  await productGit(["add", "--all"])
  await productGit([...author, "commit", "--quiet", "--message", "add product.txt"])

  // The rewrite lives in a test HOME, the way a host or the lab declares one.
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, ".gitconfig"),
    ['[protocol "file"]', "\tallow = always", `[url "${product}"]`, `\tinsteadOf = ${transport}`, ""].join("\n"),
  )
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    // Its own state root, so the test never reads or writes the machine's queue.
    XDG_STATE_HOME: join(root, "state"),
  }
  const outside = join(root, "outside")
  mkdirSync(outside, { recursive: true })
  return { root, product, env, outside }
}

describe("resolveQueueLocation behind a transport rewrite", () => {
  it("accepts the owned clone whose declared origin is the address, whatever the transport resolves to", async () => {
    const { env, outside, product } = await fixture()

    const location = await resolveQueueLocation(outside, address, env)
    const clone = gitIn(location.repo, undefined, undefined, { env })
    expect((await clone(["config", "--get", "remote.origin.url"])).trim()).toBe(transport)
    // What git resolves the transport to is the rewrite, and that is not a mismatch.
    expect((await clone(["remote", "get-url", "origin"])).trim()).toBe(product)

    const reopened = await resolveQueueLocation(outside, address, env)
    expect(reopened.repo).toBe(location.repo)

    // A clone whose DECLARED origin is another address is still refused, loudly.
    await clone(["config", "remote.origin.url", "https://yrd-owned-clone.invalid/org/other.git"])
    await expect(resolveQueueLocation(outside, address, env)).rejects.toThrow(
      /has origin https:\/\/yrd-owned-clone\.invalid\/org\/other\.git, not https:\/\/yrd-owned-clone\.invalid\/org\/product\.git; move the mismatched clone aside/,
    )
  }, 60_000)

  it("names a queue from inside a clone by its declared url, the name queue commands compute", async () => {
    const { env, root } = await fixture()
    const inside = join(root, "inside")
    await gitIn(root, undefined, undefined, { env })(["clone", "--quiet", transport, inside])
    const git = gitIn(inside, undefined, undefined, { env })
    const commandsName = queueName({ branch: "main", remote: "origin" }, await remoteUrl(git, "origin"))

    // The origin's own queue, and the same queue named through the remote.
    const implicit = await resolveQueueLocation(inside, undefined, env, "reader")
    const named = await resolveQueueLocation(inside, "origin#main", env, "reader")

    expect(implicit.address?.canonical).toBe(address)
    expect(named.address?.canonical).toBe(address)
    expect(parseQueueAddress(commandsName).canonical).toBe(address)
  }, 60_000)

  /** @failure An addressed reader launched from another repository reads that caller's Git refs while naming the requested queue's workdir; a combined watch then shows the wrong queue's changes.
   * @level l2 @consumer bare watch aggregating two declared repository queues
   */
  it("reads an addressed queue from its own clone when launched inside a different repository", async () => {
    const { env, root } = await fixture()
    const inside = join(root, "inside")
    await gitIn(root, undefined, undefined, { env })(["clone", "--quiet", transport, inside])

    const other = join(root, "other")
    mkdirSync(other)
    const otherGit = gitIn(other, undefined, undefined, { env })
    await otherGit(["init", "--quiet", "--initial-branch=main"])
    writeFileSync(join(other, "other.txt"), "other queue\n")
    await otherGit(["add", "--all"])
    await otherGit([...author, "commit", "--quiet", "--message", "add other queue"])

    const requested = `${other}#main`
    const location = await resolveQueueLocation(inside, requested, env, "reader")
    expect(location.address?.canonical).toBe(requested)
    expect(location.repo).not.toBe(inside)
    expect((await gitIn(location.repo, undefined, undefined, { env })(["show", "main:other.txt"])).trim()).toBe(
      "other queue",
    )
  }, 60_000)

  /** @failure Bare watch resolves only its current repository, so a second declared queue's own changes and runner are invisible.
   * @level l2 @consumer bare watch reading the Yrd runner declaration
   */
  it("resolves two declared repositories to two queue-owned clones", async () => {
    const { env, root } = await fixture()
    const inside = join(root, "inside")
    await gitIn(root, undefined, undefined, { env })(["clone", "--quiet", transport, inside])

    const otherRemote = join(root, "other.git")
    const other = join(root, "other")
    const seed = gitIn(root, undefined, undefined, { env })
    await seed(["init", "--quiet", "--bare", "--initial-branch=main", otherRemote])
    await seed(["clone", "--quiet", otherRemote, other])
    const otherGit = gitIn(other, undefined, undefined, { env })
    writeFileSync(join(other, "other.txt"), "second queue\n")
    await otherGit(["add", "--all"])
    await otherGit([...author, "commit", "--quiet", "--message", "add second queue"])
    await otherGit(["push", "--quiet", "origin", "main"])

    const locations = await resolveDeclaredQueueLocations(
      root,
      [
        { serviceName: "yrd-code", repository: { name: "code", path: "inside" }, queue: { base: "main" } },
        { serviceName: "yrd-other", repository: { name: "other", path: "other" }, queue: { base: "main" } },
      ],
      env,
    )
    expect(locations).toHaveLength(2)
    const [first, second] = locations
    if (first?.kind !== "resolved" || second?.kind !== "resolved") {
      throw new Error(`both declared queues should resolve: ${JSON.stringify(locations)}`)
    }
    expect(first.location.address?.canonical).toBe(address)
    expect(second.location.address?.canonical).toBe(`${otherRemote}#main`)
    expect((await gitIn(first.location.repo, undefined, undefined, { env })(["show", "main:product.txt"])).trim()).toBe(
      "product",
    )
    expect((await gitIn(second.location.repo, undefined, undefined, { env })(["show", "main:other.txt"])).trim()).toBe(
      "second queue",
    )
  }, 60_000)
})

describe("the 27065 cutover refusal", () => {
  it("refuses to create a tilde root beside a legacy percent-escaped one, and creates nothing", async () => {
    const { env, outside, root } = await fixture()
    // The clone the pre-27065 builder would have written for this address.
    const legacy = join(root, "state", "yrd", "yrd-owned-clone.invalid", "org", "product%23main", "repo")
    mkdirSync(legacy, { recursive: true })
    const fresh = join(root, "state", "yrd", "yrd-owned-clone.invalid", "org", "product~main")

    await expect(resolveQueueLocation(outside, address, env)).rejects.toThrow(/refusing to create a second queue root/u)

    // No second root: the new tilde path was never created.
    expect(existsSync(fresh)).toBe(false)
    expect(existsSync(legacy)).toBe(true)
  })
})
