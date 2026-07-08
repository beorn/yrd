/**
 * TRACEPARENT propagation (docs/events.md § Cause and spans: "Propagation:
 * TRACEPARENT env for the CLI, meta.traceparent for RPC"). The core never
 * depends on an OTel SDK — this is a ~10-line W3C Trace Context parser, not a
 * tracing library. A malformed or absent header simply yields no trace/span
 * id; the command still gets a `commandId` from core either way.
 *
 * Format: `version-traceId-spanId-flags`, e.g.
 * `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 * (https://www.w3.org/TR/trace-context/#traceparent-header).
 */
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i

export function parseTraceparent(header: string): { traceId: string; spanId: string } | undefined {
  const m = TRACEPARENT.exec(header.trim())
  if (!m) return undefined
  return { traceId: m[1]!, spanId: m[2]! }
}

/** Reads `TRACEPARENT` from the environment — the CLI's half of propagation. */
export function readTraceparentEnv(): { traceId: string; spanId: string } | undefined {
  const raw = process.env.TRACEPARENT
  if (!raw) return undefined
  return parseTraceparent(raw)
}
