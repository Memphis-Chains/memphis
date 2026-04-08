import {
  runDeployPipeline,
  type DeployInput as MemphisDeployInput,
  type DeployResult as MemphisDeployOutput,
} from '../../infra/deploy/pipeline.js';

export type { MemphisDeployInput, MemphisDeployOutput };

export async function runMemphisDeploy(
  input: MemphisDeployInput = {},
): Promise<MemphisDeployOutput> {
  return runDeployPipeline(input);
}
