import { gitIn, type GitInvocationOptions, type GitSelection } from "../../packages/yrd-queue-core/src/git.ts"

const TEST_GIT_SELECTION: GitSelection = Object.freeze({
  executable: "git",
  contract: "native",
  scope: "default",
  origin: "Yrd test fixture",
})

/** Tests that do not exercise selection use an explicit fixture selection. */
export function testGitIn(
  cwd: string,
  process?: Parameters<typeof gitIn>[1],
  selection: GitSelection = TEST_GIT_SELECTION,
  options?: GitInvocationOptions,
): ReturnType<typeof gitIn> {
  return gitIn(cwd, process, selection, options)
}
