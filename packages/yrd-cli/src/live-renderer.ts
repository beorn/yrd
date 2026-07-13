import type { ReactElement } from "react"
import type { YrdCliIO } from "./types.ts"

type LiveRenderer = (element: ReactElement, options: Readonly<{ signal: AbortSignal }>) => Promise<void>

// Carried as an optional widening of YrdCliIO rather than a field on YrdCliIO itself: the live
// renderer is a React/Silvery capability, and types.ts must stay free of a react dependency so
// non-TTY and headless hosts can consume YrdCliIO without it.
type LiveYrdCliIO = YrdCliIO & Readonly<{ renderLive?: LiveRenderer }>

export function withLiveRenderer(io: YrdCliIO, renderLive: LiveRenderer): YrdCliIO {
  const live: LiveYrdCliIO = { ...io, renderLive }
  return live
}

export function getLiveRenderer(io: YrdCliIO): LiveRenderer | undefined {
  return (io as LiveYrdCliIO).renderLive
}
