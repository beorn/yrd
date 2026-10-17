import { shellQuote } from "git-super/shell-command"
import type { YrdCliIO } from "./types.ts"

/** Render a copied POSIX recipe; other shells are outside this contract. */
export function formatYrdCommand(io: YrdCliIO, argv: readonly string[], cwd: string): string {
  return io.formatYrdCommand?.(argv, cwd) ?? `cd ${shellQuote(cwd)} && yrd ${argv.map(shellQuote).join(" ")}`
}
