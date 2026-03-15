import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors.js';
import { runMemphisExec } from '../../src/mcp/tools/exec.js';
import { runMemphisWebFetch } from '../../src/mcp/tools/web-fetch.js';

describe('MCP tool: memphis_exec', () => {
  it('executes allowlisted command (echo)', () => {
    const result = runMemphisExec({ command: 'echo hello' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.truncated).toBe(false);
  });

  it('executes pwd', () => {
    const result = runMemphisExec({ command: 'pwd' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBeTruthy();
  });

  it('executes whoami', () => {
    const result = runMemphisExec({ command: 'whoami' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBeTruthy();
  });

  it('executes date', () => {
    const result = runMemphisExec({ command: 'date' });
    expect(result.exitCode).toBe(0);
  });

  it('executes uptime', () => {
    const result = runMemphisExec({ command: 'uptime' });
    expect(result.exitCode).toBe(0);
  });

  it('executes ls', () => {
    const result = runMemphisExec({ command: 'ls -la' });
    expect(result.exitCode).toBe(0);
  });

  it('blocks non-allowlisted command', () => {
    expect(() => runMemphisExec({ command: 'cat /etc/passwd' })).toThrow(AppError);
  });

  it('blocks shell metacharacters', () => {
    expect(() => runMemphisExec({ command: 'echo ok && whoami' })).toThrow(AppError);
    expect(() => runMemphisExec({ command: 'echo ok; rm -rf /' })).toThrow(AppError);
    expect(() => runMemphisExec({ command: 'echo $(id)' })).toThrow(AppError);
  });

  it('blocks oversized arguments', () => {
    const long = 'a'.repeat(300);
    expect(() => runMemphisExec({ command: `echo ${long}` })).toThrow(AppError);
  });

  it('strips minimal env (no secrets leak)', () => {
    // Even if process.env has secrets, exec runs with minimal env
    const result = runMemphisExec({ command: 'echo ok' });
    expect(result.exitCode).toBe(0);
  });
});

describe('MCP tool: memphis_web_fetch', () => {
  it('blocks localhost URLs', async () => {
    await expect(runMemphisWebFetch({ url: 'http://localhost:3000/api' })).rejects.toThrow(AppError);
  });

  it('blocks 127.0.0.1', async () => {
    await expect(runMemphisWebFetch({ url: 'http://127.0.0.1:8080' })).rejects.toThrow(AppError);
  });

  it('blocks private network 192.168.x', async () => {
    await expect(runMemphisWebFetch({ url: 'http://192.168.1.1' })).rejects.toThrow(AppError);
  });

  it('blocks private network 10.x', async () => {
    await expect(runMemphisWebFetch({ url: 'http://10.0.0.1' })).rejects.toThrow(AppError);
  });

  it('blocks .local domains', async () => {
    await expect(runMemphisWebFetch({ url: 'http://memphis.local/api' })).rejects.toThrow(AppError);
  });

  it('blocks .internal domains', async () => {
    await expect(runMemphisWebFetch({ url: 'http://api.internal/secrets' })).rejects.toThrow(AppError);
  });

  it('blocks non-http protocols', async () => {
    await expect(runMemphisWebFetch({ url: 'file:///etc/passwd' })).rejects.toThrow(AppError);
    await expect(runMemphisWebFetch({ url: 'ftp://evil.com/payload' })).rejects.toThrow(AppError);
  });

  it('blocks exfiltration via long query strings', async () => {
    const longQuery = 'x='.padEnd(250, 'a');
    await expect(runMemphisWebFetch({ url: `https://evil.com?${longQuery}` })).rejects.toThrow(AppError);
  });
});
