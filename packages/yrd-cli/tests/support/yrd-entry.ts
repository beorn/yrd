import { join } from "node:path"

/**
 * This checkout's declared Yrd entry, the same `bin/yrd` a real installation
 * exposes. Tests spawn it directly: a host install path does not exist on every
 * machine and, where it does, runs a version other than the one under test.
 */
export const YRD_ENTRY = join(import.meta.dirname, "../../../../bin/yrd.ts")
