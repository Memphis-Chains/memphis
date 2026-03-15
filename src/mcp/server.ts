import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { runMemphisDecide } from './tools/decide.js';
import { runMemphisExec } from './tools/exec.js';
import { runMemphisHealth } from './tools/health.js';
import { runMemphisJournal } from './tools/journal.js';
import { runMemphisLoopStep } from './tools/loop-step.js';
import { runMemphisRecall } from './tools/recall.js';
import { runMemphisWebFetch } from './tools/web-fetch.js';
import { loadConfig } from '../infra/config/env.js';
import { createSqliteClient, runMigrations } from '../infra/storage/sqlite/client.js';
import { SqliteToolCallApprovalRepository } from '../infra/storage/sqlite/repositories/tool-call-approval-repository.js';
import {
  SqliteToolPermissionRepository,
  type ToolPolicy,
} from '../infra/storage/sqlite/repositories/tool-permission-repository.js';

interface RepoBundle {
  permissions: SqliteToolPermissionRepository;
  approvals: SqliteToolCallApprovalRepository;
}

function getRepos(): RepoBundle {
  const config = loadConfig();
  const db = createSqliteClient(config.DATABASE_URL);
  runMigrations(db);
  return {
    permissions: new SqliteToolPermissionRepository(db),
    approvals: new SqliteToolCallApprovalRepository(db),
  };
}

/**
 * Returns 'allow', 'deny', or 'require-approval' for a tool.
 * Tools without explicit permissions default to 'allow'.
 */
function getToolPolicy(repo: SqliteToolPermissionRepository, toolName: string): ToolPolicy {
  return repo.isAllowed(toolName).policy;
}

/** Should this tool be registered at all? */
function shouldRegister(policy: ToolPolicy): boolean {
  return policy !== 'deny';
}

