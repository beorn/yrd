export type QueueReadFailure = Readonly<{
  code: "queue-read-boundary-moved"
  readCursor: number
  journalCursor: number
  showing: "last-complete" | "bounded-partial"
}>

export function queueReadFailureMessage(failure: QueueReadFailure, retrying = false): string {
  const snapshot = failure.showing === "last-complete" ? "last complete" : "bounded partial"
  return `queue changed while reading (derived cursor ${String(failure.readCursor)}, Journal cursor ${String(failure.journalCursor)}); showing ${snapshot} snapshot${retrying ? "; retrying" : ""}`
}
