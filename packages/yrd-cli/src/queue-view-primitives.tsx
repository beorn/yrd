import type React from "react"
import { Box, Text } from "silvery"

function mediaDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = String(seconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`
}

export function timelineMetric(value: number | null): string {
  if (value === null) return "-"
  const duration = mediaDuration(value)
  if (duration.length <= 6) return duration

  const totalMinutes = Math.floor(value / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 100) return `${totalHours}h${String(totalMinutes % 60).padStart(2, "0")}m`

  const totalDays = Math.floor(totalHours / 24)
  if (totalDays < 100) return `${totalDays}d${String(totalHours % 24).padStart(2, "0")}h`
  if (totalDays < 100_000) return `${totalDays}d`
  return ">99kd"
}

/**
 * The one title-in-border chrome idiom every watch box uses: a full round
 * border with a left title and optional right label punched into the top edge.
 */
export function TitledBox({
  title = "",
  titleRight,
  borderColor,
  padding,
  fill = false,
  marginTop,
  flushTop = false,
  children,
}: Readonly<{
  /** Left-anchored border title. Omit or pass "" for a box whose border
   * carries no left text — a bare "╭" leads straight into the horizontal
   * line, leaving `titleRight` (if given) as the border's only label. */
  title?: string
  titleRight?: string
  borderColor?: string
  padding?: number
  fill?: boolean
  marginTop?: number
  flushTop?: boolean
  children: React.ReactNode
}>) {
  const border = borderColor ?? "$border-default"
  const bodyPadding =
    padding === undefined
      ? { paddingX: 1, paddingTop: flushTop ? 0 : undefined }
      : flushTop
        ? { paddingLeft: padding, paddingRight: padding, paddingBottom: padding, paddingTop: 0 }
        : { padding }
  return (
    <Box
      width="100%"
      height={fill ? "100%" : undefined}
      flexDirection="column"
      minWidth={0}
      minHeight={0}
      flexShrink={fill ? 1 : 0}
      flexGrow={fill ? 1 : undefined}
      marginTop={marginTop}
      userSelect="contain"
    >
      <Box flexDirection="row" width="100%" flexShrink={0} minWidth={0}>
        {title === "" ? (
          <Text color={border} flexShrink={0}>
            {"╭"}
          </Text>
        ) : (
          <>
            <Text color={border} flexShrink={0}>
              {"╭─ "}
            </Text>
            <Text color={border} bold flexShrink={0}>
              {title}
            </Text>
            <Text color={border} flexShrink={0}>
              {" "}
            </Text>
          </>
        )}
        <Box
          height={1}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          borderStyle="round"
          borderColor={border}
          borderLeft={false}
          borderRight={false}
          borderBottom={false}
        />
        {titleRight === undefined ? null : (
          <Text color={border} flexShrink={0}>
            {` ${titleRight} ─`}
          </Text>
        )}
        <Text color={border} flexShrink={0}>
          {"╮"}
        </Text>
      </Box>
      <Box
        borderStyle="round"
        borderTop={false}
        borderColor={border}
        width="100%"
        flexDirection="column"
        flexGrow={fill ? 1 : undefined}
        minWidth={0}
        minHeight={0}
        {...bodyPadding}
      >
        {children}
      </Box>
    </Box>
  )
}

/**
 * The universal hanging-marker rule (operator ruling 2026-08-18, item 29a):
 * every line with a leading marker (✓ × $ · ⏺ ▶) puts the marker in a GUTTER
 * and left-aligns its text — and all text within a box aligns to ONE column,
 * so wrapped text hangs off the marker instead of wrapping back under it.
 * `marker` renders any glyph node (plain, colored, or pulsing); an absent
 * marker still reserves the gutter so sibling rows share the text column.
 */
export function MarkerRow({
  marker,
  gutter = 2,
  children,
}: Readonly<{
  marker?: React.ReactNode
  /** Gutter width in cells — marker glyph plus its trailing space. */
  gutter?: number
  children: React.ReactNode
}>) {
  return (
    <Box flexDirection="row" minWidth={0} width="100%">
      <Box width={gutter} flexShrink={0}>
        {marker}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
        {children}
      </Box>
    </Box>
  )
}

/**
 * Bounded hanging wrap for one marker-led line (operator ruling 2026-08-18,
 * item 29, settling the item-13 deviation): wrapped text hangs off the marker
 * and the line's HEIGHT is capped, eliding with `…`, so a long command can
 * never push the run list off a narrow pane — the 2026-08-13 regression
 * guard's reason survives while its single-line mechanism is replaced.
 * Pure and width-driven so the guard test can pin exact rows.
 */
export function boundedHangingLines(text: string, width: number, maxRows = 3): readonly string[] {
  const safeWidth = Math.max(1, Math.floor(width))
  const words = text.split(/\s+/u).filter((word) => word !== "")
  const rows: string[] = []
  let current = ""
  const push = (row: string): void => {
    if (row !== "") rows.push(row)
  }
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`
    if (candidate.length <= safeWidth) {
      current = candidate
      continue
    }
    push(current)
    // A single word longer than the row hard-breaks; anything else wraps whole.
    let rest = word
    while (rest.length > safeWidth) {
      rows.push(rest.slice(0, safeWidth))
      rest = rest.slice(safeWidth)
    }
    current = rest
  }
  push(current)
  if (rows.length <= maxRows) return rows
  const kept = rows.slice(0, maxRows)
  const last = kept[maxRows - 1] ?? ""
  kept[maxRows - 1] = last.length >= safeWidth ? `${last.slice(0, Math.max(0, safeWidth - 1))}…` : `${last}…`
  return kept
}
