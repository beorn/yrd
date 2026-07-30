const SILVERY_MARKDOWN_VIEW_RELEASE = "@km/infra/22627-silvery-0232-release"

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function publicDependencyRefusal(silvery: object): string | undefined {
  const exports = silvery as Record<string, unknown>
  if (typeof exports.MarkdownView === "function") return undefined
  return (
    "Yrd dependency provisioning refused: Yrd main consumes silvery.MarkdownView, " +
    "but the installed silvery package predates that public API " +
    `(MarkdownView was added after 0.23.1). Release: ${SILVERY_MARKDOWN_VIEW_RELEASE}.`
  )
}

async function verifyPublicDependencies(): Promise<void> {
  let silvery: object
  try {
    silvery = await import("silvery")
  } catch (error) {
    console.error(
      "Yrd dependency provisioning refused: Yrd main consumes silvery.MarkdownView, " +
        `but the installed silvery package could not be imported: ${errorDetail(error)}. ` +
        `Release: ${SILVERY_MARKDOWN_VIEW_RELEASE}.`,
    )
    process.exitCode = 1
    return
  }

  const refusal = publicDependencyRefusal(silvery)
  if (refusal === undefined) return
  console.error(refusal)
  process.exitCode = 1
}

if (import.meta.main) await verifyPublicDependencies()
