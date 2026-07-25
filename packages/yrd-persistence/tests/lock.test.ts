import { describe, expect, it } from "vitest"
import { posixLibcCandidates } from "../src/lock.ts"

describe("POSIX writer lock", () => {
  it("loads the glibc soname before the linker script on Linux", () => {
    expect(posixLibcCandidates("linux")).toEqual(["libc.so.6", "libc.so"])
  })
})
