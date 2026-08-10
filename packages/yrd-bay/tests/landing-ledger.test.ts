import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  LANDING_LOG_FORMAT,
  LandingIdentitySchema,
  parseLandingLog,
  reconcileLandingIndex,
  renderLandingCommitMessage,
} from "../src/landing-ledger.ts"

const CHANGE_ID = "01989b4e-1bc0-7a83-8e31-b283927e7b91"
const HEAD_SHA = "a".repeat(40)

describe("landing ledger identity", () => {
  it("renders the exact repository-rebuild identity into the checked Candidate", () => {
    const identity = LandingIdentitySchema.parse({
      changeId: CHANGE_ID,
      pr: "PR7",
      revision: 3,
      headSha: HEAD_SHA,
      base: "main",
      run: "R9",
    })

    expect(renderLandingCommitMessage("yrd: merge PR7 revision 3", identity)).toBe(
      [
        "yrd: merge PR7 revision 3",
        "",
        `Yrd-Change-Id: ${CHANGE_ID}`,
        "Yrd-PR: PR7",
        "Yrd-Revision: 3",
        `Yrd-Submitted-Head: ${HEAD_SHA}`,
        "Yrd-Base: main",
        "Yrd-Run: R9",
      ].join("\n"),
    )
  })

  it("refuses multiline identity fields and a message that already claims Yrd identity", () => {
    expect(() =>
      LandingIdentitySchema.parse({
        changeId: CHANGE_ID,
        pr: "PR7\nForged: value",
        revision: 3,
        headSha: HEAD_SHA,
        base: "main",
        run: "R9",
      }),
    ).toThrow()

    const identity = LandingIdentitySchema.parse({
      changeId: CHANGE_ID,
      pr: "PR7",
      revision: 3,
      headSha: HEAD_SHA,
      base: "main",
      run: "R9",
    })
    expect(() => renderLandingCommitMessage("subject\n\nYrd-PR: forged", identity)).toThrow(
      /already contains a Yrd landing trailer/u,
    )
  })

  it("round-trips the canonical trailers through Git's own trailer parser", () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-landing-ledger-"))
    try {
      execFileSync("git", ["init", "-q", repo])
      execFileSync("git", ["-C", repo, "config", "user.name", "Yrd Test"])
      execFileSync("git", ["-C", repo, "config", "user.email", "yrd@example.invalid"])
      writeFileSync(join(repo, "payload.txt"), "payload\n")
      execFileSync("git", ["-C", repo, "add", "payload.txt"])
      const identity = LandingIdentitySchema.parse({
        changeId: CHANGE_ID,
        pr: "PR7",
        revision: 3,
        headSha: HEAD_SHA,
        base: "main",
        run: "R9",
      })
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", renderLandingCommitMessage("landing", identity)])

      const raw = execFileSync("git", ["-C", repo, "log", `--format=${LANDING_LOG_FORMAT}`], {
        encoding: "utf8",
      })
      expect(parseLandingLog(raw)).toEqual([
        {
          ...identity,
          landingSha: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        },
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("fails loud when a claimed identity omits a companion trailer", () => {
    expect(() =>
      parseLandingLog(`${HEAD_SHA}\u001f${CHANGE_ID}\u001fPR7\u001f3\u001f${HEAD_SHA}\u001f\u001fR9\u001e`),
    ).toThrow()
  })

  it("treats a repository match as proof and a missing journal row as an index gap", () => {
    const landing = {
      changeId: CHANGE_ID,
      pr: "PR7",
      revision: 3,
      headSha: HEAD_SHA,
      base: "main",
      run: "R9",
      landingSha: "b".repeat(40),
    } as const
    const { run: _run, landingSha: _landingSha, ...submitted } = landing

    expect(reconcileLandingIndex(submitted, landing, [landing])).toEqual({
      status: "proven",
      source: "index",
      landing,
    })
    expect(reconcileLandingIndex(submitted, undefined, [landing])).toEqual({
      status: "proven",
      source: "repository",
      landing,
      indexGap: true,
    })
  })

  it("makes repository/index disagreement typed and loud", () => {
    const expected = {
      changeId: CHANGE_ID,
      pr: "PR7",
      revision: 3,
      headSha: HEAD_SHA,
      base: "main",
      run: "R9",
      landingSha: "b".repeat(40),
    } as const
    const otherLanding = { ...expected, landingSha: "c".repeat(40) }
    const { run: _run, landingSha: _landingSha, ...submitted } = expected

    expect(reconcileLandingIndex(submitted, expected, [])).toEqual({
      status: "corrupt",
      reason: "index-landing-not-on-base",
      indexed: expected,
    })
    expect(reconcileLandingIndex(submitted, expected, [expected, otherLanding])).toEqual({
      status: "corrupt",
      reason: "duplicate-repository-identity",
      landings: [expected, otherLanding],
    })
  })
})
