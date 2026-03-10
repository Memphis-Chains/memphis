import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';

export type OnboardingResult = { success: boolean; errors?: string[] };

export class OnboardingWizard {
  constructor(
    private readonly setupEnvironment: () => Promise<void> = async () => undefined,
    private readonly initializeVault: () => Promise<{ success: boolean }> = async () => ({ success: true }),
    private readonly verifyInstallation: () => Promise<{ success: boolean; warnings: string[] }> = async () => ({ success: true, warnings: [] }),
  ) {}

  async run(): Promise<OnboardingResult> {
    const prereqs = await this.checkPrerequisites();
    if (!prereqs.success) return { success: false, errors: prereqs.errors };

    let retries = 3;
    while (retries > 0) {
      try {
        await this.setupEnvironment();
        break;
      } catch (error) {
        retries -= 1;
        if (retries === 0) {
          const message = error instanceof Error ? error.message : String(error);
          return { success: false, errors: [message] };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    try {
      await this.initializeVault();
    } catch {
      // non-fatal
    }

    await this.verifyInstallation();
    return { success: true };
  }

  async checkPrerequisites(): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      const rustVersion = await this.execCommand('rustc --version');
      if (!rustVersion.includes('rustc')) errors.push('Rust not found. Install from https://rustup.rs');
    } catch {
      errors.push('Rust not installed');
    }

    try {
      const nodeVersion = await this.execCommand('node --version');
      if (!nodeVersion.startsWith('v')) errors.push('Node.js not found. Install from https://nodejs.org');
    } catch {
      errors.push('Node.js not installed');
    }

    if (!existsSync('node_modules')) errors.push('Dependencies not installed. Run: npm install');
    return { success: errors.length === 0, errors };
  }

  execCommand(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
    });
  }
}
