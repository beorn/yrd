import { createHash } from "node:crypto"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { asFailure, createFailure } from "@yrd/core"
import { defineConfig, type FlowDef, type YrdConfig } from "./model.ts"

type ConfigModule = Readonly<{ default?: unknown }>

export type LoadConfigModuleOptions = Readonly<{
  /** Logical repository path used in diagnostics. */
  path: string
  /** When present, this exact base-branch source is evaluated. The loader
   * never consults the working-tree path in that mode. */
  source?: string
  /** Durable untracked cache for transpiled authority source. */
  cacheDir?: string
  importModule?: (specifier: string) => Promise<ConfigModule>
}>

function bindConfigPackage(source: string): string {
  const specifier = JSON.stringify(new URL("./index.ts", import.meta.url).href)
  return source.replace(/(["'])@yrd\/config\1/gu, specifier)
}

function parseModule(module: ConfigModule, path: string): YrdConfig {
  const value = module.default
  if (typeof value !== "object" || value === null || !("flows" in value) || !Array.isArray(value.flows)) {
    throw createFailure({
      kind: "configuration",
      code: "invalid-config-module",
      message: `yrd: ${path} must default-export defineConfig(...)`,
    })
  }
  return defineConfig(...(value.flows as readonly FlowDef[]))
}

/** Load one programmatic config. Authority callers pass the blob read from the
 * base branch; writing it to a content-addressed cache gives Bun normal module
 * semantics without ever importing candidate-controlled working-tree bytes. */
export async function loadConfigModule(options: LoadConfigModuleOptions): Promise<YrdConfig> {
  const importModule = options.importModule ?? ((specifier: string) => import(specifier) as Promise<ConfigModule>)
  try {
    if (options.source === undefined) {
      const version = (await stat(options.path)).mtimeMs
      return parseModule(await importModule(`${pathToFileURL(options.path).href}?v=${version}`), options.path)
    }

    const transformed = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(options.source)
    const bound = bindConfigPackage(transformed)
    const digest = createHash("sha256").update(bound).digest("hex")
    const cacheDir = options.cacheDir ?? join(dirname(options.path), "node_modules", ".cache", "yrd-config")
    const cached = join(cacheDir, `${digest}.mjs`)
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cached, bound, { flag: "wx" }).catch((error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error
    })
    return parseModule(await importModule(`${pathToFileURL(cached).href}?v=${digest}`), options.path)
  } catch (error) {
    throw asFailure(error, {
      kind: "configuration",
      code: "invalid-config-module",
      message: `yrd: cannot load base-authority config ${options.path}: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}
