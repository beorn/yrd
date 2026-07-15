import { useState } from "react"
import { Box, Text, useInput } from "silvery"
import { run } from "silvery/runtime"
import { QueueWatchFrame } from "../src/watch-pane.tsx"
import { QUEUE_TIMELINE_STORY_NAMES, queueTimelineStories } from "./queue-timeline-fixtures.ts"

export const QUEUE_TIMELINE_STORYBOOK_CONTRACT = [
  {
    area: "queue-navigation-and-status",
    stories: ["production-overview", "idle", "multiple-queues", "paused"],
    controls: ["[", "]", "1-9"],
  },
  {
    area: "run-lifecycle",
    stories: ["pending-only", "running-spinner", "mixed-completed"],
    controls: ["j", "k", "enter"],
  },
  {
    area: "query-retention-and-stats",
    stories: ["honest-cap", "non-default-filters", "latest-vs-all-lineage"],
    controls: ["a", "l"],
  },
  {
    area: "responsive-widths",
    stories: ["narrow-wide", "long-subject"],
    controls: ["terminal resize"],
  },
  {
    area: "selection-and-follow",
    stories: ["anchored-new", "selected-pending", "selected-running", "selected-rejected", "selected-integrated"],
    controls: ["j", "k", "end"],
  },
  {
    area: "master-detail",
    stories: ["detail-right", "detail-below", "detail-full", "detail-controls"],
    controls: ["enter", "d"],
  },
  {
    area: "output-artifacts-and-evidence",
    stories: ["live-output-growth"],
    controls: ["wheel", "end"],
  },
] as const

export const QUEUE_TIMELINE_STORYBOOK_EXTERNAL_OWNERS = {
  degradedQueueStatus: "packages/yrd-cli/src/queue-status-view.tsx",
  followPauseAndEndResume: "packages/yrd-cli/src/watch-pane.tsx",
  rootQueueWiring: "packages/yrd-cli/src/run.ts",
} as const

export function QueueTimelineStorybook() {
  const [index, setIndex] = useState(0)
  const [showNext, setShowNext] = useState(false)
  const name = QUEUE_TIMELINE_STORY_NAMES[index] ?? QUEUE_TIMELINE_STORY_NAMES[0]
  const story = queueTimelineStories[name]
  const snapshot = showNext && story.nextSnapshot !== undefined ? story.nextSnapshot : story.snapshot

  useInput((input) => {
    if (input === "q") return "exit"
    if (input === "[") {
      setIndex((current) => (current - 1 + QUEUE_TIMELINE_STORY_NAMES.length) % QUEUE_TIMELINE_STORY_NAMES.length)
      setShowNext(false)
    }
    if (input === "]") {
      setIndex((current) => (current + 1) % QUEUE_TIMELINE_STORY_NAMES.length)
      setShowNext(false)
    }
    if (input === "n" && story.nextSnapshot !== undefined) setShowNext((current) => !current)
  })

  return (
    <Box flexDirection="column" width="100%" height="100%" minWidth={0} minHeight={0}>
      <Box height={1} flexShrink={0} justifyContent="space-between" paddingX={1}>
        <Text bold>YRD QUEUE TIMELINE STORYBOOK</Text>
        <Text>
          {index + 1}/{QUEUE_TIMELINE_STORY_NAMES.length} {name}
          {story.nextSnapshot === undefined ? "" : showNext ? " · next" : " · initial"}
        </Text>
      </Box>
      <Box flexGrow={1} minWidth={0} minHeight={0}>
        <QueueWatchFrame key={name} snapshot={snapshot} paused={false} />
      </Box>
      <Box height={1} flexShrink={0} paddingX={1}>
        <Text color="$fg-muted" wrap="truncate">
          [/]: story · n: initial/next snapshot · queue keys exercise the selected story · q: quit
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
