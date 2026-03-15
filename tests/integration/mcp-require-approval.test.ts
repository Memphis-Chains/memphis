/**
 * Integration test: require-approval policy enforcement via MCP.
 *
 * Tests the full flow:
 * 1. Set tool to require-approval
 * 2. Call tool via MCP → get pending response
 * 3. Approve via repository
 * 4. Re-call with approval_request_id → tool executes
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as journalTool from '../../src/mcp/tools/journal.js';

// Shared temp dir per test — must be set before importing the MCP server
let testDir: string;
let testDbUrl: string;

vi.mock('../../src/infra/config/env.js', () => ({
  loadConfig: () => ({
    DATABASE_URL: testDbUrl,
    DATA_DIR: testDir,
    HOST: '127.0.0.1',
    PORT: 3000,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  }),
}));

describe('MCP require-approval policy', () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'memphis-mcp-approval-'));
    testDbUrl = `file:${join(testDir, 'test.db')}`;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
    vi.restoreAllMocks();
  });

  async function setupDb() {
    const { createSqliteClient, runMigrations } = await import(
      '../../src/infra/storage/sqlite/client.js'
    );
    const db = createSqliteClient(testDbUrl);
    runMigrations(db);
    return db;
  }

  async function connect(): Promise<Client> {
    // Dynamic import so the mock is active
    const { createMemphisMcpServer } = await import('../../src/mcp/server.js');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMemphisMcpServer();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-approval', version: '1.0.0' });
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
    };

    return client;
  }

  it('tools with require-approval are still discoverable', async () => {
    const db = await setupDb();
    const { SqliteToolPermissionRepository } = await import(
      '../../src/infra/storage/sqlite/repositories/tool-permission-repository.js'
    );
    const permRepo = new SqliteToolPermissionRepository(db);
    permRepo.set('memphis_journal', 'require-approval');

    const c = await connect();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('memphis_journal');
  });

  it('require-approval tool returns pending on first call', async () => {
    const db = await setupDb();
    const { SqliteToolPermissionRepository } = await import(
      '../../src/infra/storage/sqlite/repositories/tool-permission-repository.js'
    );
    const permRepo = new SqliteToolPermissionRepository(db);
    permRepo.set('memphis_journal', 'require-approval');

    vi.spyOn(journalTool, 'runMemphisJournal').mockResolvedValue({
      success: true,
      index: 1,
      hash: 'test',
    });

    const c = await connect();
    const result = await c.callTool({
      name: 'memphis_journal',
      arguments: { content: 'test entry' },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.approved).toBe(false);
    expect(parsed.state).toBe('pending');
    expect(parsed.requestId).toBeTruthy();
    expect(parsed.message).toContain('requires operator approval');

    // Journal should NOT have been called
    expect(journalTool.runMemphisJournal).not.toHaveBeenCalled();
  });

  it('full flow: pending → approve → execute', async () => {
    const db = await setupDb();
    const { SqliteToolPermissionRepository } = await import(
      '../../src/infra/storage/sqlite/repositories/tool-permission-repository.js'
    );
    const { SqliteToolCallApprovalRepository } = await import(
      '../../src/infra/storage/sqlite/repositories/tool-call-approval-repository.js'
    );
    const permRepo = new SqliteToolPermissionRepository(db);
    const approvalRepo = new SqliteToolCallApprovalRepository(db);
    permRepo.set('memphis_journal', 'require-approval');

    vi.spyOn(journalTool, 'runMemphisJournal').mockResolvedValue({
      success: true,
      index: 42,
      hash: 'approved_hash',
    });

    const c = await connect();

    // Step 1: Call tool → get pending
    const pendingResult = await c.callTool({
      name: 'memphis_journal',
      arguments: { content: 'needs approval' },
    });
    const pendingContent = pendingResult.content as Array<{ type: string; text: string }>;
    const pendingParsed = JSON.parse(pendingContent[0].text);
    expect(pendingParsed.approved).toBe(false);
    const requestId = pendingParsed.requestId as string;

    // Step 2: Operator approves (simulating CLI)
    approvalRepo.approve(requestId);

    // Step 3: Agent re-calls with approval_request_id
    const approvedResult = await c.callTool({
      name: 'memphis_journal',
      arguments: { content: 'needs approval', approval_request_id: requestId },
    });

    const approvedContent = approvedResult.content as Array<{ type: string; text: string }>;
    const approvedParsed = JSON.parse(approvedContent[0].text);
    expect(approvedParsed.success).toBe(true);
    expect(approvedParsed.index).toBe(42);
    expect(journalTool.runMemphisJournal).toHaveBeenCalled();
  });

  it('denied tools are not discoverable', async () => {
    const db = await setupDb();
    const { SqliteToolPermissionRepository } = await import(
      '../../src/infra/storage/sqlite/repositories/tool-permission-repository.js'
    );
    const permRepo = new SqliteToolPermissionRepository(db);
    permRepo.set('memphis_exec', 'deny');

    const c = await connect();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('memphis_exec');
  });
});
