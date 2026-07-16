// Externally-sourced text — subprocess stdout, artifact tail logs, journal
// excerpts — arrives with terminal control sequences baked in (a check step's
// `output.log` carries the vitest banner's `\x1b[46m` cyan background, spinners
// carry cursor/erase codes, and so on). Rendering that text raw into a silvery
// `<Text>` node is a crash: silvery's background-conflict guard defaults to
// `throw`, so a background SGR code layered over the TUI's own background bricks
// the whole `yrd watch` event loop. Cursor/erase codes corrupt layout even when
// they don't trip that guard.
//
// `@silvery/ansi` exports a `stripAnsi`, but its pattern only covers SGR and
// OSC-8 hyperlinks — not cursor/erase/other CSI sequences — so yrd keeps its own
// full-coverage stripper. The pattern matches the whole escape-sequence surface
// (CSI incl. cursor/erase/SGR, OSC with BEL or ST terminators, and C1 forms),
// the same coverage as the widely used `ansi-regex` package.

const ESC = "\\u001B"
const C1_CSI = "\\u009B"
const OSC_TERMINATOR = "(?:\\u0007|\\u001B\\u005C|\\u009C)"

const ANSI_ESCAPE = new RegExp(
  [
    `[${ESC}${C1_CSI}][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?${OSC_TERMINATOR})`,
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  ].join("|"),
  "gu",
)

/**
 * Strip every ANSI/VT escape sequence from a string so externally-sourced log
 * text renders as plain characters. Strips SGR (colors/backgrounds/attributes),
 * cursor movement, erase, and OSC sequences alike. The visible characters
 * between escapes are preserved verbatim, including newlines and whitespace.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "")
}
