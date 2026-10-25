/**
 * MiniMax-H3 video generation tool.
 *
 * H3 is not a chat-completions model.  Its API creates an asynchronous video
 * task, then exposes the finished video from a separate task-status endpoint.
 * This tool deliberately uses a video-only vault entry, separate from the
 * MiniMax chat/Token Plan credential. It never writes a key into a tool
 * payload or response.
 */

import { createHash } from 'node:crypto';

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
  /** Compatibility field containing only the same public task metadata. */
  data?: { task_id: string; status?: string; content?: { url: string } };
  error?: string;
};

type TaskMetadata = NonNullable<MemphisMiniMaxH3Output['data']>;

/** Provider payloads and exceptions are untrusted; never return them wholesale. */
function projectTaskMetadata(
  value: unknown,
  input: MemphisMiniMaxH3Input,
  apiKey: string,
): TaskMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const taskId = data.task_id ?? (input.action === 'query' ? input.task_id : undefined);
  if (typeof taskId !== 'string' || !taskId || taskId.length > 512) return undefined;
  const status = data.status;
  if (status !== undefined && (typeof status !== 'string' || status.length > 128)) return undefined;
  let url: string | undefined;
  if (data.content !== undefined) {
    if (!data.content || typeof data.content !== 'object' || Array.isArray(data.content))
      return undefined;
    const candidate = (data.content as Record<string, unknown>).url;
    if (candidate !== undefined) {
      if (typeof candidate !== 'string' || candidate.length > 8192) return undefined;
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
      } catch {
        return undefined;
      }
      url = candidate;
    }
  }
  const projected: TaskMetadata = {
    task_id: taskId,
    ...(status === undefined ? {} : { status }),
    ...(url === undefined ? {} : { content: { url } }),
  };
  // Reject a credential echo even in an otherwise allowed field. These checks
  // cover common encodings/high-confidence fragments, not arbitrary transforms.
  const variants = [
    apiKey,
    JSON.stringify(apiKey).slice(1, -1),
    encodeURIComponent(apiKey),
    Buffer.from(apiKey).toString('base64'),
    Buffer.from(apiKey).toString('hex'),
    createHash('sha256').update(apiKey).digest('hex'),
  ];
  if (apiKey.length >= 32) variants.push(apiKey.slice(0, 16), apiKey.slice(-16));
  const serialized = JSON.stringify(projected);
  if (variants.some((variant) => variant && serialized.includes(variant))) return undefined;
  return projected;
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
  const configuredTimeout = Number(rawEnv.MINIMAX_H3_REQUEST_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, 120_000)
      : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
      redirect: 'error',
    });
    if (!response.ok) {
      const status =
        Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
          ? response.status
          : 502;
      // Do not read the error body into a public message (it can echo auth).
      try {
        await response.body?.cancel();
      } catch {
        /* body cleanup is private */
      }
      return { ok: false, action: input.action, error: `MINIMAX_H3_HTTP_${status}` };
    }
    let data: TaskMetadata | undefined;
    try {
      data = projectTaskMetadata(await response.json(), input, apiKey);
    } catch {
      return { ok: false, action: input.action, error: 'MINIMAX_H3_INVALID_RESPONSE' };
    }
    if (!data) return { ok: false, action: input.action, error: 'MINIMAX_H3_INVALID_RESPONSE' };
    return {
      ok: true,
      action: input.action,
      task_id: data.task_id,
      status: data.status,
      url: data.content?.url,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      action: input.action,
      error:
        error instanceof Error && error.name === 'AbortError'
          ? 'MINIMAX_H3_TIMEOUT'
          : 'MINIMAX_H3_REQUEST_FAILED',
    };
  } finally {
    clearTimeout(timer);
  }
}
