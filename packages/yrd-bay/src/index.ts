/**
 * An environment for one branch: a git worktree, and the vocabulary that names
 * one.
 *
 * The durable `Bay` record, its journal plugin, the PR-number mint, the
 * `refs/for/…` receiver, the Change-Id trailers and the immutable-deployment
 * store were this package's other half and are deleted at M6 with the core
 * that read them (plan § Dropped on purpose). What the plan keeps — "bays stay
 * as workspaces" — is all that is here.
 */
export * from "./workspace.ts"
export * from "./git.ts"
