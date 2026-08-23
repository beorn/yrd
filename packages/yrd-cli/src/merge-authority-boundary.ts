import type { YrdCliServices } from "./types.ts"

/**
 * Base-selected merge authority passed from the process host to submit. The
 * symbol stays out of YrdCliServices because this is a private host/CLI fact,
 * not a plugin capability.
 */
export const MergeAuthorityBoundary = Symbol("yrd.landing-authority-boundary")

type InternalServices = YrdCliServices &
  Readonly<{
    [MergeAuthorityBoundary]?: "expected" | "none"
  }>

export function mergeAuthorityBoundary(services: YrdCliServices): "expected" | "none" | undefined {
  return (services as InternalServices)[MergeAuthorityBoundary]
}
