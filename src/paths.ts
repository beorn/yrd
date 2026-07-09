import { existsSync } from "node:fs"
import { join } from "node:path"

export const EVENTS_FILE = "events.jsonl"
export const LEGACY_JOURNAL_FILE = "journal.jsonl"
export const INDEX_FILE = "index.sqlite"
export const LEGACY_DB_FILE = "bay.db"
export const PRS_REPO_DIR = "prs.git"
export const LEGACY_REPO_DIR = "repo.git"

function preferCurrentUnlessLegacyExists(dir: string, current: string, legacy: string): string {
  const currentPath = join(dir, current)
  const legacyPath = join(dir, legacy)
  return !existsSync(currentPath) && existsSync(legacyPath) ? legacyPath : currentPath
}

export function bayEventsPath(dir: string): string {
  return preferCurrentUnlessLegacyExists(dir, EVENTS_FILE, LEGACY_JOURNAL_FILE)
}

export function bayIndexPath(dir: string): string {
  return preferCurrentUnlessLegacyExists(dir, INDEX_FILE, LEGACY_DB_FILE)
}

export function bayPrsGitPath(dir: string): string {
  return preferCurrentUnlessLegacyExists(dir, PRS_REPO_DIR, LEGACY_REPO_DIR)
}
