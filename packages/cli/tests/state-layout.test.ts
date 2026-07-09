import { dirname } from "node:path"
import { describe, expect, it } from "vitest"
import {
  classifyStateLayout,
  type StateLayoutFileSystem,
  type StatePathKind,
} from "../src/state-layout.ts"

const GIT_DIR = "/repo/.git"
const CURRENT_DIR = `${GIT_DIR}/yrd`
const LEGACY_DIR = `${GIT_DIR}/bay`

type FixtureNode = Readonly<{
  kind: Exclude<StatePathKind, "missing">
  text?: string
}>

function directory(): FixtureNode {
  return { kind: "directory" }
}

function file(text = ""): FixtureNode {
  return { kind: "file", text }
}

function fixture(nodes: Readonly<Record<string, FixtureNode>>): StateLayoutFileSystem {
  return {
    kind(path) {
      return Promise.resolve(nodes[path]?.kind ?? "missing")
    },
    readDir(path) {
      if (nodes[path]?.kind !== "directory") throw new Error(`not a directory: ${path}`)
      return Promise.resolve(Object.keys(nodes).filter((candidate) => dirname(candidate) === path))
        .then((paths) => paths.map((candidate) => candidate.slice(path.length + 1)))
    },
    readText(path) {
      const node = nodes[path]
      if (node?.kind !== "file") throw new Error(`not a file: ${path}`)
      return Promise.resolve(node.text ?? "")
    },
  }
}

function currentEvent(id = "event-1"): string {
  return JSON.stringify({
    id,
    ts: "2026-07-09T12:00:00.000Z",
    name: "bay/opened",
    cause: { commandId: "command-1", op: "bay.open" },
    data: { bay: "B1" },
  })
}

function legacyEvent(id = "legacy-1"): string {
  return JSON.stringify({
    id,
    ts: "2026-07-08T12:00:00.000Z",
    name: "bay/opened",
    cause: { commandId: "legacy-migration" },
    data: { bay: "B1" },
  })
}

