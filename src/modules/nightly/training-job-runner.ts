// STUB — incomplete implementation from training session
// Replace with real implementation when training proposer is wired up

export const TRAINING_JOB_TYPE = 'training_job' as const;
export const INSTALL_JOB_TYPE = 'install_job' as const;
export const TRAINING_JOB_RUNNER = 'training-job-runner';

export type TrainingJob = {
  type: typeof TRAINING_JOB_TYPE;
  // ... extend as needed
};

export type InstallJob = {
  type: typeof INSTALL_JOB_TYPE;
  // ... extend as needed
};