/**
 * Wrap a tool handler to enforce require-approval gating.
 *
 * If the tool's policy is 'require-approval':
 * - If the caller provides an `approval_request_id` that has been approved, execute normally
 * - Otherwise, create a pending approval request and return a pending response
 *
 * If the tool's policy is 'allow', execute normally.
 */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function pendingResult(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function withApprovalGate<T extends Record<string, unknown>>(
  toolName: string,
  policy: ToolPolicy,
  approvals: SqliteToolCallApprovalRepository,
  handler: (args: T) => Promise<ToolResult>,
): (args: T) => Promise<ToolResult> {
  if (policy === 'allow') return handler;

  return async (args: T) => {
    const approvalRequestId = (args as Record<string, unknown>).approval_request_id as string | undefined;

    // If caller provides an approval_request_id, check if it's approved
    if (approvalRequestId) {
      const approved = approvals.findApproved(approvalRequestId);
      if (approved && approved.toolName === toolName) {
        approvals.markUsed(approvalRequestId);
        return handler(args);
      }

      // Check if it exists but isn't approved yet
      const existing = approvals.get(approvalRequestId);
      if (existing) {
        return pendingResult({
          approved: false,
          requestId: existing.requestId,
          state: existing.state,
          message: `tool call ${existing.state === 'pending' ? 'still awaiting' : existing.state}: operator must approve via CLI`,
        });
      }
    }

    // Create a pending approval request
    const request = approvals.createRequest({
      toolName,
      arguments: args as Record<string, unknown>,
    });

    return pendingResult({
      approved: false,
      requestId: request.requestId,
      state: 'pending',
      message: `tool '${toolName}' requires operator approval. Request ID: ${request.requestId}. Operator: run 'memphis config tools approve-call ${request.requestId}'`,
    });
  };
}

export function createMemphisMcpServer(): McpServer {
  const server = new McpServer({
    name: 'memphis-v5-mcp',
    version: '5.1.3',
  });

  const { permissions, approvals } = getRepos();

  const journalPolicy = getToolPolicy(permissions, 'memphis_journal');
  if (shouldRegister(journalPolicy)) {
    server.registerTool(
      'memphis_journal',
      {
        description: 'Save entries to journal chain',
        inputSchema: {
          content: z.string().min(1),
          tags: z.array(z.string()).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_journal', journalPolicy, approvals, async ({ content, tags }) => {
        const result = await runMemphisJournal({ content, tags });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const recallPolicy = getToolPolicy(permissions, 'memphis_recall');
  if (shouldRegister(recallPolicy)) {
    server.registerTool(
      'memphis_recall',
      {
        description: 'Semantic search across chains',
        inputSchema: {
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_recall', recallPolicy, approvals, async ({ query, limit }) => {
        const result = runMemphisRecall({ query, limit });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const decidePolicy = getToolPolicy(permissions, 'memphis_decide');
  if (shouldRegister(decidePolicy)) {
    server.registerTool(
      'memphis_decide',
      {
        description: 'Record decisions',
        inputSchema: {
          title: z.string().min(1),
          choice: z.string().min(1),
          context: z.string().optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_decide', decidePolicy, approvals, async ({ title, choice, context }) => {
        const result = await runMemphisDecide({ title, choice, context });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const healthPolicy = getToolPolicy(permissions, 'memphis_health');
  if (shouldRegister(healthPolicy)) {
    server.registerTool(
      'memphis_health',
      {
        description: 'Check Memphis runtime health (database, rust bridge, data dir, embedding provider)',
        inputSchema: {
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_health', healthPolicy, approvals, async () => {
        const result = await runMemphisHealth();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const webFetchPolicy = getToolPolicy(permissions, 'memphis_web_fetch');
  if (shouldRegister(webFetchPolicy)) {
    server.registerTool(
      'memphis_web_fetch',
      {
        description: 'Fetch a public URL and return its content (blocks internal/private addresses)',
        inputSchema: {
          url: z.string().url(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_web_fetch', webFetchPolicy, approvals, async ({ url }) => {
        const result = await runMemphisWebFetch({ url });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  const loopStepPolicy = getToolPolicy(permissions, 'memphis_loop_step');
  if (shouldRegister(loopStepPolicy)) {
    server.registerTool(
      'memphis_loop_step',
      {
        description: 'Enforce agent loop limits via Rust LoopEngine (authoritative step enforcement)',
        inputSchema: {
          state: z.object({
            steps: z.number().int().min(0),
            tool_calls: z.number().int().min(0),
            wait_ms: z.number().int().min(0),
            errors: z.number().int().min(0),
            completed: z.boolean(),
            halt_reason: z.string().nullable(),
          }),
          action: z.discriminatedUnion('type', [
            z.object({ type: z.literal('tool_call'), data: z.object({ tool: z.string() }) }),
            z.object({ type: z.literal('wait'), data: z.object({ duration_ms: z.number() }) }),
            z.object({ type: z.literal('complete'), data: z.object({ summary: z.string() }) }),
            z.object({ type: z.literal('error'), data: z.object({ recoverable: z.boolean(), message: z.string() }) }),
          ]),
          limits: z.object({
            max_steps: z.number().int().min(1),
            max_tool_calls: z.number().int().min(1),
            max_wait_ms: z.number().int().min(1),
            max_errors: z.number().int().min(1),
          }).optional(),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_loop_step', loopStepPolicy, approvals, async ({ state, action, limits }) => {
        const result = runMemphisLoopStep({ state, action, limits });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }),
    );
  }

  const execPolicy = getToolPolicy(permissions, 'memphis_exec');
  if (shouldRegister(execPolicy)) {
    server.registerTool(
      'memphis_exec',
      {
        description: 'Execute a safe, allowlisted command (echo, pwd, ls, whoami, date, uptime)',
        inputSchema: {
          command: z.string().min(1).max(256),
          approval_request_id: z.string().optional(),
        },
      },
      withApprovalGate('memphis_exec', execPolicy, approvals, async ({ command }) => {
        const result = runMemphisExec({ command });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      }),
    );
  }

  return server;
}
