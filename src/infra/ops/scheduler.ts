export interface ScheduledTask {
  id: string;
  name: string;
  intervalMs: number;
  lastRun: number | null;
  nextRun: number;
  enabled: boolean;
  running: boolean;
  lastError: string | null;
}

export type TaskFn = () => Promise<{ ok: boolean; detail?: string }>;

interface TaskRecord {
  def: { name: string; intervalMs: number; fn: TaskFn };
  state: ScheduledTask;
}

export class SimpleScheduler {
  private tasks: Map<string, TaskRecord> = new Map();
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private running = false;
  private onTaskComplete?: (
    id: string,
    result: { ok: boolean; detail?: string },
    error?: unknown,
  ) => void;

  constructor(
    private onError?: (id: string, error: unknown) => void,
    onTaskComplete?: (
      id: string,
      result: { ok: boolean; detail?: string },
      error?: unknown,
    ) => void,
  ) {
    this.onTaskComplete = onTaskComplete;
  }

  schedule(id: string, name: string, intervalMs: number, fn: TaskFn): void {
    if (this.tasks.has(id)) {
      return; // Already scheduled
    }
    const now = Date.now();
    const state: ScheduledTask = {
      id,
      name,
      intervalMs,
      lastRun: null,
      nextRun: now + intervalMs,
      enabled: true,
      running: false,
      lastError: null,
    };
    this.tasks.set(id, { def: { name, intervalMs, fn }, state });
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const [id, record] of this.tasks) {
      this.scheduleInterval(id, record);
    }
  }

  stop(): void {
    this.running = false;
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id)?.state;
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values()).map((r) => r.state);
  }

  enableTask(id: string): boolean {
    const record = this.tasks.get(id);
    if (!record) return false;
    record.state.enabled = true;
    return true;
  }

  disableTask(id: string): boolean {
    const record = this.tasks.get(id);
    if (!record) return false;
    record.state.enabled = false;
    return true;
  }

  async runNow(id: string): Promise<{ ok: boolean; detail?: string } | null> {
    const record = this.tasks.get(id);
    if (!record) return null;
    return this.executeTask(id, record);
  }

  private scheduleInterval(id: string, record: TaskRecord): void {
    const interval = setInterval(async () => {
      if (!record.state.enabled || !this.running) return;
      await this.executeTask(id, record);
    }, record.def.intervalMs);
    this.intervals.set(id, interval);
  }

  private async executeTask(
    id: string,
    record: TaskRecord,
  ): Promise<{ ok: boolean; detail?: string }> {
    if (record.state.running) {
      return { ok: false, detail: 'task already running' };
    }

    record.state.running = true;
    record.state.lastRun = Date.now();
    record.state.nextRun = Date.now() + record.def.intervalMs;

    let result: { ok: boolean; detail?: string };
    try {
      result = await record.def.fn();
    } catch (error) {
      record.state.running = false;
      record.state.lastError = error instanceof Error ? error.message : String(error);
      this.onError?.(id, error);
      this.onTaskComplete?.(id, { ok: false, detail: record.state.lastError }, error);
      return { ok: false, detail: record.state.lastError };
    }

    record.state.running = false;
    if (!result.ok) {
      record.state.lastError = result.detail ?? 'task failed';
    } else {
      record.state.lastError = null;
    }
    this.onTaskComplete?.(id, result);
    return result;
  }
}

export const INTERVAL_5_MIN = 5 * 60 * 1000;
export const INTERVAL_30_MIN = 30 * 60 * 1000;
export const INTERVAL_24_HOUR = 24 * 60 * 60 * 1000;
