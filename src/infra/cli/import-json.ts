import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type Primitive = string | number | boolean | null;
type UnknownRecord = Record<string, unknown>;

export type NormalizedChainBlock = {
  index: number;
  prev_hash: string;
  hash: string;
  timestamp?: string;
  chain?: string;
  data?: {
    type?: string;
    content?: string;
    tags?: string[];
  };
};

export type ImportIssue = {
  blockRef: string;
  reason:
    | 'not_an_object'
    | 'missing_hash'
    | 'invalid_hash_type'
    | 'duplicate_hash'
    | 'invalid_index'
    | 'missing_genesis_prev_hash'
    | 'prev_hash_mismatch'
    | 'invalid_prev_hash_type';
  detail?: string;
};

export type ImportJsonResult = {
  imported: number;
  valid: boolean;
  skipped: number;
  source: {
    shape: 'array' | 'object.blocks' | 'legacy.chain';
    totalCandidates: number;
  };
  reconciliation: {
    indexRewritten: number;
    prevHashRewritten: number;
    duplicatesSkipped: number;
  };
  policy: {
    duplicateHandling: 'skip-by-hash';
    idempotentKey: 'hash';
  };
  errors: string[];
  issues: ImportIssue[];
  blocks: NormalizedChainBlock[];
  invalidSkipped?: number;
  durationMs?: number;
};

export type ImportBatchOptions = {
  batchSize?: number;
  concurrency?: number;
  strict?: boolean;
  onBatchProgress?: (progress: { imported: number; total: number }) => void;
};

export type ImportWriteResult = {
  mode: 'dry-run' | 'write';
  targetPath?: string;
  backupPath?: string;
  writtenBlocks?: number;
};

const GENESIS_PREV_HASH = '0'.repeat(64);
const SAFETY_SWITCH = '--confirm-write';

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function pickString(source: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key] as Primitive | undefined;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(source: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key] as Primitive | undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function pickStringArray(source: UnknownRecord, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    const allStrings = value.every((item) => typeof item === 'string');
    if (allStrings) return value as string[];
  }
  return undefined;
}

function resolvePayloadShape(payload: unknown): {
  shape: ImportJsonResult['source']['shape'];
  blocks: unknown[];
} {
  if (Array.isArray(payload)) return { shape: 'array', blocks: payload };

  const root = asRecord(payload);
  if (!root) {
    throw new Error('import_json expects JSON array or object with blocks/chain arrays');
  }

  if (Array.isArray(root.blocks)) return { shape: 'object.blocks', blocks: root.blocks as unknown[] };

  const legacyChain = root.chain;
  if (Array.isArray(legacyChain)) return { shape: 'legacy.chain', blocks: legacyChain as unknown[] };

  throw new Error('import_json expects JSON array or object with blocks/chain arrays');
}

function normalizeCandidate(raw: unknown, indexHint: number): { block?: NormalizedChainBlock; issue?: ImportIssue } {
  const obj = asRecord(raw);
  if (!obj) {
    return { issue: { blockRef: `candidate[${indexHint}]`, reason: 'not_an_object' } };
  }

  const hash = pickString(obj, ['hash', 'block_hash']);
  if (!hash) {
    return {
      issue: {
        blockRef: `candidate[${indexHint}]`,
        reason: 'missing_hash',
        detail: 'required key: hash | block_hash',
      },
    };
  }

  const index = pickNumber(obj, ['index', 'idx', 'height']) ?? indexHint;
  const prev_hash =
    pickString(obj, ['prev_hash', 'prevHash', 'previous_hash', 'previousHash']) ?? GENESIS_PREV_HASH;

  const dataObj = asRecord(obj.data);
  const content = pickString(obj, ['content']) ?? (dataObj ? pickString(dataObj, ['content', 'text']) : undefined);
  const tags = pickStringArray(obj, ['tags']) ?? (dataObj ? pickStringArray(dataObj, ['tags']) : undefined);
  const dataType =
    pickString(obj, ['type', 'block_type']) ?? (dataObj ? pickString(dataObj, ['type', 'block_type']) : undefined);

  return {
    block: {
      index,
      hash,
      prev_hash,
      timestamp: pickString(obj, ['timestamp', 'ts', 'created_at']),
      chain: pickString(obj, ['chain', 'chain_name']),
      data: content || tags || dataType ? { type: dataType, content, tags } : undefined,
    },
  };
}

