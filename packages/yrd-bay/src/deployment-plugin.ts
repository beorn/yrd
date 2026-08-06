import { command, type CommandResult, type CommandTree, type YrdDef } from "@yrd/core"
import type { HasJobs } from "@yrd/job"

import {
  DeploymentInputSchema,
  ReleaseDeploymentJobInputSchema,
  deploymentJobKey,
  type DeploymentJobDefs,
  type MaterializeDeploymentInput,
  type ReleaseDeploymentJobInput,
} from "./deployment.ts"

export type DeploymentCommands = Readonly<{
  deployment: Readonly<{
    materialize: ReturnType<typeof materializeCommand>
    reap: ReturnType<typeof reapCommand>
    release: ReturnType<typeof releaseCommand>
  }>
}>

export type Deployments = Readonly<{
  materialize(input: MaterializeDeploymentInput): Promise<CommandResult>
  reap(input: MaterializeDeploymentInput): Promise<CommandResult>
  release(input: ReleaseDeploymentJobInput): Promise<CommandResult>
}>

export type HasDeployments = Readonly<{ deployments: Deployments }>

export function withDeployments(options: Readonly<{ jobs: DeploymentJobDefs }>) {
  const commands = createDeploymentCommands(options.jobs)
  return <State extends object, Commands extends CommandTree, Features extends HasJobs>(
    definition: YrdDef<State, Commands, Features>,
  ) =>
    definition.extend({
      commands,
      create(yrd) {
        yrd.jobs.requireDefinitions(options.jobs)
        return {
          deployments: Object.freeze({
            materialize: (input: MaterializeDeploymentInput) => yrd.dispatch(commands.deployment.materialize, input),
            reap: (input: MaterializeDeploymentInput) => yrd.dispatch(commands.deployment.reap, input),
            release: (input: ReleaseDeploymentJobInput) => yrd.dispatch(commands.deployment.release, input),
          }),
        } satisfies HasDeployments
      },
    }) as YrdDef<State, Commands & DeploymentCommands, Features & HasDeployments>
}

function createDeploymentCommands(jobs: DeploymentJobDefs): DeploymentCommands {
  return {
    deployment: {
      materialize: materializeCommand(jobs),
      reap: reapCommand(jobs),
      release: releaseCommand(jobs),
    },
  }
}

function materializeCommand(jobs: DeploymentJobDefs) {
  return command({
    title: "Request immutable deployment materialization",
    visibility: "public",
    params: DeploymentInputSchema,
    apply: (_state: object, input: MaterializeDeploymentInput) => ({
      events: [
        jobs["deployment.materialize"].request(input, {
          key: deploymentJobKey("materialize", input.deploymentId),
        }),
      ],
    }),
  })
}

function reapCommand(jobs: DeploymentJobDefs) {
  return command({
    title: "Request unpublished deployment reaping",
    visibility: "public",
    params: DeploymentInputSchema,
    apply: (_state: object, input: MaterializeDeploymentInput) => ({
      events: [jobs["deployment.reap"].request(input, { key: deploymentJobKey("reap", input.deploymentId) })],
    }),
  })
}

function releaseCommand(jobs: DeploymentJobDefs) {
  return command({
    title: "Request authorized immutable deployment release",
    visibility: "public",
    params: ReleaseDeploymentJobInputSchema,
    apply: (_state: object, input: ReleaseDeploymentJobInput) => ({
      events: [jobs["deployment.release"].request(input, { key: deploymentJobKey("release", input.deploymentId) })],
    }),
  })
}
