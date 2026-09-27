/**
 * The complete, stored explanation of a queue-owned failure or queued wait.
 *
 * These six fields are ADR-0007's obvious-error shape. They live on the
 * change record, not in a host-local journal, so every clone reads the same
 * cause and next move. A partial incident is unreadable rather than rendered
 * with blanks: the record ref is the authority or it is not an answer.
 */

import { isAbsolute } from "node:path"

export const INCIDENT_TRAILERS = ["Code", "Subject", "Via", "Evidence", "Next", "Owner"] as const

export type Incident = Readonly<{
  code: string
  subject: string
  via: string
  evidence: string
  next: string
  owner: string
}>

const PROPERTY: Readonly<Record<(typeof INCIDENT_TRAILERS)[number], keyof Incident>> = {
  Code: "code",
  Subject: "subject",
  Via: "via",
  Evidence: "evidence",
  Next: "next",
  Owner: "owner",
}

/** The six trailers one incident writes, in the order a full reader renders them. */
export function incidentTrailers(incident: Incident): readonly (readonly [string, string])[] {
  if (!isAbsolute(incident.evidence)) {
    throw new Error(`incident Evidence: is not an absolute path: ${incident.evidence}`)
  }
  return INCIDENT_TRAILERS.map((name) => {
    const value = incident[PROPERTY[name]]
    if (value.trim() === "" || value.includes("\n")) {
      throw new Error(`incident ${name}: must be one non-empty line`)
    }
    return [name, value] as const
  })
}

/** ADR-0007's compact form, used in the existing result slot of list rows. */
export function incidentLine(incident: Incident): string {
  return `${incident.code}: ${incident.subject}; evidence: ${incident.evidence}; next: ${incident.next}; owner: ${incident.owner}`
}

/** ADR-0007's full form: one field per line, subject first. */
export function incidentLines(incident: Incident): readonly string[] {
  return [
    `subject: ${incident.subject}`,
    `code: ${incident.code}`,
    `via: ${incident.via}`,
    `evidence: ${incident.evidence}`,
    `next: ${incident.next}`,
    `owner: ${incident.owner}`,
  ]
}
