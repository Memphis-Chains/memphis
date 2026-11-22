import { storeDurableMemory } from '../../infra/memory/durable-memory.js';
import { isJournalTargetChain, JOURNAL_TARGET_CHAINS } from '../../memory/chain-catalog.js';
import { scanContent } from '../../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../../security/runtime-security-events.js';

export type MemphisJournalInput = {
  content: string;
  tags?: string[];
  /**
   * Which chain to append to. Defaults to `journal`.
   *
   * Issue #645: the operator had no way to append to the soul chain —
   * the only writer was an internal memory event, so an explicit entry
   * meant hand-computing a chain hash and writing the block file by
   * hand. The chain must be in `JOURNAL_TARGET_CHAINS`; anything else
   * is refused rather than silently written elsewhere.
   */
  chain?: string;
  /**
   * Caller surface for consent resolution. Defaults to 'mcp' for legacy
   * MCP-server callers; in-process chat memory clients pass 'cli.chat',
   * HTTP chat paths pass 'http.chat', telegram passes 'telegram', etc.
   * Routed through `resolveConsent` in durable-memory.ts so that
   * MEMPHIS_SURFACE_<SURFACE>_DEFAULT_CONSENT overrides take effect per
   * caller rather than being flattened to a single 'mcp' bucket.
   */
  surface?: string;
  /**
   * Conversation / session / turn identifiers — plumbed through to
   * `storeDurableMemory` so the persisted block carries them as
   * `data.conversation_id` / `data.session_id` / `data.turn_id`.
   * Enables the trajectory exporter to group per-turn events into
   * multi-turn trajectories (N8.2). Writers that don't track these
   * state fields leave them undefined; the exporter falls back to
   * per-turn grouping when conversation/session are missing and to
   * unlinked when turnId is missing.
   */
  conversationId?: string;
  sessionId?: string;
  turnId?: string;
  truncation?: {
    field: string;
    originalLength: number;
    storedLength: number;
    limit: number;
  };
};

export type MemphisJournalOutput = {
  success: boolean;
  memoryId: string;
  index: number;
  hash: string;
  indexed: boolean;
  error?: string;
  patternId?: string;
};

export type JournalDeps = {
  store: typeof storeDurableMemory;
};

const defaultDeps: JournalDeps = { store: storeDurableMemory };

export async function runMemphisJournal(
  input: MemphisJournalInput,
  deps: JournalDeps = defaultDeps,
): Promise<MemphisJournalOutput> {
  const scan = scanContent(input.content, 'memory');
  if (!scan.allowed) {
    await emitRuntimeSecurityEvent({
      action: 'content_scan.journal.blocked',
      status: 'blocked',
      details: {
        patternId: scan.patternId,
        reason: scan.reason,
        profile: scan.profile,
        contentHash: scan.contentHash,
      },
    });
    return {
      success: false,
      memoryId: '',
      index: 0,
      hash: '',
      indexed: false,
      error: `Blocked journal content: ${scan.reason}`,
      patternId: scan.patternId,
    };
  }

  // An explicitly named chain must be one a TOOL may write to on the
  // operator's request. Without this, `memphis_journal` with a `chain`
  // argument could append to `system` or `security` — the audit-guarded
  // chains — and would write wherever it was pointed.
  //
  // The check belongs HERE, at the tool boundary, and not inside
  // `storeDurableMemory`. That function is the runtime's own durable
  // memory path: the runtime writes to `decisions` and `system` through
  // it, and a check placed there refuses the runtime's own writes. The
  // boundary is where an operator-supplied name arrives, so the boundary
  // is where the name must be validated.
  //
  // `system` and `security` are NOT in the allowlist: they are written
  // by the runtime's own audit path (`AUDIT_GUARDED_CHAINS`), which
  // refuses writes from processes that have not opted in.
  if (input.chain !== undefined) {
    const requested = input.chain.trim();
    if (!isJournalTargetChain(requested)) {
      return {
        success: false,
        memoryId: '',
        index: 0,
        hash: '',
        indexed: false,
        error:
          `refusing to write to chain "${requested}": a tool may append to ` +
          `${JOURNAL_TARGET_CHAINS.join(', ')} only`,
      };
    }
  }

  return deps.store({
    content: input.content,
    tags: input.tags,
    chain: input.chain,
    source: 'mcp',
    // Route surface through resolveConsent so MEMPHIS_SURFACE_<SURFACE>_
    // DEFAULT_CONSENT overrides apply per caller. Default 'mcp' kept for
    // MCP-server writes; in-process chat/HTTP callers override explicitly.
    surface: input.surface ?? 'mcp',
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    truncation: input.truncation,
  });
}
