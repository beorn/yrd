/**
 * @failure `yrd --help` grows a command the plan does not name, or loses one
 *          of the seven, or prints them in another order or with other words;
 *          or a command hidden until flag day stops answering, so an old
 *          runbook meets "unknown command" instead of the command it names.
 * @level   l1
 * @consumer pm/@i/10-yrd/plan.md § Commands (M3: fewest commands, honest results)
 *
 * The oracle is the real Commander program (`runYrdHelp`), never a hand-kept
 * table of what the help should say: a second table would be one more copy to
 * drift. The seven rows below ARE the plan's list, verbatim.
 */
import { describe, expect, it } from "vitest"
import { runYrdHelp } from "../src/run.ts"
import type { YrdCliIO } from "../src/types.ts"

async function help(...path: readonly string[]): Promise<Readonly<{ exit: number; out: string }>> {
  let out = ""
  const io: YrdCliIO = {
    stdout: (text) => {
      out += text
    },
    stderr: (text) => {
      out += text
    },
    color: false,
    // Wide enough that no row wraps: a wrapped description would read as two rows.
    columns: 400,
  }
  const exit = await runYrdHelp([...path, "--help"], io)
  return { exit, out }
}

/** The rows under `Commands:`, as `[term, description]`, in the order printed. */
function commandRows(text: string): readonly (readonly [string, string])[] {
  const block = /^Commands:\n(?<rows>(?:  .*\n)+)/mu.exec(text)?.groups?.rows ?? ""
  return block
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const match = /^ {2}(?<term>\S.*?) {2,}(?<description>.*)$/u.exec(line)
      if (match?.groups === undefined) throw new Error(`unreadable command row: ${JSON.stringify(line)}`)
      return [match.groups.term ?? "", match.groups.description ?? ""] as const
    })
}

const QUEUE_ROWS = [
  ["submit [branch...]", "push the branch and open its change; at an unchanged head, retry"],
  ["run [selector...]", "one round of queue work"],
  ["up", "the service: the same round on a loop"],
  [
    "list [filter...]",
    "every change in line: state, position, last result and log path, work item; failed rows included, merged rows below (seven days by default)",
  ],
  ["show <branch>", "its changes newest first, each check's result and log"],
] as const

const ROOT_ROWS = [
  ...QUEUE_ROWS.map(([term, description]) => [`queue ${term}`, description] as const),
  ["check <name...>", "run one of the queue's checks here, now"],
  ["env open|close|list|path", "an environment for one branch"],
] as const

/**
 * Every command that exists today and is hidden from `--help` until flag day
 * (M5) deletes it (M6). Each still answers its own `--help`, exit 0, and none
 * appears in a listing.
 */
const HIDDEN_COMMANDS: readonly (readonly string[])[] = [
  ["in"],
  ["sh"],
  ["run"],
  ["run", "cancel"],
  ["doctor"],
  ["why"],
  ["log"],
  ["watch"],
  ["cancel"],
  ["branch"],
  ["branch", "draft"],
  ["branch", "submit"],
  ["branch", "archive"],
  ["branch", "ignore"],
  ["draft"],
  ["archive"],
  ["ignore"],
  ["deployment"],
  ["deployment", "materialize"],
  ["deployment", "reap"],
  ["deployment", "release"],
  ["gitlink"],
  ["gitlink", "advance"],
  ["guard"],
  ["admin"],
  ["admin", "init"],
  ["admin", "queue"],
  ["admin", "queue", "init"],
  ["admin", "queue", "deinit"],
  ["admin", "bay", "prune"],
  ["admin", "pr", "prune"],
  ["admin", "candidate-refs", "prune"],
  ["admin", "journal", "bump"],
  ["admin", "journal", "import-orphan"],
  ["admin", "submodule", "init"],
  ["issue"],
  ["issue", "view"],
  ["issue", "ensure"],
  ["contest"],
  ["contest", "open"],
  ["contest", "eval"],
  ["contest", "finish"],
  ["contest", "view"],
  ["contest", "select"],
  ["contest", "promote"],
  ["change"],
  ["pr", "list"],
  ["pr", "create"],
  ["pr", "submit"],
  ["pr", "view"],
  ["pr", "runs"],
  ["pr", "diff"],
  ["pr", "checkout"],
  ["pr", "status"],
  ["pr", "edit"],
  ["pr", "publish"],
  ["pr", "ready"],
  ["pr", "review"],
  ["pr", "request-review"],
  ["pr", "comment"],
  ["pr", "checks"],
  ["pr", "close"],
  ["pr", "retire"],
  ["pr", "withdraw"],
  ["pr", "merge"],
  ["env", "run"],
  ["env", "in"],
  ["env", "refresh"],
  ["env", "handoff"],
  ["env", "submit"],
  ["env", "status"],
  ["queue", "audit"],
  ["queue", "uncarried"],
  ["queue", "pause"],
  ["queue", "resume"],
  ["queue", "cancel"],
  ["queue", "finish"],
  ["queue", "candidate-refs"],
  ["queue", "recover"],
]

