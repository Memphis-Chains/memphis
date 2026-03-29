import { describe, it, expect } from 'vitest';

import {
  sanitizeForTerminal,
  sanitizeForLog,
  validateProviderName,
  sanitizeDegradationReason,
  sanitizeForJson,
} from '../../src/infra/security/sanitizers.js';

describe('Security Sanitizers', () => {
  describe('sanitizeForTerminal', () => {
    it('strips CSI sequences', () => {
      const attack = '\x1b[31mRED\x1b[0m';
      expect(sanitizeForTerminal(attack)).toBe('RED');
    });

    it('strips OSC sequences', () => {
      const attack = '\x1b]0;TITLE\x07';
      expect(sanitizeForTerminal(attack)).toBe('');
    });

    it('removes null bytes', () => {
      const attack = 'foo\x00bar';
      expect(sanitizeForTerminal(attack)).toBe('foobar');
    });

    it('removes bell character', () => {
      const attack = 'alert\x07';
      expect(sanitizeForTerminal(attack)).toBe('alert');
    });

    it('keeps newlines, tabs, carriage returns', () => {
      const input = 'line1\nline2\ttab\rcarriage';
      expect(sanitizeForTerminal(input)).toBe('line1\nline2\ttab\rcarriage');
    });

    it('limits output length to 1000 chars', () => {
      const huge = 'x'.repeat(10000);
      const result = sanitizeForTerminal(huge);
      expect(result.length).toBe(1000);
    });

    it('handles empty string', () => {
      expect(sanitizeForTerminal('')).toBe('');
    });

    it('handles Unicode safely', () => {
      const emoji = 'Hello 👋 World 🌍';
      expect(sanitizeForTerminal(emoji)).toBe(emoji);
    });
  });

  describe('sanitizeForLog', () => {
    it('converts newlines to spaces', () => {
      const attack = 'error\nFAKE LOG ENTRY: success';
      expect(sanitizeForLog(attack)).toBe('error FAKE LOG ENTRY: success');
    });

    it('removes carriage returns', () => {
      const attack = 'progress: 50%\rDELETED';
      expect(sanitizeForLog(attack)).toBe('progress: 50% DELETED');
    });

    it('trims whitespace', () => {
      const input = '  spaced  \n\n  ';
      expect(sanitizeForLog(input)).toBe('spaced');
    });

    it('strips ANSI sequences and converts newlines', () => {
      const attack = '\x1b[31mERROR\x1b[0m\nSUCCESS';
      expect(sanitizeForLog(attack)).toBe('ERROR SUCCESS');
    });
  });

  describe('validateProviderName', () => {
    it('allows safe alphanumeric names', () => {
      expect(validateProviderName('ollama')).toBe(true);
      expect(validateProviderName('deepseek')).toBe(true);
      expect(validateProviderName('gpt4')).toBe(true);
    });

    it('allows dash and underscore', () => {
      expect(validateProviderName('deepseek-chat')).toBe(true);
      expect(validateProviderName('gpt_4')).toBe(true);
      expect(validateProviderName('model-name_123')).toBe(true);
    });

    it('rejects path traversal attempts', () => {
      expect(validateProviderName('../../etc/passwd')).toBe(false);
      expect(validateProviderName('../.env')).toBe(false);
      expect(validateProviderName('./config')).toBe(false);
    });

    it('rejects spaces', () => {
      expect(validateProviderName('foo bar')).toBe(false);
      expect(validateProviderName('gpt 4')).toBe(false);
    });

    it('rejects special characters', () => {
      expect(validateProviderName('foo;rm -rf /')).toBe(false);
      expect(validateProviderName('foo$(whoami)')).toBe(false);
      expect(validateProviderName('foo`ls`')).toBe(false);
      expect(validateProviderName('foo|bar')).toBe(false);
      expect(validateProviderName('foo&bar')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateProviderName('')).toBe(false);
    });

    it('rejects too long names (>50 chars)', () => {
      expect(validateProviderName('a'.repeat(51))).toBe(false);
      expect(validateProviderName('a'.repeat(50))).toBe(true);
    });
  });

  describe('sanitizeDegradationReason', () => {
    it('passes through short safe strings', () => {
      const input = 'provider in cooldown';
      expect(sanitizeDegradationReason(input)).toBe(input);
    });

    it('truncates long strings with ellipsis', () => {
      const long = 'x'.repeat(500);
      const result = sanitizeDegradationReason(long);
      expect(result.length).toBe(200);
      expect(result.endsWith('...')).toBe(true);
      expect(result).toBe('x'.repeat(197) + '...');
    });

    it('strips ANSI sequences from reason', () => {
      const attack = '\x1b[31mERROR\x1b[0m in provider';
      expect(sanitizeDegradationReason(attack)).toBe('ERROR in provider');
    });

    it('removes control characters', () => {
      const attack = 'error\x00\x07\x1b[31m';
      expect(sanitizeDegradationReason(attack)).toBe('error');
    });
  });

  describe('sanitizeForJson', () => {
    it('removes all control characters', () => {
      const attack = 'foo\x00\x01\x07\x1b[31mbar';
      expect(sanitizeForJson(attack)).toBe('foo[31mbar');
    });

    it('removes replacement characters', () => {
      const input = 'test\uFFFDvalue';
      expect(sanitizeForJson(input)).toBe('testvalue');
    });

    it('limits output length to 1000 chars', () => {
      const huge = 'x'.repeat(5000);
      const result = sanitizeForJson(huge);
      expect(result.length).toBe(1000);
    });

    it('keeps valid Unicode', () => {
      const emoji = 'API response 🚀 success ✅';
      expect(sanitizeForJson(emoji)).toBe(emoji);
    });

    it('handles empty string', () => {
      expect(sanitizeForJson('')).toBe('');
    });
  });

  describe('DoS prevention', () => {
    it('limits terminal output to 1000 chars', () => {
      const huge = 'x'.repeat(10000);
      expect(sanitizeForTerminal(huge).length).toBeLessThanOrEqual(1000);
    });

    it('limits JSON output to 1000 chars', () => {
      const huge = 'y'.repeat(10000);
      expect(sanitizeForJson(huge).length).toBeLessThanOrEqual(1000);
    });

    it('limits degradation reason to 200 chars', () => {
      const huge = 'z'.repeat(1000);
      expect(sanitizeDegradationReason(huge).length).toBeLessThanOrEqual(200);
    });
  });
});
