import type { ReactElement } from "react"
import type { YrdCliIO } from "./types.ts"

type LiveRenderer = (element: ReactElement, options: Readonly<{ signal: AbortSignal }>) => Promise<void>
type LiveYrdCliIO = YrdCliIO & Readonly<{ renderLive?: LiveRenderer }>

export function withLiveRenderer(io: YrdCliIO, renderLive: LiveRenderer): YrdCliIO {
  return { ...io, renderLive }
}

export function getLiveRenderer(io: YrdCliIO): LiveRenderer | undefined {
  return (io as LiveYrdCliIO).renderLive
}
