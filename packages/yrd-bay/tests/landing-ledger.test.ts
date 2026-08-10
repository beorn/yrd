import { describe, expect, it } from "vitest"
import { LandingIdentitySchema, renderLandingCommitMessage } from "../src/landing-ledger.ts"

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
})
