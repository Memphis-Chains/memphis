import { describe, expect, test } from 'vitest';
import { OnboardingWizard } from '../../src/onboarding/wizard.js';

class TestWizard extends OnboardingWizard {
  constructor(
    private readonly rustOk: boolean,
    private readonly nodeOk: boolean,
    setupEnvironment: () => Promise<void>,
  ) {
    super(setupEnvironment);
  }

  override async execCommand(cmd: string): Promise<string> {
    if (cmd.startsWith('rustc')) {
      if (!this.rustOk) throw new Error('missing rust');
      return 'rustc 1.80.0';
    }
    if (cmd.startsWith('node')) {
      if (!this.nodeOk) throw new Error('missing node');
      return 'v24.0.0';
    }
    return '';
  }
}

describe('OnboardingWizard', () => {
  test('fails fast on missing prerequisites', async () => {
    const wizard = new TestWizard(false, true, async () => undefined);
    const result = await wizard.run();

    expect(result.success).toBe(false);
    expect(result.errors?.join(' ')).toContain('Rust');
  });

  test('retries setup and succeeds', async () => {
    let attempts = 0;
    const wizard = new TestWizard(true, true, async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient setup error');
    });

    const result = await wizard.run();
    expect(result.success).toBe(true);
    expect(attempts).toBe(3);
  });
});