export function runImportJsonPayload(payload: unknown): ImportJsonResult {
  const { shape, blocks: candidates } = resolvePayloadShape(payload);

  const issues: ImportIssue[] = [];
  const errors: string[] = [];
  const deduped: NormalizedChainBlock[] = [];
  const seenHash = new Set<string>();

  for (let i = 0; i < candidates.length; i += 1) {
    const { block, issue } = normalizeCandidate(candidates[i], i);
    if (issue) {
      issues.push(issue);
      continue;
    }

    if (!block) continue;

    if (seenHash.has(block.hash)) {
      issues.push({ blockRef: `hash:${block.hash}`, reason: 'duplicate_hash', detail: 'duplicate dropped' });
      continue;
    }

    seenHash.add(block.hash);
    deduped.push(block);
  }

  const reconciled: NormalizedChainBlock[] = [];
  let indexRewritten = 0;
  let prevHashRewritten = 0;

  for (let i = 0; i < deduped.length; i += 1) {
    const source = deduped[i];
    const expectedIndex = i;
    const expectedPrevHash = i === 0 ? GENESIS_PREV_HASH : reconciled[i - 1].hash;

    if (!Number.isFinite(source.index)) {
      issues.push({ blockRef: `hash:${source.hash}`, reason: 'invalid_index' });
      continue;
    }

    const out: NormalizedChainBlock = { ...source };

    if (source.index !== expectedIndex) {
      out.index = expectedIndex;
      indexRewritten += 1;
    }

    if (typeof source.prev_hash !== 'string') {
      issues.push({ blockRef: `hash:${source.hash}`, reason: 'invalid_prev_hash_type' });
      out.prev_hash = expectedPrevHash;
      prevHashRewritten += 1;
    } else if (source.prev_hash !== expectedPrevHash) {
      if (i === 0 && source.prev_hash === '') {
        issues.push({ blockRef: `hash:${source.hash}`, reason: 'missing_genesis_prev_hash' });
      } else {
        issues.push({ blockRef: `hash:${source.hash}`, reason: 'prev_hash_mismatch' });
      }
      out.prev_hash = expectedPrevHash;
      prevHashRewritten += 1;
    }

    reconciled.push(out);
  }

  for (const issue of issues) {
    errors.push(`${issue.blockRef}: ${issue.reason}${issue.detail ? ` (${issue.detail})` : ''}`);
  }

  return {
    imported: reconciled.length,
    valid: issues.every((issue) => issue.reason === 'duplicate_hash'),
    skipped: candidates.length - reconciled.length,
    source: {
      shape,
      totalCandidates: candidates.length,
    },
    reconciliation: {
      indexRewritten,
      prevHashRewritten,
      duplicatesSkipped: issues.filter((i) => i.reason === 'duplicate_hash').length,
    },
    policy: {
      duplicateHandling: 'skip-by-hash',
      idempotentKey: 'hash',
    },
    errors,
    issues,
    blocks: reconciled,
  };
}

function classifyInvalidIssue(issue: ImportIssue): boolean {
  return issue.reason !== 'duplicate_hash' && issue.reason !== 'prev_hash_mismatch' && issue.reason !== 'missing_genesis_prev_hash';
}

async function processBatches<T>(items: T[], batchSize: number, concurrency: number, worker: (batch: T[], batchStart: number) => Promise<void>): Promise<void> {
  const active = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const p = worker(batch, i).finally(() => active.delete(p));
    active.add(p);

    if (active.size >= concurrency) {
      await Promise.race(active);
    }
  }

  await Promise.all([...active]);
}

export async function runImportJsonFromFileBatched(file: string, options: ImportBatchOptions = {}): Promise<ImportJsonResult> {
  const startedAt = Date.now();
  const batchSize = options.batchSize && options.batchSize > 0 ? Math.trunc(options.batchSize) : 100;
  const concurrency = options.concurrency && options.concurrency > 0 ? Math.trunc(options.concurrency) : 4;

  const payload = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const { shape, blocks: candidates } = resolvePayloadShape(payload);

  const issues: ImportIssue[] = [];
  const errors: string[] = [];
  const deduped: Array<{ order: number; block: NormalizedChainBlock }> = [];
  const seenHash = new Set<string>();

  await processBatches(candidates, batchSize, concurrency, async (batch, batchStart) => {
    const normalized = await Promise.all(
      batch.map(async (candidate, idxInBatch) => ({
        ...normalizeCandidate(candidate, batchStart + idxInBatch),
        order: batchStart + idxInBatch,
      })),
    );

    for (const item of normalized) {
      if (item.issue) {
        issues.push(item.issue);
        continue;
      }

      if (!item.block) continue;

      if (seenHash.has(item.block.hash)) {
        issues.push({ blockRef: `hash:${item.block.hash}`, reason: 'duplicate_hash', detail: 'duplicate dropped' });
        continue;
      }

      seenHash.add(item.block.hash);
      deduped.push({ order: item.order, block: item.block });
    }
  });

  deduped.sort((a, b) => a.order - b.order);

  const reconciled: NormalizedChainBlock[] = [];
  let indexRewritten = 0;
  let prevHashRewritten = 0;

  for (let i = 0; i < deduped.length; i += 1) {
    const source = deduped[i].block;
    const expectedIndex = i;
    const expectedPrevHash = i === 0 ? GENESIS_PREV_HASH : reconciled[i - 1].hash;

    if (!Number.isFinite(source.index)) {
      issues.push({ blockRef: `hash:${source.hash}`, reason: 'invalid_index' });
      continue;
    }

    const out: NormalizedChainBlock = { ...source };

    if (source.index !== expectedIndex) {
      out.index = expectedIndex;
      indexRewritten += 1;
    }

    if (typeof source.prev_hash !== 'string') {
      issues.push({ blockRef: `hash:${source.hash}`, reason: 'invalid_prev_hash_type' });
      out.prev_hash = expectedPrevHash;
      prevHashRewritten += 1;
    } else if (source.prev_hash !== expectedPrevHash) {
      if (i === 0 && source.prev_hash === '') {
        issues.push({ blockRef: `hash:${source.hash}`, reason: 'missing_genesis_prev_hash' });
      } else {
        issues.push({ blockRef: `hash:${source.hash}`, reason: 'prev_hash_mismatch' });
      }
      out.prev_hash = expectedPrevHash;
      prevHashRewritten += 1;
    }

    reconciled.push(out);
    if (reconciled.length % batchSize === 0 || reconciled.length === deduped.length) {
      options.onBatchProgress?.({ imported: reconciled.length, total: candidates.length });
    }
  }

  for (const issue of issues) {
    errors.push(`${issue.blockRef}: ${issue.reason}${issue.detail ? ` (${issue.detail})` : ''}`);
  }

  const invalidSkipped = issues.filter(classifyInvalidIssue).length;
  if (options.strict && invalidSkipped > 0) {
    throw new Error(`Strict import failed: ${invalidSkipped} invalid entr${invalidSkipped === 1 ? 'y' : 'ies'} detected`);
  }

  return {
    imported: reconciled.length,
    valid: issues.every((issue) => issue.reason === 'duplicate_hash'),
    skipped: candidates.length - reconciled.length,
    source: {
      shape,
      totalCandidates: candidates.length,
    },
    reconciliation: {
      indexRewritten,
      prevHashRewritten,
      duplicatesSkipped: issues.filter((i) => i.reason === 'duplicate_hash').length,
    },
    policy: {
      duplicateHandling: 'skip-by-hash',
      idempotentKey: 'hash',
    },
    errors,
    issues,
    blocks: reconciled,
    invalidSkipped,
    durationMs: Date.now() - startedAt,
  };
}

