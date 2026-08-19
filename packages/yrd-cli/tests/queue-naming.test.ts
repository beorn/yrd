/**
 * @failure A repository path prints expanded where a shell prompt would print
 *          `~`, two queues collide on one shortened path, or the canonical
 *          `path@branch#N` run address parses as something it is not.
 * @level   l1
 * @consumer @yrd/cli queue naming (watch redesign items 30a/33/34/36)
 */
import { describe, expect, it } from "vitest"
import {
  formatQueueRunAddress,
  friendlyRepositoryPath,
  parseQueueRunAddress,
  queueFullName,
  queuePrettyName,
  queueRunLabel,
  shortUniqueQueuePaths,
} from "../src/queue-naming.ts"

const HOME = "/home/operator"

describe("friendlyRepositoryPath — the one path formatter (items 30a/33)", () => {
  it("keeps a path outside $HOME absolute", () => {
    expect(friendlyRepositoryPath("/hh", HOME)).toBe("/hh")
    expect(friendlyRepositoryPath("/hh/pm", HOME)).toBe("/hh/pm")
  })

  it("renders a repository under $HOME home-relative, the way a shell prompt would", () => {
    expect(friendlyRepositoryPath("/home/operator/repo", HOME)).toBe("~/repo")
    expect(friendlyRepositoryPath("/home/operator", HOME)).toBe("~")
  })

  it("does not treat a sibling that merely shares the prefix as home-relative", () => {
    expect(friendlyRepositoryPath("/home/operator2/repo", HOME)).toBe("/home/operator2/repo")
  })

  it("normalizes a trailing slash rather than printing it", () => {
    expect(friendlyRepositoryPath("/hh/", HOME)).toBe("/hh")
    expect(friendlyRepositoryPath("/home/operator/repo/", HOME)).toBe("~/repo")
  })

  it("passes a non-absolute display value through untouched", () => {
    expect(friendlyRepositoryPath("pm", HOME)).toBe("pm")
  })
})

describe("shortUniqueQueuePaths (item 32b: shortest unique friendly suffix)", () => {
  it("shortens a nested repository to its unique suffix", () => {
    const short = shortUniqueQueuePaths(["/hh", "/hh/pm"], HOME)
    expect(short.get("/hh")).toBe("/hh")
    expect(short.get("/hh/pm")).toBe("pm")
  })

  it("falls back to the full friendly path when two repositories share a basename", () => {
    const short = shortUniqueQueuePaths(["/a/repo", "/b/repo"], HOME)
    expect(short.get("/a/repo")).toBe("/a/repo")
    expect(short.get("/b/repo")).toBe("/b/repo")
  })

  it("shortens $HOME repositories from their friendly form", () => {
    const short = shortUniqueQueuePaths(["/home/operator/one", "/hh"], HOME)
    expect(short.get("/home/operator/one")).toBe("one")
    expect(short.get("/hh")).toBe("/hh")
  })
})

describe("three-tier queue names (item 36)", () => {
  it("builds the canonical path@branch FQN", () => {
    expect(queueFullName({ path: "/hh", base: "main" })).toBe("/hh@main")
    expect(queueFullName({ path: "/hh/pm", base: "main" })).toBe("/hh/pm@main")
  })

  it("degrades to the bare branch when no path is known, never a fabricated one", () => {
    expect(queueFullName({ base: "main" })).toBe("main")
  })

  it("renders the pretty name with the branch glyph", () => {
    expect(queuePrettyName({ path: "/hh", base: "main" }, undefined, HOME)).toBe("/hh ⎇ main")
    expect(queuePrettyName({ path: "/hh/pm", base: "main" }, "pm", HOME)).toBe("pm ⎇ main")
  })

  it("labels runs by config handle first, base branch when none exists", () => {
    expect(queueRunLabel({ name: "code", base: "main" })).toBe("code")
    expect(queueRunLabel({ base: "main" })).toBe("main")
  })

  it("formats the script-stable run address", () => {
    expect(formatQueueRunAddress({ path: "/hh", base: "main" }, 23423)).toBe("/hh@main#23423")
  })
})

describe("parseQueueRunAddress (items 34/36: the CLI-accepted canonical form)", () => {
  it("parses an absolute path@branch#N address", () => {
    expect(parseQueueRunAddress("/hh@main#23423")).toEqual({ path: "/hh", base: "main", run: "main#23423" })
    expect(parseQueueRunAddress("/hh/pm@main#123")).toEqual({ path: "/hh/pm", base: "main", run: "main#123" })
  })

  it("parses a ~-rooted address", () => {
    expect(parseQueueRunAddress("~/repo@main#7")).toEqual({ path: "~/repo", base: "main", run: "main#7" })
  })

  it("leaves ordinary tokens alone", () => {
    expect(parseQueueRunAddress("topic@v2#3"), "relative prefix is not a repository path").toBeUndefined()
    expect(parseQueueRunAddress("main#123"), "bare run form is not the canonical address").toBeUndefined()
    expect(parseQueueRunAddress("/hh@main"), "no run number, no run address").toBeUndefined()
    expect(parseQueueRunAddress("pm:main#5"), "the colon form is the legacy composition spelling").toBeUndefined()
  })
})
