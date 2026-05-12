/**
 * REV2 Temat 3.5 — memphis_exec_analyze tool.
 *
 * Pure-parser tests; no real exec.
 */
import { describe, expect, it } from 'vitest';

import {
  parseCommand,
  runMemphisExecAnalyze,
} from '../../src/mcp/tools/exec-analyze.js';

describe('parseCommand', () => {
  it('parses simple base + args', () => {
    const r = parseCommand('ls -la /tmp');
    expect(r.base).toBe('ls');
    expect(r.args).toEqual(['-la', '/tmp']);
  });

  it('handles double-quoted args', () => {
    const r = parseCommand('grep "needle in haystack" file.txt');
    expect(r.base).toBe('grep');
    expect(r.args).toEqual(['needle in haystack', 'file.txt']);
  });

  it('handles single-quoted args', () => {
    const r = parseCommand("echo 'hello world'");
    expect(r.base).toBe('echo');
    expect(r.args).toEqual(['hello world']);
  });

  it('returns empty parse on empty input', () => {
    expect(parseCommand('').base).toBe('');
    expect(parseCommand('   ').base).toBe('');
  });
});

describe('runMemphisExecAnalyze — read-only commands', () => {
  it('classifies `ls` as safe-to-run', () => {
    const r = runMemphisExecAnalyze({ command: 'ls -la' });
    expect(r.side_effects).toBe('read-only');
    expect(r.reversibility).toBe('idempotent');
    expect(r.recommendation).toBe('safe-to-run');
    expect(r.tier_required).toBe(2);
  });

  it('classifies `git status` as safe-to-run', () => {
    const r = runMemphisExecAnalyze({ command: 'git status' });
    expect(r.semantic).toContain('git: status');
    expect(r.side_effects).toBe('read-only');
    expect(r.recommendation).toBe('safe-to-run');
  });

  it('classifies `find -delete` as local-write with warning', () => {
    const r = runMemphisExecAnalyze({ command: 'find . -name "*.tmp" -delete' });
    expect(r.side_effects).toBe('local-write');
    expect(r.warnings.some((w) => /delete|mutates/.test(w))).toBe(true);
  });
});

describe('runMemphisExecAnalyze — destructive commands', () => {
  it('classifies `rm -rf` as irreversible + ask-operator', () => {
    const r = runMemphisExecAnalyze({ command: 'rm -rf /tmp/junk' });
    expect(r.side_effects).toBe('irreversible');
    expect(r.reversibility).toBe('irreversible');
    expect(r.tier_required).toBe(3);
    expect(r.recommendation).toBe('ask-operator');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('classifies `dd` as irreversible + ask-operator', () => {
    const r = runMemphisExecAnalyze({ command: 'dd if=/dev/zero of=/tmp/x bs=1M' });
    expect(r.side_effects).toBe('irreversible');
    expect(r.recommendation).toBe('ask-operator');
  });

  it('classifies `git reset --hard` with strong warning', () => {
    const r = runMemphisExecAnalyze({ command: 'git reset --hard HEAD~1' });
    expect(r.semantic).toContain('git: reset');
    expect(r.warnings.some((w) => /reset --hard|discards/.test(w))).toBe(true);
  });

  it('classifies `git push --force` with rewrite-history warning', () => {
    const r = runMemphisExecAnalyze({ command: 'git push --force origin main' });
    expect(r.warnings.some((w) => /rewrites remote history/.test(w))).toBe(true);
  });
});

describe('runMemphisExecAnalyze — protected paths', () => {
  it('refuses commands touching ~/.memphis/vault/', () => {
    const r = runMemphisExecAnalyze({
      command: 'cat /home/memphis/.memphis/vault/vault-state.json',
    });
    expect(r.recommendation).toBe('refuse');
    expect(r.warnings.some((w) => /protected path/.test(w))).toBe(true);
  });

  it('refuses commands touching .env files', () => {
    const r = runMemphisExecAnalyze({ command: 'cat .env' });
    expect(r.recommendation).toBe('refuse');
  });

  it('refuses commands targeting block devices', () => {
    const r = runMemphisExecAnalyze({ command: 'dd if=/dev/zero of=/dev/sda' });
    expect(r.recommendation).toBe('refuse');
  });
});

describe('runMemphisExecAnalyze — system-state commands', () => {
  it('classifies `apt install` as system-state + analyze-then-run', () => {
    const r = runMemphisExecAnalyze({ command: 'apt install vim' });
    expect(r.side_effects).toBe('system-state');
    expect(r.reversibility).toBe('reversible');
    expect(r.tier_required).toBe(3);
    expect(r.recommendation).toBe('analyze-then-run');
    expect(r.dry_run_command).toContain('-s');
  });

  it('classifies `sudo X` with elevated-execution warning', () => {
    const r = runMemphisExecAnalyze({ command: 'sudo apt update' });
    expect(r.warnings.some((w) => /sudo|root authority/.test(w))).toBe(true);
  });
});

describe('runMemphisExecAnalyze — network commands', () => {
  it('classifies plain `curl` as network + safe', () => {
    const r = runMemphisExecAnalyze({ command: 'curl https://example.com/data.json' });
    expect(r.side_effects).toBe('network');
    expect(r.recommendation).toBe('analyze-then-run');
  });

  it('warns when curl uses -X POST or -d', () => {
    const r = runMemphisExecAnalyze({ command: 'curl -X POST -d "{}" https://api.example.com' });
    expect(r.warnings.some((w) => /POST|payload body/.test(w))).toBe(true);
  });
});

describe('runMemphisExecAnalyze — unknown commands', () => {
  it('classifies unknown bases as unknown-impact with warning', () => {
    const r = runMemphisExecAnalyze({ command: 'frobnicate --frob 5' });
    expect(r.semantic).toContain('unclassified');
    expect(r.recommendation).toBe('analyze-then-run');
    expect(r.warnings.some((w) => /unrecognised command/.test(w))).toBe(true);
  });
});

describe('runMemphisExecAnalyze — surface_intent', () => {
  it('passes surface_intent through to output for audit', () => {
    const r = runMemphisExecAnalyze({
      command: 'ls /tmp',
      surface_intent: 'verify the tg-photo file is on disk',
    });
    expect(r.surface_intent).toBe('verify the tg-photo file is on disk');
  });
});
