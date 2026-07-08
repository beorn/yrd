import type { ConfigSource } from "./types.ts"
import { repoScopedCleanEnv } from "./env.ts"

/**
 * Config resolution — inline > BAY_* env > git config bay.* > default
 * (spec § Plugin architecture). Inline wins at the with*() call site;
 * this source covers the two ambient tiers so the CLI and a bash user
 * configure the same knobs through git's own config file.
 */
export function createGitConfigSource(cwd: string = process.cwd()): ConfigSource {
  return {
    async get(key: string): Promise<string | undefined> {
      const envKey =
        "BAY_" +
        key
          .replace(/[A-Z]/g, (c) => "_" + c)
          .replace(/[^a-zA-Z0-9]+/g, "_")
          .replace(/_+/g, "_")
          .toUpperCase()
      const fromEnv = process.env[envKey]
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv

      const proc = Bun.spawn(["git", "config", "--get", `bay.${key}`], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: repoScopedCleanEnv(), // hooks export GIT_DIR=. — never let it repoint this read
      })
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      if (code === 0) return out.trim()
      if (code === 1) return undefined // unset — a normal answer, not an error
      const err = await new Response(proc.stderr).text()
      throw new Error(`git config --get bay.${key} failed (exit ${code}): ${err.trim()}`)
    },
  }
}

/** Resolve one option: inline > ambient (env/gitconfig) > default. */
export async function resolveOption(
  inline: string | undefined,
  key: string,
  source: ConfigSource,
  fallback?: string,
): Promise<string | undefined> {
  if (inline !== undefined) return inline
  const ambient = await source.get(key)
  if (ambient !== undefined) return ambient
  return fallback
}
