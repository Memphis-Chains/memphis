/**
 * MiniMax-H3 video generation tool.
 *
 * H3 is not a chat-completions model.  Its API creates an asynchronous video
 * task, then exposes the finished video from a separate task-status endpoint.
 * This tool deliberately uses a video-only vault entry, separate from the
 * MiniMax chat/Token Plan credential. It never writes a key into a tool
 * payload or response.
 */

import { readVaultSecretByKey } from '../../security/vault-boundary.js';

const API_BASE = 'https://api.minimax.io';
const MODEL = 'MiniMax-H3';
const DEFAULT_TIMEOUT_MS = 30_000;

export type MemphisMiniMaxH3Input =
  | {
      action: 'create';
      prompt: string;
      duration?: number;
      resolution?: '768P' | '2K';
      ratio?: string;
    }
  | { action: 'query'; task_id: string };

export type MemphisMiniMaxH3Output = {
  ok: boolean;
  action: 'create' | 'query';
  task_id?: string;
  status?: string;
  url?: string;
  data?: Record<string, unknown>;
  error?: string;
};

function errorText(status: number, body: string): string {
  return `MiniMax-H3 API error: HTTP ${status}${body ? ` ${body.slice(0, 500)}` : ''}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function outputUrl(data: Record<string, unknown>): string | undefined {
  const content = asRecord(data.content);
  return typeof content.url === 'string' ? content.url : undefined;
}

function resolveVideoApiKey(rawEnv: NodeJS.ProcessEnv): string | undefined {
  const vaultKey = rawEnv.MINIMAX_VIDEO_VAULT_KEY?.trim();
  if (!vaultKey) return undefined;
  try {
    const result = readVaultSecretByKey(
      vaultKey,
      { surface: 'system', command: 'resolve-minimax-video-vault-key' },
      rawEnv,
    );
    return result.found && result.plaintext ? result.plaintext : undefined;
  } catch {
    return undefined;
  }
}

/** Submit an H3 task or check a previous task.  Video generation charges the
 * MiniMax account, so the surrounding tier-2 approval policy always applies. */
export async function runMemphisMiniMaxH3(
  input: MemphisMiniMaxH3Input,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MemphisMiniMaxH3Output> {
  const apiKey = resolveVideoApiKey(rawEnv);
  if (!apiKey) {
    return {
      ok: false,
      action: input.action,
      error:
        'MiniMax video key is unavailable. Store the pay-as-you-go key as `minimax_video_api_key` in the vault; H3 never falls back to the chat/Token Plan key.',
    };
  }

  const controller = new AbortController();
  const timeoutMs = Number(rawEnv.MINIMAX_H3_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);

  try {
    const request =
      input.action === 'create'
        ? {
            url: `${API_BASE}/v2/video_generation`,
            init: {
              method: 'POST',
              body: JSON.stringify({
                model: MODEL,
                content: [{ type: 'text', text: input.prompt }],
                resolution: input.resolution ?? '2K',
                duration: input.duration ?? 5,
                ...(input.ratio ? { ratio: input.ratio } : {}),
              }),
            },
          }
        : {
            url: `${API_BASE}/v2/query/video_generation/${encodeURIComponent(input.task_id)}`,
            init: { method: 'GET' },
          };
    const response = await fetch(request.url, {
      ...request.init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) return { ok: false, action: input.action, error: errorText(response.status, body) };

    let data: Record<string, unknown>;
    try {
      data = asRecord(JSON.parse(body));
    } catch {
      return { ok: false, action: input.action, error: 'MiniMax-H3 returned invalid JSON.' };
    }
    const taskId = typeof data.task_id === 'string' ? data.task_id : input.action === 'query' ? input.task_id : undefined;
    return {
      ok: true,
      action: input.action,
      task_id: taskId,
      status: typeof data.status === 'string' ? data.status : undefined,
      url: outputUrl(data),
      data,
    };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? `MiniMax-H3 request timed out after ${timeoutMs}ms.`
      : `MiniMax-H3 request failed: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, action: input.action, error: message };
  } finally {
    clearTimeout(timer);
  }
}
