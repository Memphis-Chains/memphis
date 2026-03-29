import { describe, it, expect } from 'vitest';

import {
  sanitizeForTerminal,
  sanitizeForLog,
  validateProviderName,
  sanitizeDegradationReason,
} from '../../src/infra/security/sanitizers.js';

describe('Prompt Injection Defense', () => {
  describe('ANSI escape sequence injection', () => {
    it('strips CSI sequences', () => {
      const attack = '\x1b[31mRED\x1b[0m';
      expect(sanitizeForTerminal(attack)).toBe('RED');
    });

    it('strips OSC sequences', () => {
      const attack = '\x1b]0;TITLE\x07';
      expect(sanitizeForTerminal(attack)).toBe('');
    });

    it('strips complex ANSI sequences', () => {
      const attack = '\x1b[1;31;40mBOLD RED ON BLACK\x1b[0m';
      expect(sanitizeForTerminal(attack)).toBe('BOLD RED ON BLACK');
    });

    it('prevents cursor movement injection', () => {
      const attack = 'Progress: 50%\x1b[2K\x1b[GDeleted all files';
      expect(sanitizeForTerminal(attack)).toBe('Progress: 50%Deleted all files');
    });
  });

  describe('Control character injection', () => {
    it('removes null bytes', () => {
      const attack = 'foo\x00bar';
      expect(sanitizeForTerminal(attack)).toBe('foobar');
    });

    it('removes bell character', () => {
      const attack = 'alert\x07';
      expect(sanitizeForTerminal(attack)).toBe('alert');
    });

    it('removes backspace character', () => {
      const attack = 'test\x08\x08\x08\x08FAIL';
      expect(sanitizeForTerminal(attack)).toBe('testFAIL');
    });

    it('removes vertical tab', () => {
      const attack = 'line1\x0Bline2';
      expect(sanitizeForTerminal(attack)).toBe('line1line2');
    });
  });

  describe('Log injection', () => {
    it('converts newlines to spaces', () => {
      const attack = 'error\nFAKE LOG ENTRY: success';
      expect(sanitizeForLog(attack)).toBe('error FAKE LOG ENTRY: success');
    });

    it('removes carriage returns', () => {
      const attack = 'progress: 50%\rDELETED';
      expect(sanitizeForLog(attack)).toBe('progress: 50% DELETED');
    });

    it('prevents multi-line log injection', () => {
      const attack = 'normal\n[ERROR] injected error\n[INFO] injected info';
      expect(sanitizeForLog(attack)).toBe('normal [ERROR] injected error [INFO] injected info');
    });

    it('prevents CRLF injection', () => {
      const attack = 'test\r\nINJECTED LINE';
      expect(sanitizeForLog(attack)).toBe('test  INJECTED LINE');
    });
  });

  describe('Provider name validation', () => {
    it('allows safe names', () => {
      expect(validateProviderName('ollama')).toBe(true);
      expect(validateProviderName('deepseek-chat')).toBe(true);
      expect(validateProviderName('gpt_4')).toBe(true);
    });

    it('rejects path traversal', () => {
      expect(validateProviderName('../../etc/passwd')).toBe(false);
      expect(validateProviderName('../.env')).toBe(false);
      expect(validateProviderName('./local')).toBe(false);
    });

    it('rejects special chars', () => {
      expect(validateProviderName('foo bar')).toBe(false);
      expect(validateProviderName('foo;rm -rf /')).toBe(false);
      expect(validateProviderName('foo$(whoami)')).toBe(false);
      expect(validateProviderName('foo`cat /etc/passwd`')).toBe(false);
    });

    it('rejects shell metacharacters', () => {
      expect(validateProviderName('foo|bar')).toBe(false);
      expect(validateProviderName('foo&bar')).toBe(false);
      expect(validateProviderName('foo>bar')).toBe(false);
      expect(validateProviderName('foo<bar')).toBe(false);
    });

    it('rejects too long', () => {
      expect(validateProviderName('a'.repeat(51))).toBe(false);
    });

    it('rejects empty', () => {
      expect(validateProviderName('')).toBe(false);
    });
  });

  describe('DoS prevention', () => {
    it('limits output length', () => {
      const huge = 'x'.repeat(10000);
      const result = sanitizeForTerminal(huge);
      expect(result.length).toBeLessThanOrEqual(1000);
    });

    it('truncates reasons with ellipsis', () => {
      const long = 'x'.repeat(500);
      const result = sanitizeDegradationReason(long);
      expect(result.length).toBeLessThanOrEqual(200);
      expect(result.endsWith('...')).toBe(true);
    });

    it('handles exponential expansion attacks', () => {
      // Attempt to create exponential string via repeated doubling
      const attack = 'X'.repeat(100000);
      const result = sanitizeForTerminal(attack);
      expect(result.length).toBe(1000);
    });
  });

  describe('Combined attack scenarios', () => {
    it('handles ANSI + control chars + newlines', () => {
      const attack = '\x1b[31mERROR\x00\x07\x1b[0m\nSUCCESS';
      expect(sanitizeForLog(attack)).toBe('ERROR SUCCESS');
    });

    it('sanitizes degradation reason with multiple vectors', () => {
      const attack = '\x1b[31mProvider failed\x00\nFAKE: success\x07';
      const result = sanitizeDegradationReason(attack);
      expect(result).not.toContain('\x1b');
      expect(result).not.toContain('\x00');
      expect(result).not.toContain('\x07');
      expect(result).toContain('\n'); // newlines preserved in terminal (not log)
    });
  });
});
