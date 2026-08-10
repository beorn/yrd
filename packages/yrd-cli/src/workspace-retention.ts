export type RetainedWorkspace = Readonly<{
  path: string
  cleanup: "worktree" | "directory"
}>

export function retainedWorkspaceNote(workspace: RetainedWorkspace): string {
  return `workspace retained at '${workspace.path}' (cleanup: ${workspace.cleanup}; --keep-on-failure)`
}

export function retainedWorkspaceFromMessage(message: string): RetainedWorkspace | undefined {
  const match = /workspace retained at '([^']+)' \(cleanup: (worktree|directory); --keep-on-failure\)/iu.exec(message)
  const path = match?.[1]
  const cleanup = match?.[2]
  if (path === undefined || (cleanup !== "worktree" && cleanup !== "directory")) return undefined
  return Object.freeze({ path, cleanup })
}
