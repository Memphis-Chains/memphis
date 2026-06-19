import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SpawnTrainingJobInput {
  jobId: string;
  mode: string;
  corpusDir: string;
  outDir: string;
  signingSeedFile: string;
  rawEnv?: NodeJS.ProcessEnv;
}

export interface TrainingExitResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason: string;
}

export interface TrainingJobHandle {
  jobId: string;
  pid: number;
  exit: Promise<TrainingExitResult>;
  cancel(): boolean;
}

const liveChildren = new Map<string, ChildProcess>();

function resolveDataDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return rawEnv.MEMPHIS_DATA_DIR?.trim() || join(rawEnv.HOME ?? process.cwd(), '.memphis');
}

export function getStatusFilePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataDir(rawEnv), 'state', 'kartograf-training.json');
}

export function listLiveTrainingJobs(): Array<{ jobId: string; pid: number }> {
  return Array.from(liveChildren.entries()).map(([jobId, child]) => ({
    jobId,
    pid: child.pid ?? -1,
  }));
}

export function cancelTrainingJob(jobId: string): boolean {
  const child = liveChildren.get(jobId);
  if (!child) return false;
  return child.kill('SIGTERM');
}

export function __resetTrainingRegistryForTests(): void {
  for (const child of liveChildren.values()) {
    if (!child.killed) child.kill('SIGTERM');
  }
  liveChildren.clear();
}

export function spawnTrainingJob(input: SpawnTrainingJobInput): TrainingJobHandle {
  mkdirSync(join(resolveDataDir(input.rawEnv), 'state'), { recursive: true });
  mkdirSync(input.outDir, { recursive: true });

  const script =
    input.mode === 'stub'
      ? [
          'import pathlib, sys, time',
          'out = pathlib.Path(sys.argv[1])',
          'out.mkdir(parents=True, exist_ok=True)',
          '(out / "checkpoint.json").write_text("{\\"ok\\":true}\\n", encoding="utf-8")',
          'time.sleep(0.2)',
        ].join('; ')
      : [
          'import pathlib, sys',
          'out = pathlib.Path(sys.argv[1])',
          'out.mkdir(parents=True, exist_ok=True)',
          '(out / "checkpoint.json").write_text("{\\"ok\\":true}\\n", encoding="utf-8")',
        ].join('; ');

  const child = spawn('python3', ['-c', script, input.outDir], {
    env: { ...process.env, ...input.rawEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.set(input.jobId, child);

  const exit = new Promise<TrainingExitResult>((resolve) => {
    child.once('close', (code, signal) => {
      liveChildren.delete(input.jobId);
      const ok = code === 0 && signal === null;
      resolve({
        ok,
        exitCode: code,
        signal,
        reason: ok
          ? ''
          : signal
            ? `child terminated by ${signal}`
            : `child exited with code ${code ?? 'unknown'}`,
      });
    });
    child.once('error', (error) => {
      liveChildren.delete(input.jobId);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        reason: error.message,
      });
    });
  });

  return {
    jobId: input.jobId,
    pid: child.pid ?? -1,
    exit,
    cancel: () => cancelTrainingJob(input.jobId),
  };
}
