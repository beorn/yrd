import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { bayEventsPath, bayIndexPath, bayPrsGitPath } from "../src/paths.ts"

describe("bay storage paths", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yrd-paths-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("uses current names for fresh state", () => {
    expect(bayEventsPath(dir)).toBe(join(dir, "events.jsonl"))
    expect(bayIndexPath(dir)).toBe(join(dir, "index.sqlite"))
    expect(bayPrsGitPath(dir)).toBe(join(dir, "prs.git"))
  })

  it("reads legacy names when they are the only existing state", async () => {
    await writeFile(join(dir, "journal.jsonl"), "", "utf8")
    await writeFile(join(dir, "bay.db"), "", "utf8")
    await mkdir(join(dir, "repo.git"))

    expect(bayEventsPath(dir)).toBe(join(dir, "journal.jsonl"))
    expect(bayIndexPath(dir)).toBe(join(dir, "bay.db"))
    expect(bayPrsGitPath(dir)).toBe(join(dir, "repo.git"))
  })

  it("prefers current names when both current and legacy state exist", async () => {
    await writeFile(join(dir, "journal.jsonl"), "", "utf8")
    await writeFile(join(dir, "events.jsonl"), "", "utf8")
    await writeFile(join(dir, "bay.db"), "", "utf8")
    await writeFile(join(dir, "index.sqlite"), "", "utf8")
    await mkdir(join(dir, "repo.git"))
    await mkdir(join(dir, "prs.git"))

    expect(bayEventsPath(dir)).toBe(join(dir, "events.jsonl"))
    expect(bayIndexPath(dir)).toBe(join(dir, "index.sqlite"))
    expect(bayPrsGitPath(dir)).toBe(join(dir, "prs.git"))
  })
})