export function guardWriteMode(options: {
  writeEnabled: boolean;
  confirmationProvided: boolean;
  sourcePath: string;
  destinationPath: string;
}): void {
  if (!options.writeEnabled) return;
  if (!options.confirmationProvided) {
    throw new Error(`Write mode blocked: pass --write ${SAFETY_SWITCH} to enable mutation`);
  }

  const src = resolve(options.sourcePath);
  const dst = resolve(options.destinationPath);
  if (src === dst) {
    throw new Error('Write mode blocked: source and destination paths must differ');
  }
}

export function transactionalWriteBlocks(targetPath: string, blocks: NormalizedChainBlock[]): { backupPath?: string } {
  const absoluteTarget = resolve(targetPath);
  const dir = dirname(absoluteTarget);
  mkdirSync(dir, { recursive: true });

  const tempPath = `${absoluteTarget}.tmp`;
  const backupPath = `${absoluteTarget}.bak`;

  writeFileSync(tempPath, `${JSON.stringify({ blocks }, null, 2)}\n`, 'utf8');

  if (existsSync(absoluteTarget)) {
    copyFileSync(absoluteTarget, backupPath);
  }

  try {
    renameSync(tempPath, absoluteTarget);
  } catch (error) {
    rmSync(tempPath, { force: true });
    if (existsSync(backupPath) && !existsSync(absoluteTarget)) {
      copyFileSync(backupPath, absoluteTarget);
    }
    throw error;
  }

  return { backupPath: existsSync(backupPath) ? backupPath : undefined };
}

export function runImportJsonFromFile(file: string): ImportJsonResult {
  const raw = readFileSync(file, 'utf8');
  const payload = JSON.parse(raw) as unknown;
  return runImportJsonPayload(payload);
}

export function formatImportReport(result: ImportJsonResult, writeResult?: ImportWriteResult): string {
  const lines = [
    'import_json migration report',
    `- imported: ${result.imported}`,
    `- skipped: ${result.skipped}`,
    `- valid: ${result.valid}`,
    `- source: ${result.source.shape} (${result.source.totalCandidates} candidates)`,
    `- reconciliation: index=${result.reconciliation.indexRewritten}, prev_hash=${result.reconciliation.prevHashRewritten}, duplicates=${result.reconciliation.duplicatesSkipped}`,
    `- invalidSkipped: ${result.invalidSkipped ?? 0}`,
    `- durationMs: ${result.durationMs ?? 0}`,
    `- idempotency: ${result.policy.idempotentKey} (${result.policy.duplicateHandling})`,
    `- mode: ${writeResult?.mode ?? 'dry-run'}`,
  ];

  if (writeResult?.targetPath) lines.push(`- target: ${writeResult.targetPath}`);
  if (writeResult?.backupPath) lines.push(`- backup: ${writeResult.backupPath}`);

  if (result.errors.length > 0) {
    lines.push('- issues:');
    for (const issue of result.errors) {
      lines.push(`  - ${issue}`);
    }
  }

  return lines.join('\n');
}
