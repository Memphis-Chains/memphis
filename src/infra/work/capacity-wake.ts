export class CapacityWake {
  private waiters = new Set<() => void>();

  public async wait(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return;

    await new Promise<void>((resolve) => {
      const wake = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
      };
      const timer = setTimeout(wake, timeoutMs);
      this.waiters.add(wake);
    });
  }

  public notify(): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const wake of pending) wake();
  }
}
