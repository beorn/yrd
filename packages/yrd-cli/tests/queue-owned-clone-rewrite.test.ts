/**
 * @failure A queue's clone and name are read through `git remote get-url`, which expands
 *          `url.<base>.insteadOf`, so under any host-level transport rewrite (a lab fence, an
 *          ssh-to-https mapping) every command refuses its own owned clone as mismatched, and a
 *          queue named from inside a clone gets a second name, the rewritten path.
 * @level   l2 (a real repository reached through a real insteadOf rewrite in a test HOME, and the
 *          real queue-owned clone)
 * @consumer every command that resolves a queue location for a hosted address
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, queueName, remoteUrl } from "@yrd/queue-core"
import { parseQueueAddress } from "../src/address.ts"
import { resolveQueueLocation } from "../src/queue-location.ts"

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
})
