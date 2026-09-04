/**
 * @failure Two spellings of one queue make two clones, or two queues in one
 * repository share a clone/ref directory, so host-started queue work reads or
 * writes the wrong authority.
 * @level l1 (pure address and path boundary)
 * @consumer Queue-owner commands invoked outside a clone.
 */
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseQueueAddress, queueDirectory, queueRoot } from "../src/address.ts"

describe("a queue's canonical address", () => {
  it("assumes github.com for owner/repo and builds transport from the canonical repository", () => {
    const address = parseQueueAddress("beorn/hh#main")
    expect(address).toMatchObject({
      canonical: "github.com/beorn/hh#main",
      host: "github.com",
      kind: "remote",
      path: "beorn/hh",
      queue: "main",
      transport: "https://github.com/beorn/hh.git",
    })
  })

  it("lowercases the host and strips scheme, trailing slash and .git", () => {
    expect(parseQueueAddress("https://GitHub.COM/beorn/hh.git/#release/1.x").canonical).toBe(
      "github.com/beorn/hh#release/1.x",
    )
  })

  it.each([
    ["https", 8443],
    ["https", 443],
    ["http", 80],
    ["ssh", 22],
  ])("preserves an explicit %s port %i in identity, transport and directory", (scheme, port) => {
    const address = parseQueueAddress(`${scheme}://Forge.EXAMPLE:${port}/team/repo.git#main`)
    expect(address).toMatchObject({
      canonical: `forge.example:${port}/team/repo#main`,
      host: `forge.example:${port}`,
      transport: `https://forge.example:${port}/team/repo.git`,
    })
    expect(queueDirectory("/state/yrd", address)).toBe(
      join("/state/yrd", `forge.example:${port}`, "team", "repo#main", "repo"),
    )
    expect(queueDirectory("/state/yrd", address)).not.toBe(
      queueDirectory("/state/yrd", parseQueueAddress("forge.example/team/repo#main")),
    )
  })

  it.each([
    "https://forge.example\\team:8443/repo.git#main",
    "https://forge.example:\t443/team/repo.git#main",
    "https://forge.example:443\r/team/repo.git#main",
    "https://forge.example:443\n/team/repo.git#main",
  ])("refuses URL-normalized authority spelling %j", (operand) => {
    expect(() => parseQueueAddress(operand)).toThrow("backslashes, tabs or newlines")
  })

  it("keeps repository path directories readable and encodes the queue as one final segment", () => {
    const workdir = "/state/yrd"
    const main = parseQueueAddress("beorn/hh#main")
    const release = parseQueueAddress("beorn/hh#release/1.x")
    const percent = parseQueueAddress("beorn/hh#release%2F1.x")

    expect(queueRoot(workdir, main)).toBe(join(workdir, "github.com", "beorn", "hh#main"))
    expect(queueDirectory(workdir, main)).toBe(join(workdir, "github.com", "beorn", "hh#main", "repo"))
    expect(queueDirectory(workdir, release)).toBe(join(workdir, "github.com", "beorn", "hh#release%2F1.x", "repo"))
    expect(queueDirectory(workdir, percent)).toBe(join(workdir, "github.com", "beorn", "hh#release%252F1.x", "repo"))
    expect(queueDirectory(workdir, release)).not.toBe(queueDirectory(workdir, main))
  })

  it("accepts an absolute local repository path for tests", () => {
    const address = parseQueueAddress("/tmp/remote.git#main")
    expect(address).toMatchObject({
      canonical: "/tmp/remote.git#main",
      kind: "local",
      queue: "main",
      repository: "/tmp/remote.git",
      transport: "/tmp/remote.git",
    })
    expect(queueDirectory("/state/yrd", address)).toBe("/state/yrd/local/tmp/remote.git#main/repo")
  })

  it.each(["beorn/hh", "beorn/hh#", "#main", "beorn/hh#main#other", "https:///forge.example:8443/team/repo.git#main"])(
    "refuses malformed queue address %s with the operand and grammar",
    (operand) => {
      expect(() => parseQueueAddress(operand)).toThrow(`queue address '${operand}'`)
      expect(() => parseQueueAddress(operand)).toThrow("<repo>#<queue>")
    },
  )
})
