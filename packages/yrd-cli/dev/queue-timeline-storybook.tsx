import { useState } from "react"
import { Box, Text } from "silvery"
import { run, useInput } from "silvery/runtime"
import { QueueShowView, QueueTimelineView } from "../src/queue-status-view.tsx"
import { QUEUE_TIMELINE_STORY_NAMES, queueTimelineStories } from "./queue-timeline-fixtures.ts"

export function QueueTimelineStorybook() {
  const [index, setIndex] = useState(0)
  const [showNext, setShowNext] = useState(false)
  const name = QUEUE_TIMELINE_STORY_NAMES[index] ?? QUEUE_TIMELINE_STORY_NAMES[0]
  const story = queueTimelineStories[name]
  const projection = showNext && story.nextProjection !== undefined ? story.nextProjection : story.projection
  const detail =
    story.openRun === undefined ? undefined : projection.details.find((candidate) => candidate.run === story.openRun)

  useInput((input, key) => {
    if (input === "q" || key.escape) return "exit"
    if (key.leftArrow || input === "[") {
      setIndex((current) => (current - 1 + QUEUE_TIMELINE_STORY_NAMES.length) % QUEUE_TIMELINE_STORY_NAMES.length)
      setShowNext(false)
    }
    if (key.rightArrow || input === "]") {
      setIndex((current) => (current + 1) % QUEUE_TIMELINE_STORY_NAMES.length)
      setShowNext(false)
    }
    if (input === "n" && story.nextProjection !== undefined) setShowNext((current) => !current)
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box height={1} justifyContent="space-between">
        <Text bold>YRD QUEUE TIMELINE STORYBOOK</Text>
        <Text>
          {index + 1}/{QUEUE_TIMELINE_STORY_NAMES.length} {name}
          {story.nextProjection === undefined ? "" : showNext ? " · next" : " · initial"}
        </Text>
      </Box>
      {detail === undefined ? (
        <QueueTimelineView key={name} projection={projection} interactive />
      ) : (
        <Box flexDirection="column">
          <Text bold>RUN DETAIL {detail.run}</Text>
          <QueueShowView data={detail} />
        </Box>
      )}
      <Box marginTop={1} height={1}>
        <Text color="$fg-muted" wrap="truncate">
          ←/→ or [/]: story · n: initial/next snapshot · q/Esc: quit
        </Text>
      </Box>
    </Box>
  )
}

export async function main(): Promise<void> {
  using handle = await run(<QueueTimelineStorybook />, { mode: "fullscreen", mouse: true })
  await handle.waitUntilExit()
}

if (import.meta.main) await main()
