import { describe, expect, it } from "vitest"
import { parseQualifiedRunRef, requireUnqualifiedRunSelector } from "../src/qualified-run-ref.ts"

describe("parseQualifiedRunRef", () => {
  it.each([
    { token: "code:main#2172", expected: { repository: "code", run: "main#2172" } },
    { token: "pm:main#2711", expected: { repository: "pm", run: "main#2711" } },
    // A base is a Git ref, so it may carry slashes; only the FIRST colon splits.
    { token: "code:release/next#12", expected: { repository: "code", run: "release/next#12" } },
  ])("reads $token as a repository-qualified run reference", ({ token, expected }) => {
    expect(parseQualifiedRunRef(token)).toEqual(expected)
  })

  it.each([
    // The bare form the resolver already accepts — never qualified.
    "main#2172",
    // Run and PR ids stay what they are.
    "R2172",
    "PR865",
    "2172",
    // No run number: not a run reference, so not ours to rewrite or refuse.
    "topic:alpha",
    "code:main",
    // Free text that merely contains a colon and a number must pass through
    // untouched — refusing these would break `--reason "fixes:issue#12"`.
    "fixes:issue#12 and more",
    // Already-qualified twice is not a form we mint.
    "code:pm:main#12",
    // The watch legend's own shorthand: the prefix is a display label, not a
    // repository, and reading it as one made a pasted watch row resolve (and
    // fail) against a repository nobody declared.
    "1:main#2173",
    "12:release/next#4",
    "",
  ])("does not read %s as a qualified run reference", (token) => {
    expect(parseQualifiedRunRef(token)).toBeUndefined()
  })
})

describe("requireUnqualifiedRunSelector", () => {
  it.each(["main#2172", "R7", "PR9"])("passes a local selector through: %s", (selector) => {
    expect(requireUnqualifiedRunSelector(selector, "cancel")).toBe(selector)
  })

  it("refuses a qualified reference loudly, naming the bare form and the host command", () => {
    // A process with no host declarations cannot tell whether `pm:main#2711`
    // means its own main#2711 or another repository's, and both exist. Dropping
    // the prefix would resolve the WRONG run, so it must refuse instead.
    expect(() => requireUnqualifiedRunSelector("pm:main#2711", "cancel")).toThrow(
      "qualified run reference 'pm:main#2711' needs the composition host's repository declarations",
    )
    expect(() => requireUnqualifiedRunSelector("pm:main#2711", "cancel")).toThrow("use the bare form 'main#2711' here")
    // The remedy names the subcommand the operator was running, so it is the
    // exact command line to retype — no `...` placeholder for a runner (or a
    // human) to guess at.
    expect(() => requireUnqualifiedRunSelector("pm:main#2711", "cancel")).toThrow(
      "run 'yrd queue cancel pm main#2711' from the composition host",
    )
    expect(() => requireUnqualifiedRunSelector("pm:main#2711", "finish")).toThrow(
      "run 'yrd queue finish pm main#2711' from the composition host",
    )
  })

  it("refuses a watch legend label by name instead of hunting for a repository called '1'", () => {
    // A multi-queue watch prints `1:main#2173`, so operators paste it back. The
    // label numbers the queues of ONE render; nothing can map it to a base
    // afterwards, and the token already carries the form that works.
    expect(() => requireUnqualifiedRunSelector("1:main#2173", "cancel")).toThrow(
      "run reference '1:main#2173' carries the watch legend's queue label '1'",
    )
    expect(() => requireUnqualifiedRunSelector("1:main#2173", "cancel")).toThrow("use the bare form 'main#2173'")
    expect(() => requireUnqualifiedRunSelector("2:release/next#4", "finish")).toThrow(
      "use the bare form 'release/next#4'",
    )
  })
})
