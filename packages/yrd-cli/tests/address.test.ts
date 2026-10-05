/**
 * @failure Two spellings of one queue make two clones, or two queues in one
 * repository share a clone/ref directory, or a run address resolves under a
 * different queue/number, so host-started work reads the wrong authority.
 * @level l1 (pure address and path boundary)
 * @consumer Queue-owner commands invoked outside a clone.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import {
  formatQueueAddress,
  legacyQueueDirectory,
  parseQueueAddress,
  parseRunAddress,
  queueDirectory,
  queueRoot,
} from "../src/address.ts"

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

  it.each(["beorn/hh@release@2026", "beorn/hh@release#2026", "beorn/hh@release%4a"])(
    "refuses an unescaped or unsupported branch delimiter %s (26193)",
    (operand) => {
      expect(() => parseQueueAddress(operand)).toThrow(`queue address '${operand}'`)
    },
  )

  it("uses one v2 stored key for a # branch while keeping the human run address and physical path (26201)", () => {
    const address = parseQueueAddress("beorn/hh@release%232026")
    expect(address.canonical).toBe("v2#github.com%2Fbeorn%2Fhh#release%232026")
    expect(parseQueueAddress(address.canonical)).toEqual(address)
    expect(formatQueueAddress(address)).toBe("github.com/beorn/hh@release%232026")
    expect(parseRunAddress("beorn/hh@release%232026#3")).toMatchObject({
      canonical: "github.com/beorn/hh@release%232026#3",
      queue: { canonical: address.canonical },
    })
    expect(queueRoot("/state/yrd", address)).toBe("/state/yrd/github.com/beorn/hh~release%232026")
  })

  it("keeps a versioned short-path remote distinct from a GitHub owner/repo shorthand (26201)", () => {
    const stored = parseQueueAddress("v2#example.test%2Frepo#release%232026")
    expect(stored.canonical).toBe("v2#example.test%2Frepo#release%232026")
    const human = formatQueueAddress(stored)
    expect(human).toBe("https://example.test/repo@release%232026")
    expect(parseQueueAddress(human).canonical).toBe(stored.canonical)
  })

  it.each([
    ["v2#github.com%2Fbeorn%2Fhh#main", /v2.*requires.*#/u],
    ["v2#github.com%2fbeorn%2fhh#release%232026", /canonical/u],
    ["v2#github.com%2Fbeorn%2Fhh#release%FF2026", /UTF-8/u],
    ["v2#github.com%2Fbeorn%2Fhh#", /empty/u],
    ["v3#github.com%2Fbeorn%2Fhh#release%232026", /unknown.*version/u],
  ])("refuses invalid stored key %s by name (26201)", (key, problem) => {
    expect(() => parseQueueAddress(key)).toThrow(problem)
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
      join("/state/yrd", `forge.example:${port}`, "team", "repo~main", "repo"),
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

  it("uses the tilde physical separator without changing the canonical address or the queue component (27065)", () => {
    const workdir = "/state/yrd"
    const main = parseQueueAddress("beorn/hh#main")
    const release = parseQueueAddress("beorn/hh#release/1.x")
    const percent = parseQueueAddress("beorn/hh#release%2F1.x")

    expect(queueRoot(workdir, main)).toBe(join(workdir, "github.com", "beorn", "hh~main"))
    expect(queueDirectory(workdir, main)).toBe(join(workdir, "github.com", "beorn", "hh~main", "repo"))
    expect(queueDirectory(workdir, release)).toBe(join(workdir, "github.com", "beorn", "hh~release%2F1.x", "repo"))
    expect(queueDirectory(workdir, percent)).toBe(join(workdir, "github.com", "beorn", "hh~release%252F1.x", "repo"))
    expect(queueDirectory(workdir, release)).not.toBe(queueDirectory(workdir, main))
  })

  it("names the workdir from the repo that produced %23 today with no percent or hash byte (27065)", () => {
    const address = parseQueueAddress("beorn/hh-dev#main")
    const root = queueRoot("/hh/var/yrd-workdir", address)
    expect(root).toBe("/hh/var/yrd-workdir/github.com/beorn/hh-dev~main")
    // The failing class: module loaders percent-decode 0x25 0x32 0x33 back to a hash and then cannot resolve.
    expect(root).not.toContain("%23")
    expect(root).not.toContain("#")
    // A queue component never carries a tilde (git refnames forbid it), so the LAST tilde is the boundary.
    expect(root.slice(root.lastIndexOf("~") + 1)).toBe("main")
  })

  it("keeps a repository path with its own tilde unambiguous: the LAST tilde is the boundary (27065)", () => {
    const address = parseQueueAddress("forge.example/team/re~po#main")
    const root = queueRoot("/state/yrd", address)
    expect(root).toBe(join("/state/yrd", "forge.example", "team", "re~po~main"))
    expect(root.slice(root.lastIndexOf("~") + 1)).toBe("main")
  })

  it("spells the pre-27065 legacy root only so the cutover refusal can name it (27065)", () => {
    const workdir = "/state/yrd"
    expect(legacyQueueDirectory(workdir, parseQueueAddress("beorn/hh#main"))).toBe(
      join(workdir, "github.com", "beorn", "hh%23main", "repo"),
    )
    expect(legacyQueueDirectory(workdir, parseQueueAddress("beorn/hh#release/1.x"))).toBe(
      join(workdir, "github.com", "beorn", "hh%23release%2F1.x", "repo"),
    )
    expect(legacyQueueDirectory(workdir, parseQueueAddress("/tmp/remote.git#main"))).toBe(
      join(workdir, "local", "tmp", "remote.git%23main", "repo"),
    )
  })

  it("imports a module from the env path a %23 name produced today (27065 regression)", async () => {
    const base = mkdtempSync(join(tmpdir(), "yrd-27065-"))
    const address = parseQueueAddress("github.com/beorn/hh-dev#main")
    const root = queueRoot(base, address)
    const envDir = join(root, "environments", "26964-qualified-composition")
    mkdirSync(envDir, { recursive: true })
    // The exact failure: Vitest/koffi decode `%23` to `#` and look under a path that does not exist.
    expect(envDir).not.toContain("%")
    expect(envDir).not.toContain("#")
    const probe = join(envDir, "probe.mjs")
    writeFileSync(probe, "export const loaded = true\n")
    const href = pathToFileURL(probe).href
    // A loader that reads the URL pathname and decodes it must still land on the real directory.
    expect(decodeURIComponent(new URL(href).pathname)).toBe(probe)
    const loaded = (await import(href)) as { loaded: boolean }
    expect(loaded.loaded).toBe(true)
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
    expect(queueDirectory("/state/yrd", address)).toBe("/state/yrd/local/tmp/remote.git~main/repo")
  })

  it.each(["beorn/hh", "beorn/hh#", "#main", "beorn/hh#main#other", "https:///forge.example:8443/team/repo.git#main"])(
    "refuses malformed queue address %s with the operand and grammar",
    (operand) => {
      expect(() => parseQueueAddress(operand)).toThrow(`queue address '${operand}'`)
      expect(() => parseQueueAddress(operand)).toThrow("<repo>#<queue>")
    },
  )
})
