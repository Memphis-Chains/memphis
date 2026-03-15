import { randomUUID } from 'node:crypto';

import { writeSecurityAudit } from '../logging/security-audit.js';
import { appendBlock } from '../storage/chain-adapter.js';
import type {
  DualApprovalAction,
  DualApprovalState,
} from '../storage/sqlite/repositories/dual-approval-repository.js';

export interface DualApprovalChainEventInput {
  requestId: string;
  correlationTaskId: string;
  action: DualApprovalAction;
  fromState: DualApprovalState | null;
  toState: DualApprovalState;
  actorId: string;
  stateVersion: number;
  signatureVerified: boolean;
}

export async function writeDualApprovalChainEvent(
  input: DualApprovalChainEventInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const now = new Date().toISOString();
  const eventId = randomUUID();

  try {
    await appendBlock(
      'system',
      {
        type: 'system_event',
        event: 'dual_approval.transition',
        schemaVersion: 1,
        eventId,
        timestamp: now,
        correlation: {
          taskId: input.correlationTaskId,
          runId: input.requestId,
          agentId: input.actorId,
          toolCallId: null,
        },
        payload: {
          action: input.action,
          fromState: input.fromState,
          toState: input.toState,
          actorId: input.actorId,
          stateVersion: input.stateVersion,
          signatureVerified: input.signatureVerified,
        },
      },
      rawEnv,
    );
  } catch (error) {
    writeSecurityAudit(
      {
        action: 'dual_approval.chain_event',
        status: 'error',
        details: {
          requestId: input.requestId,
          eventId,
          message: error instanceof Error ? error.message : String(error),
        },
      },
      rawEnv,
    );
  }
}
