/**
 * `memphis export --format=mv2` (Sprint G — N12 Q1 exit gate).
 *
 * Reads selected runtime tracks (journal / chains / embeddings) and
 * writes a single `.mv2` v0 container. Vault entries are denylisted at
 * the Rust writer; we never even read them on the TS side. The Rust
 * crate `memphis-export` defines the on-disk layout — see
 * `docs/dev/MV2-INTEGRATION.md` for the upgrade path to memvid-core
 * 2.0.x.
 *
 * Usage:
 *   memphis export --format=mv2 --output PATH [--include CSV] [--json]
 *
 * Flags:
 *   --format=mv2    Required to dispatch to this branch.
 *   --output PATH   Required. Path to write the `.mv2` file.
 *   --include CSV   Optional. Comma-separated tracks: journal,chains,
 *                   embeddings. Default: journal,chains.
 *   --json          Print structured summary instead of human-readable.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { resolveRustBridgePath } from '../../runtime/install-root.js';
import {
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
} from '../../storage/napi-contract.js';
import { getRecentBlocks } from '../../storage/rust-chain-adapter.js';
import type { CliContext } from '../context.js';

type TrackName = 'journal' | 'chains' | 'embeddings';

interface Mv2Record {
  track: TrackName;
  id: string;
  payload: unknown;
}

const DEFAULT_TRACKS: readonly TrackName[] = ['journal', 'chains'] as const;
const KNOWN_TRACKS = new Set<TrackName>(['journal', 'chains', 'embeddings']);

/**
 * Maximum blocks pulled per chain when exporting. Operator demos run on
 * journals well under this cap; if it ever bites, raise here rather
 * than introducing a streaming export — that's the memvid-core swap
 * window per `docs/dev/MV2-INTEGRATION.md`.
 */
const EXPORT_LIMIT = 100_000;

const MV2_BRIDGE_ALIASES = {
  mv2_export: ['mv2_export', 'mv2Export'],
  mv2_inspect: ['mv2_inspect', 'mv2Inspect'],
} as const satisfies BridgeAliasMap<'mv2_export' | 'mv2_inspect'>;

interface Mv2ExportOut {
  frame_count: number;
  bytes_hex: string;
}

interface NapiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function parseIncludeFlag(raw: string | undefined): TrackName[] {
  if (!raw || raw.trim().length === 0) return [...DEFAULT_TRACKS];
  const requested = raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  // Codex R4 #434: dedupe. `--include journal,journal` previously
  // serialized the journal chain twice, doubling frame counts and
  // file size. Sets preserve insertion order in JS, so operator-
  // specified ordering is retained.
  const seen = new Set<TrackName>();
  for (const token of requested) {
    if (KNOWN_TRACKS.has(token as TrackName)) {
      seen.add(token as TrackName);
    } else {
      // `vault` lands here — it's accepted by the writer surface but
      // explicitly denied at the Rust layer. Surface a loud error
      // before we ever load chain blocks.
      throw new Error(
        `Unknown --include track: "${token}". Allowed: journal, chains, embeddings.`,
      );
    }
  }
  const valid = [...seen];
  return valid.length > 0 ? valid : [...DEFAULT_TRACKS];
}

/**
 * Names of all non-journal chains the `chains` track aggregates.
 * Codex R4 #434 caught that the prior implementation hard-coded
 * `cases` and silently dropped decisions/reflections/patterns/system/
 * collective. Source-of-truth: `src/memory/chain-catalog.ts`. We
 * exclude `journal` because it has its own track; everything else
 * folds into `chains` so `--include chains` actually means "every
 * non-journal persisted chain" (no data-loss surprise).
 */
const NON_JOURNAL_CHAIN_NAMES = [
  'decisions',
  'reflections',
  'cases',
  'patterns',
  'system',
  'collective',
] as const;

