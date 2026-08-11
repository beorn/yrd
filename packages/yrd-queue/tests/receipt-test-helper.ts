import type { LandingReceiptPointer } from "@yrd/queue"

/** Repository receipt pointer for queue tests whose merge actuator is an
 * in-memory fake. Real-Git tests must exercise the notes writer instead. */
export function testLandingReceipt(target: string): LandingReceiptPointer {
  return {
    ref: "refs/notes/yrd/receipts",
    target,
    note: "c".repeat(40),
    checksum: "d".repeat(64),
  }
}
