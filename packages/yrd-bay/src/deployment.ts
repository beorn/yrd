import { createJobDef, type JobDef } from "@yrd/job"
import {
  assertExactRelease,
  assertHabReleaseAuthorization,
  DeploymentInputSchema,
  DeploymentSourceResultSchema,
  deploymentJobKey,
  ReapedDeploymentSchema,
  ReleaseDeploymentJobInputSchema,
  ReleasedDeploymentSchema,
  type DeploymentSourceResult,
  type GitDeploymentStore,
  type MaterializeDeploymentInput,
  type ReleaseDeploymentJobInput,
} from "@yrd/grove"

export {
  createGitDeploymentStore,
  DeploymentInputSchema,
  DeploymentSourceResultSchema,
  deploymentJobKey,
  HabGenerationReleaseResultSchema,
  readDeploymentBySource,
  readLiveDeployments,
  ReleaseDeploymentJobInputSchema,
} from "@yrd/grove"
export type {
  DeploymentPin,
  DeploymentSourceResult,
  DeploymentSubmoduleResult,
  GitDeploymentStore,
  GitDeploymentStoreOptions,
  MaterializeDeploymentInput,
  ReleaseDeploymentInput,
  ReleaseDeploymentJobInput,
} from "@yrd/grove"

export type DeploymentJobDefs = Readonly<{
  "deployment.materialize": JobDef<MaterializeDeploymentInput, DeploymentSourceResult>
  "deployment.reap": JobDef<MaterializeDeploymentInput, Readonly<{ reaped: true; path: string }>>
  "deployment.release": JobDef<ReleaseDeploymentJobInput, Readonly<{ released: true; path: string }>>
}>

function deploymentFailure(code: string, cause: unknown) {
  return {
    status: "completed",
    conclusion: "failure",
    error: { code, message: cause instanceof Error ? cause.message : String(cause) },
  } as const
}

/**
 * Journal-backed lifecycle definitions for immutable deployment resources.
 * Result files are derived crash evidence only; callers request these Jobs
 * with {@link deploymentJobKey} so the Journal remains the mutable authority.
 */
export function createDeploymentJobDefs(store: GitDeploymentStore): DeploymentJobDefs {
  return Object.freeze({
    "deployment.materialize": createJobDef({
      name: "deployment.materialize",
      title: "Materialize immutable deployment",
      revision: "deployment-materialize-v1",
      input: DeploymentInputSchema,
      output: DeploymentSourceResultSchema,
      observe: (input) => ({ lifecycle: "deployment-materialization", attributes: { ...input } }),
      async execute(input) {
        try {
          return { status: "completed", conclusion: "success", output: await store.materialize(input) }
        } catch (cause) {
          return deploymentFailure("deployment-materialize-failed", cause)
        }
      },
    }),
    "deployment.reap": createJobDef({
      name: "deployment.reap",
      title: "Reap unpublished deployment",
      revision: "deployment-reap-v1",
      input: DeploymentInputSchema,
      output: ReapedDeploymentSchema,
      observe: (input) => ({ lifecycle: "deployment-reap", attributes: { ...input } }),
      async execute(input) {
        try {
          return { status: "completed", conclusion: "success", output: await store.reap(input) }
        } catch (cause) {
          return deploymentFailure("deployment-reap-failed", cause)
        }
      },
    }),
    "deployment.release": createJobDef({
      name: "deployment.release",
      title: "Release immutable deployment",
      revision: "deployment-release-v1",
      input: ReleaseDeploymentJobInputSchema,
      output: ReleasedDeploymentSchema,
      observe: (input) => ({ lifecycle: "deployment-release", attributes: { ...input } }),
      async execute(input) {
        try {
          assertExactRelease(input, input.authorization)
          assertHabReleaseAuthorization(input)
          return { status: "completed", conclusion: "success", output: await store.release(input) }
        } catch (cause) {
          return deploymentFailure("deployment-release-failed", cause)
        }
      },
    }),
  })
}