describe("classifyStateLayout", () => {
  it("allows initialization only when every candidate state root is absent", async () => {
    const result = await classifyStateLayout({ gitDir: GIT_DIR, fs: fixture({}) })

    expect(result.kind).toBe("absent")
    expect(result.decision).toMatchObject({ action: "initialize", mayStart: true, mayCreate: true })
    expect(result.locations.map((location) => [location.path, location.kind])).toEqual([
      [CURRENT_DIR, "absent"],
      [LEGACY_DIR, "absent"],
    ])
  })

  it("opens current state only after validating cause.op event envelopes", async () => {
    const fs = fixture({
      [CURRENT_DIR]: directory(),
      [`${CURRENT_DIR}/events.jsonl`]: file(`${currentEvent()}\n`),
      [`${CURRENT_DIR}/index.sqlite`]: file("SQLite format 3"),
    })

    const result = await classifyStateLayout({ gitDir: GIT_DIR, fs })

    expect(result.kind).toBe("current")
    expect(result.decision).toMatchObject({ action: "open-current", mayStart: true, mayCreate: false })
    expect(result.locations[0]).toMatchObject({ kind: "current", eventFormat: "current" })
  })

  it("recognizes an index-only current store created before its first event", async () => {
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [CURRENT_DIR]: directory(),
        [`${CURRENT_DIR}/index.sqlite`]: file("SQLite format 3"),
        [`${CURRENT_DIR}/writer.lock`]: file("{}"),
      }),
    })

    expect(result.kind).toBe("current")
    expect(result.decision.action).toBe("open-current")
  })

  it("recognizes the managed receiver inbox and initialization lock as current state", async () => {
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [CURRENT_DIR]: directory(),
        [`${CURRENT_DIR}/index.sqlite`]: file("SQLite format 3"),
        [`${CURRENT_DIR}/prs.git`]: directory(),
        [`${CURRENT_DIR}/receiver-inbox`]: directory(),
        [`${CURRENT_DIR}/receiver-init`]: directory(),
      }),
    })

    expect(result.kind).toBe("current")
    expect(result.decision.action).toBe("open-current")
  })

  it("recognizes legacy v2 GitBay events by their missing cause.op", async () => {
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [LEGACY_DIR]: directory(),
        [`${LEGACY_DIR}/events.jsonl`]: file(`${legacyEvent()}\n`),
        [`${LEGACY_DIR}/index.sqlite`]: file("old sqlite"),
        [`${LEGACY_DIR}/prs.git`]: directory(),
      }),
    })

    expect(result.kind).toBe("legacy")
    expect(result.decision).toMatchObject({ action: "refuse", mayStart: false, mayCreate: false })
    expect(result.locations[1]).toMatchObject({ kind: "legacy", eventFormat: "legacy" })
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "legacy-gitbay-state", path: LEGACY_DIR })]),
    )
  })

  it("recognizes configured legacy roots without relying on a bay directory name", async () => {
    const configured = "/var/lib/integration-state"
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      legacyLocations: [
        { path: configured, source: "BAY_DIR" },
        { path: configured, source: "bay.dir" },
      ],
      fs: fixture({
        [configured]: directory(),
        [`${configured}/bay.db`]: file("sqlite"),
        [`${configured}/repo.git`]: directory(),
        [`${configured}/artifacts`]: directory(),
      }),
    })

    expect(result.kind).toBe("legacy")
    expect(result.locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: configured,
          kind: "legacy",
          sources: ["BAY_DIR", "bay.dir"],
        }),
      ]),
    )
  })

  it("treats legacy artifact directories as state rather than an absent root", async () => {
    const configured = "/state/gitbay"
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      legacyLocations: [{ path: configured, source: "BAY_DIR" }],
      fs: fixture({
        [configured]: directory(),
        [`${configured}/contests`]: directory(),
        [`${configured}/worktrees`]: directory(),
      }),
    })

    expect(result.kind).toBe("legacy")
    expect(result.decision.action).toBe("refuse")
  })

  it("recognizes old receiver inbox claims as legacy state", async () => {
    const configured = "/state/receiver"
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      legacyLocations: [{ path: configured, source: "bay.dir" }],
      fs: fixture({
        [configured]: directory(),
        [`${configured}/inbox.jsonl.processing.42`]: file(""),
      }),
    })

    expect(result.kind).toBe("legacy")
    expect(result.locations).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: configured, markers: ["inbox.jsonl.processing.42"] })]),
    )
  })

  it("refuses current and legacy roots that coexist", async () => {
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [CURRENT_DIR]: directory(),
        [`${CURRENT_DIR}/events.jsonl`]: file(currentEvent()),
        [LEGACY_DIR]: directory(),
        [`${LEGACY_DIR}/journal.jsonl`]: file(""),
      }),
    })

    expect(result.kind).toBe("mixed")
    expect(result.decision.action).toBe("refuse")
    expect(result.decision.diagnostic).toContain("choose one authoritative migration")
  })

  it("refuses current and legacy event envelopes mixed in one journal", async () => {
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [CURRENT_DIR]: directory(),
        [`${CURRENT_DIR}/events.jsonl`]: file(`${currentEvent()}\n${legacyEvent()}\n`),
      }),
    })

    expect(result.kind).toBe("mixed")
    expect(result.locations[0]).toMatchObject({ kind: "mixed", eventFormat: "mixed" })
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "mixed-event-generations" })]),
    )
  })

  it("classifies malformed event JSON as corrupt with its line number", async () => {
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [CURRENT_DIR]: directory(),
        [`${CURRENT_DIR}/events.jsonl`]: file(`${currentEvent()}\n{broken\n`),
      }),
    })

    expect(result.kind).toBe("corrupt")
    expect(result.decision.action).toBe("refuse")
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "corrupt-event-json", line: 2 })]),
    )
  })

  it("refuses an unrecognized event envelope instead of guessing its generation", async () => {
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [CURRENT_DIR]: directory(),
        [`${CURRENT_DIR}/events.jsonl`]: file(JSON.stringify({ hello: "world" })),
      }),
    })

    expect(result.kind).toBe("unknown")
    expect(result.decision.action).toBe("refuse")
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unknown-event-envelope", line: 1 })]),
    )
  })

  it("refuses current envelopes stored at a legacy candidate path", async () => {
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [LEGACY_DIR]: directory(),
        [`${LEGACY_DIR}/events.jsonl`]: file(currentEvent()),
        [`${LEGACY_DIR}/index.sqlite`]: file("SQLite format 3"),
      }),
    })

    expect(result.kind).toBe("unknown")
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "current-state-in-legacy-location" })]),
    )
  })

  it("recognizes an empty legacy event marker but refuses an empty current directory", async () => {
    const legacy = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [LEGACY_DIR]: directory(),
        [`${LEGACY_DIR}/events.jsonl`]: file("\n"),
      }),
    })
    const emptyCurrent = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({ [CURRENT_DIR]: directory() }),
    })

    expect(legacy.kind).toBe("legacy")
    expect(emptyCurrent.kind).toBe("unknown")
    expect(emptyCurrent.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "empty-state-directory" })]),
    )
  })

  it("refuses unknown entries and symlinked state markers", async () => {
    const unknown = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [CURRENT_DIR]: directory(),
        [`${CURRENT_DIR}/index.sqlite`]: file("SQLite format 3"),
        [`${CURRENT_DIR}/notes.txt`]: file("do not overwrite"),
      }),
    })
    const symlink = await classifyStateLayout({
      gitDir: GIT_DIR,
      fs: fixture({
        [CURRENT_DIR]: directory(),
        [`${CURRENT_DIR}/events.jsonl`]: { kind: "symlink" },
      }),
    })

    expect(unknown.kind).toBe("unknown")
    expect(unknown.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unknown-state-marker", marker: "notes.txt" })]),
    )
    expect(symlink.kind).toBe("unknown")
    expect(symlink.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid-state-marker-kind", marker: "events.jsonl" })]),
    )
  })

  it("deduplicates a configured legacy candidate that resolves to the current root", async () => {
    const result = await classifyStateLayout({
      gitDir: GIT_DIR,
      legacyLocations: [{ path: `${GIT_DIR}/other/../yrd`, source: "BAY_DIR" }],
      fs: fixture({
        [CURRENT_DIR]: directory(),
        [`${CURRENT_DIR}/events.jsonl`]: file(currentEvent()),
      }),
    })

    expect(result.kind).toBe("current")
    expect(result.locations).toHaveLength(2)
    expect(result.locations[0]).toMatchObject({
      path: CURRENT_DIR,
      roles: ["current", "legacy-candidate"],
      sources: ["BAY_DIR"],
    })
  })
})