async function collectRecords(
  tracks: readonly TrackName[],
  rawEnv: NodeJS.ProcessEnv,
): Promise<Mv2Record[]> {
  const records: Mv2Record[] = [];
  for (const track of tracks) {
    if (track === 'journal') {
      const blocks = await getRecentBlocks('journal', EXPORT_LIMIT, rawEnv);
      for (const block of blocks) {
        records.push({
          track,
          id: block.hash ?? `journal:${block.index}`,
          payload: {
            index: block.index,
            prev_hash: block.prev_hash,
            timestamp: block.timestamp,
            data: block.data,
          },
        });
      }
    } else if (track === 'chains') {
      // R4 fix: aggregate every non-journal chain. Use a chain-name
      // prefix on the id so blocks from different chains don't
      // collide on import/dedup. Chains that don't exist on disk
      // (e.g. operator hasn't used `collective` yet) just return
      // empty arrays — that's fine.
      for (const chainName of NON_JOURNAL_CHAIN_NAMES) {
        const blocks = await getRecentBlocks(chainName, EXPORT_LIMIT, rawEnv);
        for (const block of blocks) {
          records.push({
            track,
            id: `${chainName}:${block.hash ?? block.index}`,
            payload: {
              chain: chainName,
              index: block.index,
              prev_hash: block.prev_hash,
              timestamp: block.timestamp,
              data: block.data,
            },
          });
        }
      }
    }
    // `embeddings` track is reserved for memvid-core integration —
    // the in-house v0 writer accepts the surface but the operator
    // export pipeline doesn't snapshot vectors yet. Document this
    // explicitly rather than silently producing an empty track.
  }
  return records;
}

function loadMv2Bridge(): NonNullable<
  ReturnType<typeof resolveBridgeContract<'mv2_export' | 'mv2_inspect'>>
> {
  const inTreePath = resolveRustBridgePath();
  const bridge = loadPlatformAwareBridge(inTreePath);
  return resolveBridgeContract(bridge, MV2_BRIDGE_ALIASES);
}

function decodeNapiResult<T>(raw: string): T {
  const parsed = JSON.parse(raw) as NapiResult<T>;
  if (!parsed.ok || parsed.data === undefined) {
    throw new Error(parsed.error ?? 'NAPI mv2 call returned !ok with no error message');
  }
  return parsed.data;
}

function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.trim();
  if (trimmed.length % 2 !== 0) {
    throw new Error('NAPI returned odd-length hex string');
  }
  const out = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(trimmed.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function handleExportMv2Command(context: CliContext): Promise<boolean> {
  if (
    context.args.command !== 'export' ||
    context.args.format !== 'mv2'
  ) {
    return false;
  }

  // Once `command=export` and `format=mv2` matched above, we own this
  // invocation. Errors past this point return `true` (handled) + set
  // `process.exitCode` so the dispatcher doesn't fall through to a
  // misleading "Unknown command: export". Codex R2 #434 caught the
  // double-error UX. Mirrors the voice.handler.ts fix for #433.
  const outRaw = context.args.out;
  if (!outRaw || outRaw.trim().length === 0) {
    process.stderr.write('memphis export --format=mv2 requires --output PATH\n');
    process.exitCode = 2;
    return true;
  }
  const outputPath = resolve(outRaw);

  let tracks: TrackName[];
  try {
    tracks = parseIncludeFlag(context.args.include);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 2;
    return true;
  }

  const bridge = loadMv2Bridge();
  if (!bridge.bridgeLoaded || bridge.missing.length > 0) {
    process.stderr.write(
      `mv2 bridge unavailable (missing: ${bridge.missing.join(', ') || 'bridge'}). ` +
        `Rebuild via \`npm run build:rust:release\` or install the platform sub-package.\n`,
    );
    process.exitCode = 2;
    return true;
  }

  const records = await collectRecords(tracks, process.env);
  const includeJson = JSON.stringify(tracks);
  const recordsJson = JSON.stringify(records);

  const exportFn = bridge.resolved.mv2_export as (
    recordsJson: string,
    includeJson: string,
  ) => string;
  const result = decodeNapiResult<Mv2ExportOut>(exportFn(recordsJson, includeJson));
  const bytes = hexToBytes(result.bytes_hex);
  await writeFile(outputPath, bytes);

  if (context.args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          format: 'mv2',
          output: outputPath,
          frameCount: result.frame_count,
          bytes: bytes.byteLength,
          tracks,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `Wrote ${bytes.byteLength} bytes (${result.frame_count} frames, tracks=${tracks.join(',')}) to ${outputPath}\n`,
    );
  }
  return true;
}
