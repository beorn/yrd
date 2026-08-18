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
