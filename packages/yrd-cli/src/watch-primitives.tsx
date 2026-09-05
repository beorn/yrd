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
import { Box, Text } from "silvery"

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
