/**
 * The watch's chrome, and the few pure formatters every box shares.
 *
 * Ported from the retired pane's `queue-view-primitives.tsx` (yrd `1f638504^`),
 * which the operator's 2026-08-18 spec was written against and which `@cto`
 * approved in PR1300: the title-in-border box every watch box wears, the
 * hanging-marker gutter (item 29a), and the bounded hanging wrap (item 29).
 * Each is a composition of silvery's `Box` and `Text`, never a primitive of its
 * own; a border-title prop on silvery's `Box` is the upstream home these would
 * collapse into, and is filed, not built here.
 *
 * The pure formatters these boxes share (the one glyph table, the friendly
 * path, the run's short name, the bounded wrap) live in `watch-format.ts`,
 * which imports no React: the one-shot commands print through them and must
 * never load a reconciler to do it.
 */

import type React from "react"
import { Box, Pulse, Text } from "silvery"

/**
 * Live-activity pulse cadence, restored from the retired pane's
 * `queue-status-projection.ts` at yrd `1f638504` (user directive 2026-07-16).
 *
 * ag pulses a status colour against `$fg-muted` on an 1800 ms period, and
 * silvery's `Pulse` toggles ONCE per `intervalMs`, so half the period
 * reproduces ag's blink. Every activity indicator passes it, so they share one
 * app-scope phase clock rather than each approximating it with its own timer.
 *
 * OMITTING IT IS HOW THE CADENCE DRIFTED, and it is the one styling value in
 * this view that was genuinely invented: silvery's own default is 500 ms, so
 * every call site that passed nothing blinked 1.8x too fast. Invented by
 * omission is still invented — pass this, never nothing.
 */
export const AG_PULSE_INTERVAL_MS = 900

/**
 * The default "executing right now" pair: blue against muted, shared phase.
 *
 * BYTE-IDENTICAL TO THE RETIRED PANE and deliberately so. It measures 1.12:1 on
 * the Nord palette, which is faint, and that faintness is the ORIGINAL's — not
 * a regression introduced here. Whether the operator wants a more legible pair
 * is a design decision that belongs to `@chief` and `@cto`; restoring it
 * unchanged is what this file is for. Do not "improve" it in passing.
 */
export const ACTIVITY_PULSE_COLORS: readonly [string, string] = ["$fg-info", "$fg-muted"]

/**
 * One activity pulse — and the one place that knows a pulse OUTRANKS the
 * cursor's forced colour.
 *
 * The selected row forces `$fg-on-selected` onto every cell so the selection
 * reads as one block. An activity marker is the exception: forcing it flattens
 * both phases to the same colour, so the pulse stops pulsing exactly on the row
 * the operator is looking at — and row 0, the one being checked, is usually
 * that row. The retired pane applied its forced colour to non-activity content
 * only; this component is how that survives, by taking no forced colour at all.
 */
export function ActivityPulse({
  colors = ACTIVITY_PULSE_COLORS,
  children,
  ...rest
}: Readonly<{
  /** The [on, off] pair. Defaults to the shared activity pair. */
  colors?: readonly [string, string]
  children: React.ReactNode
}> &
  Omit<
    React.ComponentProps<typeof Pulse>,
    "colors" | "children" | "synchronized" | "intervalMs"
  >): React.ReactElement {
  // `flexShrink` first so a caller that must truncate (the list's status word)
  // can override it; the phase clock and the pair are not negotiable.
  return (
    <Pulse synchronized intervalMs={AG_PULSE_INTERVAL_MS} colors={colors} flexShrink={0} {...rest}>
      {children}
    </Pulse>
  )
}

/**
 * The one title-in-border chrome idiom every watch box uses: a full round
 * border with a left title and an optional right label punched into the top
 * edge (`RUN main#000406` on the status box, the elapsed clock on the runner).
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
  /** Left-anchored border title. Omit or pass "" for a box whose border carries no left text. */
  title?: string
  /** Right-anchored border label, the identity the operator's item 1 puts on the border. */
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
 * The universal hanging-marker rule (item 29a): every line with a leading
 * marker (✓ × ◉ ○ ◌ $ · ▶) puts the marker in a GUTTER and left-aligns its
 * text, and all text within a box aligns to ONE column, so wrapped text hangs
 * off the marker instead of wrapping back under it. `marker` renders any glyph
 * node (plain, colored, or pulsing); an absent marker still reserves the
 * gutter so sibling rows share the text column.
 */
export function MarkerRow({
  marker,
  gutter = 2,
  children,
}: Readonly<{
  marker?: React.ReactNode
  /** Gutter width in cells: the marker glyph plus its trailing space. */
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
