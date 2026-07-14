/** Remove caller-owned Git routing variables before selecting a repository.
 * Git honors these variables ahead of `-C`, so every CLI Git boundary shares
 * this scrubber rather than allowing ambient hook state to change authority. */
export function cleanGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  )
}
