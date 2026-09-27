/**
 * @failure Two spellings of one queue make two clones, or two queues in one
 * repository share a clone/ref directory, or a run address resolves under a
 * different queue/number, so host-started work reads the wrong authority.
 * @level l1 (pure address and path boundary)
 * @consumer Queue-owner commands invoked outside a clone.
 */
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { formatQueueAddress, parseQueueAddress, parseRunAddress, queueDirectory, queueRoot } from "../src/address.ts"

describe("a queue's canonical address", () => {
  it("maps the decided human @ spelling onto the same stored queue key (26193)", () => {
    // ADR-0028 keeps ADR-0011's Git/workdir identity while changing the human spelling.
    // Existing tests cover only # input, so they cannot catch a second clone for @ input.
    expect(parseQueueAddress("beorn/hh@main").canonical).toBe(parseQueueAddress("beorn/hh#main").canonical)
  })

  it("refuses a numeric # suffix without an explicit queue branch (26193)", () => {
    // #123 could name a numeric branch or an unqualified run; choosing one silently changes identity.
    expect(() => parseQueueAddress("beorn/hh#123")).toThrow(/ambiguous/u)
  })

  it("preserves a legacy branch @ and decodes the new %40 spelling to the same key (26193)", () => {
    // The legacy delimiter is the first # even when @ occurs later in the branch.
    const legacy = parseQueueAddress("beorn/hh#release@2026")
    const human = parseQueueAddress("beorn/hh@release%402026")
    expect(legacy.queue).toBe("release@2026")
    expect(human.queue).toBe("release@2026")
    expect(human.canonical).toBe(legacy.canonical)
  })

  it("round-trips a literal percent without treating its tail as an escape (26193)", () => {
    const queue = parseQueueAddress("beorn/hh@release%2540")
    expect(queue.queue).toBe("release%40")
    expect(formatQueueAddress(queue)).toBe("github.com/beorn/hh@release%2540")
    expect(queue.canonical).toBe(parseQueueAddress("beorn/hh#release%40").canonical)
  })

  it.each(["beorn/hh@release@2026", "beorn/hh@release%402026%23", "beorn/hh@release%4a"])(
    "refuses an unescaped or unsupported branch delimiter %s (26193)",
    (operand) => {
      expect(() => parseQueueAddress(operand)).toThrow(`queue address '${operand}'`)
    },
  )

  it("refuses a # bearing branch even when escaped in the human form (26193)", () => {
    expect(() => parseQueueAddress("beorn/hh@release%232026")).toThrow(/#.*branch/u)
  })

  it("prints the one remote queue form and parses a numbered run under it (26193)", () => {
    const queue = parseQueueAddress("beorn/hh#release@2026")
    expect(formatQueueAddress(queue)).toBe("github.com/beorn/hh@release%402026")
    expect(parseRunAddress("beorn/hh@release%402026#3")).toMatchObject({
      canonical: "github.com/beorn/hh@release%402026#3",
      number: 3,
      queue: { canonical: queue.canonical },
    })
  })

  it.each(["beorn/hh@main#0", "beorn/hh@main#03", "beorn/hh@main#3x", "beorn/hh#3"])(
    "refuses an invalid or ambiguous run suffix %s (26193)",
    (operand) => {
      expect(() => parseRunAddress(operand)).toThrow()
    },
  )

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
      join("/state/yrd", `forge.example:${port}`, "team", "repo%23main", "repo"),
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

  it("encodes the physical separator and queue without changing the canonical address", () => {
    const workdir = "/state/yrd"
    const main = parseQueueAddress("beorn/hh#main")
    const release = parseQueueAddress("beorn/hh#release/1.x")
    const percent = parseQueueAddress("beorn/hh#release%2F1.x")

    expect(queueRoot(workdir, main)).toBe(join(workdir, "github.com", "beorn", "hh%23main"))
    expect(queueDirectory(workdir, main)).toBe(join(workdir, "github.com", "beorn", "hh%23main", "repo"))
    expect(queueDirectory(workdir, release)).toBe(join(workdir, "github.com", "beorn", "hh%23release%2F1.x", "repo"))
    expect(queueDirectory(workdir, percent)).toBe(join(workdir, "github.com", "beorn", "hh%23release%252F1.x", "repo"))
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
    expect(queueDirectory("/state/yrd", address)).toBe("/state/yrd/local/tmp/remote.git%23main/repo")
  })

  it.each(["beorn/hh", "beorn/hh#", "#main", "beorn/hh#main#other", "https:///forge.example:8443/team/repo.git#main"])(
    "refuses malformed queue address %s with the operand and grammar",
    (operand) => {
      expect(() => parseQueueAddress(operand)).toThrow(`queue address '${operand}'`)
      expect(() => parseQueueAddress(operand)).toThrow("<repo>#<queue>")
    },
  )
})
