import { getTensorStatus, type TensorStatus } from '../../infra/tensors/status.js';

export function runMemphisTensorStatus(
  rawEnv: NodeJS.ProcessEnv = process.env,
): TensorStatus {
  return getTensorStatus(rawEnv);
}