describe("the command strip: seven commands, and nothing else on --help", () => {
  it("yrd --help lists exactly the seven, in the plan's order, with the plan's words", async () => {
    const root = await help()
    expect(root.exit, root.out).toBe(0)
    expect(commandRows(root.out)).toEqual(ROOT_ROWS)
  })

  it("yrd queue --help lists submit, run, up, list, show and nothing else", async () => {
    const queue = await help("queue")
    expect(queue.exit, queue.out).toBe(0)
    expect(commandRows(queue.out)).toEqual(QUEUE_ROWS)
  })

  it("yrd env --help lists open, close, list, path and nothing else; bay is its alias", async () => {
    const env = await help("env")
    expect(env.exit, env.out).toBe(0)
    expect(env.out).toContain("Usage: yrd env|bay")
    expect(commandRows(env.out).map(([term]) => term.split(" ")[0])).toEqual(["open", "close", "list", "path"])
    const bay = await help("bay")
    expect(bay.exit, bay.out).toBe(0)
    expect(bay.out).toBe(env.out)
  })

  it.each([
    { alias: "submit", command: "queue submit" },
    { alias: "up", command: "queue up" },
    { alias: "show", command: "queue show" },
  ])("yrd $alias is yrd $command, the same command object", async ({ alias, command }) => {
    const spelled = await help(alias)
    expect(spelled.exit, spelled.out).toBe(0)
    expect(spelled.out).toContain(`Usage: yrd ${command}`)
    expect(spelled.out).toBe((await help(...command.split(" "))).out)
  })

  it("names the aliases on the root help, outside the command list", async () => {
    const root = await help()
    expect(root.out).toMatch(/^Aliases:\n\s+yrd submit\s+yrd queue submit$/mu)
    expect(root.out).toMatch(/^\s+yrd bay\s+yrd env\b/mu)
  })

  it.each(HIDDEN_COMMANDS.map((path) => ({ path: path.join(" "), argv: path })))(
    "keeps `yrd $path` answering --help, hidden from every listing",
    async ({ argv }) => {
      const hidden = await help(...argv)
      expect(hidden.exit, hidden.out).toBe(0)
      expect(hidden.out).toContain("Usage: yrd")
      // A leaf under a hidden group is still listed on that group's own page —
      // an old runbook that opens `yrd pr --help` should find its verb there.
      // The three visible listings are the ones that must not name it.
      const parent = argv.slice(0, -1).join(" ")
      if (parent !== "" && parent !== "queue" && parent !== "env") return
      const listing = await help(...argv.slice(0, -1))
      const leaf = argv.at(-1) ?? ""
      expect(commandRows(listing.out).map(([term]) => term.split(/[ |]/u)[0])).not.toContain(leaf)
    },
  )
})
