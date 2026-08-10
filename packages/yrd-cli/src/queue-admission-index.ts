/** One-based public positions derived from Queue's canonical admission order. */
export function queueAdmissionPositions(admissionOrder: readonly string[]): ReadonlyMap<string, number> {
  return new Map(admissionOrder.map((pr, index) => [pr, index + 1]))
}
