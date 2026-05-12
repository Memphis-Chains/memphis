import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { getDataDir } from '../../../config/paths.js';
import {
  sha256Hex,
  verifyCheckpoint,
  type CheckpointEnvelope,
} from '../../../kartograf/checkpoint.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

/**
 * `memphis kartograf verify <path>` / `memphis kartograf install <path> --source <tier>`
 *
 * Thin CLI wrappers over `src/kartograf/checkpoint.ts` so operators can
 * test the signed-distribution loop before real Kartograf checkpoints
 * exist. Load paths in Q2 will import from these same primitives.
 *
 * Install semantics (Q1 local-path only):
 *   1. Read envelope JSON from source path.
 *   2. Verify signature via `verifyCheckpoint`.
 *   3. If tier is `file` or `federation`, copy envelope + sibling
 *      artifacts (*.onnx, *.tokenizer.json) into
 *      `<data-dir>/kartograf/checkpoints/<signer-did-short>/`.
 *   4. Refuse install on verify failure.
 *
 * URL sources (`--source hf-hub` / `github-release`) are out of scope
 * for this PR — the verify primitive + CLI surface ship now, network
 * pull lands with the actual Kartograf checkpoint producer in Q2.
 */
export const kartografCommandHandler: CommandHandler = {
  name: 'kartograf',
  commands: ['kartograf'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'kartograf';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    if (subcommand === 'verify') return handleVerify(context);
    if (subcommand === 'install') return handleInstall(context);
    if (subcommand === 'status') return handleStatus(context);
    if (subcommand === 'query') return handleQuery(context);
    throw new Error(
      `Unknown kartograf subcommand: ${String(subcommand)}. Available: verify, install, status, query.`,
    );
  },
};

type ParsedEnvelope =
  | { ok: true; envelope: CheckpointEnvelope; path: string }
  | { ok: false; error: string; path: string };

function readEnvelopeFrom(sourcePath: string): ParsedEnvelope {
  const resolved = resolve(sourcePath);
  try {
    const raw = readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'envelope is not a JSON object', path: resolved };
    }
    return { ok: true, envelope: parsed as CheckpointEnvelope, path: resolved };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      path: resolved,
    };
  }
}

async function handleVerify(context: CliContext): Promise<boolean> {
  const sourcePath = (context.args.file ?? context.args.target ?? '').trim();
  if (!sourcePath) {
    throw new Error('kartograf verify requires --file <path> (or positional <path>)');
  }
  const read = readEnvelopeFrom(sourcePath);
  if (!read.ok) {
    print(
      { ok: false, mode: 'kartograf.verify', path: read.path, error: read.error },
      context.args.json,
    );
    return true;
  }
  const result = verifyCheckpoint(read.envelope);
  print(
    {
      ok: result.valid,
      mode: 'kartograf.verify',
      path: read.path,
      version: read.envelope.version,
      distributionSource: read.envelope.distribution_source,
      onnxSha256: read.envelope.onnx_sha256,
      tokenizerSha256: read.envelope.tokenizer_sha256,
      signerDid: result.valid ? result.signerDid : null,
      reason: result.valid ? null : result.reason,
    },
    context.args.json,
  );
  return true;
}

const ALLOWED_SOURCES = new Set([
  'hf-hub',
  'github-release',
  'file',
  'federation',
  'agora',
]);

function shortSignerSlug(signerDid: string): string {
  // did:key:ed25519:<64-hex> → last 12 hex chars, safe for filenames.
  const hex = signerDid.replace('did:key:ed25519:', '');
  return hex.length >= 12 ? hex.slice(0, 12) : 'unknown';
}

async function handleInstall(context: CliContext): Promise<boolean> {
  const sourcePath = (context.args.file ?? context.args.target ?? '').trim();
  if (!sourcePath) {
    throw new Error('kartograf install requires --file <path> (or positional <path>)');
  }
  const source = (context.args.source ?? 'file').trim();
  if (!ALLOWED_SOURCES.has(source)) {
    throw new Error(
      `--source must be one of ${[...ALLOWED_SOURCES].join('|')}; got ${JSON.stringify(source)}`,
    );
  }
  if (source === 'hf-hub' || source === 'github-release' || source === 'agora') {
    // Network / federated transports are Y2+ scope per
    // docs/dev/KARTOGRAF-SPEC.md. The verify primitive ships now so
    // operators can exercise `file` / `federation` today; agora
    // specifically is gated to an explicit "not implemented" error
    // rather than silently falling back to local-file staging.
    throw new Error(
      `--source ${source} transport not yet implemented (Y2+ per KARTOGRAF-SPEC). ` +
        `For local testing pass --source file with a local envelope path.`,
    );
  }

  const read = readEnvelopeFrom(sourcePath);
  if (!read.ok) {
    print(
      { ok: false, mode: 'kartograf.install', path: read.path, error: read.error },
      context.args.json,
    );
    return true;
  }
  const verify = verifyCheckpoint(read.envelope);
  if (!verify.valid) {
    // Verification failure MUST block install so a tampered envelope
    // can't land on disk where the model loader would later trust it.
    print(
      {
        ok: false,
        mode: 'kartograf.install',
        path: read.path,
        reason: verify.reason,
      },
      context.args.json,
    );
    return true;
  }

  const slug = shortSignerSlug(verify.signerDid);
  const stageDir = join(
    getDataDir(process.env),
    'kartograf',
    'checkpoints',
    slug,
  );
  const envelopeOut = join(stageDir, 'checkpoint.json');
  const sourceDir = dirname(read.path);

  if (context.args.dryRun) {
    // Dry-run must be side-effect free. `mkdirSync` BEFORE this branch
    // was creating the staging directory on a preview command, which
    // contradicts the `--dry-run` contract. Print what WOULD happen
    // without touching the filesystem.
    print(
      {
        ok: true,
        mode: 'kartograf.install.dry-run',
        path: read.path,
        stageDir,
        envelopeOut,
        signerDid: verify.signerDid,
        distributionSource: read.envelope.distribution_source,
      },
      context.args.json,
    );
    return true;
  }

  // Guard against the "re-install in place" case: `memphis kartograf
  // install --file <stageDir>/checkpoint.json --source file` would
  // (before this guard) wipe `model.onnx` / `tokenizer.json` in the
  // stage dir BEFORE reading them as the source, silently destroying
  // the operator's good bundle. If source and stage are the same
  // directory, skip the cleanup — the artifacts already on disk ARE
  // the ones we want to re-stamp against the envelope.
  const stageDirReal = resolve(stageDir);
  const sourceDirReal = resolve(sourceDir);
  const inPlaceRestage = stageDirReal === sourceDirReal;

  mkdirSync(stageDir, { recursive: true });

  if (!inPlaceRestage) {
    // Before writing the new envelope, clear any prior staged artifacts
    // from the same stageDir (same signer may publish multiple
    // checkpoints over time). A checksum-mismatch install in the
    // previous run must NOT leave stale `model.onnx` / `tokenizer.json`
    // beside an updated `checkpoint.json` — that's a "mixed state"
    // hazard where the loader would hash-verify stale bytes against
    // new envelope values.
    for (const stale of ['model.onnx', 'tokenizer.json']) {
      rmSync(join(stageDir, stale), { force: true });
    }
  }
  // Copy envelope into the staging dir under its canonical name.
  writeFileSync(envelopeOut, JSON.stringify(read.envelope, null, 2));

  // Copy sibling artifacts if present — producer side stamps them
  // with the sha256s the envelope asserts. We re-verify the sha256s
  // here so a misassembled bundle can't sneak past.
  const artifactWarnings: string[] = [];
  for (const [field, fileName] of [
    ['onnx_sha256', 'model.onnx'],
    ['tokenizer_sha256', 'tokenizer.json'],
  ] as const) {
    const candidate = join(sourceDir, fileName);
    const expected = read.envelope[field];
    try {
      const bytes = readFileSync(candidate);
      const actual = sha256Hex(bytes);
      if (actual !== expected) {
        artifactWarnings.push(
          `${fileName}: sha256 mismatch (expected ${expected.slice(0, 12)}..., ` +
            `got ${actual.slice(0, 12)}...) — artifact not copied`,
        );
        continue;
      }
      copyFileSync(candidate, join(stageDir, fileName));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        artifactWarnings.push(`${fileName}: not found beside envelope — skipped`);
      } else {
        artifactWarnings.push(
          `${fileName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  print(
    {
      ok: true,
      mode: 'kartograf.install',
      path: read.path,
      stageDir,
      envelopeOut,
      signerDid: verify.signerDid,
      distributionSource: read.envelope.distribution_source,
      artifactWarnings,
    },
    context.args.json,
  );
  return true;
}

interface InstalledCheckpoint {
  signerSlug: string;
  envelopePath: string;
  ok: boolean;
  signerDid: string | null;
  distributionSource: string | null;
  version: string | null;
  hasOnnx: boolean;
  hasTokenizer: boolean;
  reason?: string;
}

function listInstalledCheckpoints(): { stageRoot: string; checkpoints: InstalledCheckpoint[] } {
  const stageRoot = join(getDataDir(process.env), 'kartograf', 'checkpoints');
  if (!existsSync(stageRoot)) return { stageRoot, checkpoints: [] };

  const slugs = readdirSync(stageRoot).filter((entry) => {
    try {
      return statSync(join(stageRoot, entry)).isDirectory();
    } catch {
      return false;
    }
  });

  const checkpoints: InstalledCheckpoint[] = [];
  for (const slug of slugs) {
    const envelopePath = join(stageRoot, slug, 'checkpoint.json');
    if (!existsSync(envelopePath)) continue;
    const read = readEnvelopeFrom(envelopePath);
    if (!read.ok) {
      checkpoints.push({
        signerSlug: slug,
        envelopePath,
        ok: false,
        signerDid: null,
        distributionSource: null,
        version: null,
        hasOnnx: false,
        hasTokenizer: false,
        reason: read.error,
      });
      continue;
    }
    const verify = verifyCheckpoint(read.envelope);
    checkpoints.push({
      signerSlug: slug,
      envelopePath,
      ok: verify.valid,
      signerDid: verify.valid ? verify.signerDid : null,
      distributionSource: read.envelope.distribution_source ?? null,
      version: read.envelope.version ?? null,
      hasOnnx: existsSync(join(stageRoot, slug, 'model.onnx')),
      hasTokenizer: existsSync(join(stageRoot, slug, 'tokenizer.json')),
      reason: verify.valid ? undefined : verify.reason,
    });
  }
  return { stageRoot, checkpoints };
}

async function handleStatus(context: CliContext): Promise<boolean> {
  const { stageRoot, checkpoints } = listInstalledCheckpoints();
  print(
    {
      ok: true,
      mode: 'kartograf.status',
      stageRoot,
      installed: checkpoints.length,
      checkpoints,
    },
    context.args.json,
  );
  return true;
}

async function handleQuery(context: CliContext): Promise<boolean> {
  const query = (context.args.query ?? '').toString().trim();
  if (!query) {
    print(
      {
        ok: false,
        mode: 'kartograf.query',
        error: 'kartograf query requires --query <text>',
      },
      context.args.json,
    );
    return false;
  }

  const { checkpoints } = listInstalledCheckpoints();
  const usable = checkpoints.find((c) => c.ok);
  if (!usable) {
    print(
      {
        ok: false,
        mode: 'kartograf.query',
        error: 'no verified checkpoint installed',
        hint: 'Run `memphis kartograf install --file <envelope>.json --source file` first.',
      },
      context.args.json,
    );
    return false;
  }

  if (process.env.MEMPHIS_KARTOGRAF_ENABLE !== '1') {
    print(
      {
        ok: false,
        mode: 'kartograf.query',
        error: 'MEMPHIS_KARTOGRAF_ENABLE=1 not set',
        hint:
          'Set MEMPHIS_KARTOGRAF_ENABLE=1 in your .env (or shell) to activate the ' +
          'ONNX runtime. The flag is opt-in so the 80-MB onnxruntime-node binary ' +
          'is only loaded on installs that intend to use Kartograf.',
      },
      context.args.json,
    );
    return false;
  }

  // Top-K parse — accept --top-k <N>, default to all zones.
  const topKRaw = context.args.topK;
  const topK =
    typeof topKRaw === 'number'
      ? topKRaw
      : typeof topKRaw === 'string'
        ? Number.parseInt(topKRaw, 10)
        : undefined;

  const { createKartografSession } = await import('../../../kartograf/session.js');
  const read = readEnvelopeFrom(usable.envelopePath);
  if (!read.ok) {
    print(
      {
        ok: false,
        mode: 'kartograf.query',
        error: `installed envelope unreadable: ${read.error}`,
      },
      context.args.json,
    );
    return false;
  }
  const session = await createKartografSession({
    checkpointPath: usable.envelopePath,
    headsConfig: read.envelope.heads_config,
    ...(Number.isFinite(topK) ? { topKZones: topK as number } : {}),
  });

  try {
    const t0 = Date.now();
    const result = await session.embed(query);
    const elapsedMs = Date.now() - t0;
    print(
      {
        ok: true,
        mode: 'kartograf.query',
        checkpointId: result.checkpointId,
        signerDid: usable.signerDid,
        query,
        // Don't dump the full 256-d vector by default — surface the
        // norm + first 8 dims so operators can sanity-check without
        // flooding the terminal. Full vector available via --json
        // consumers can re-derive from .embeddingPreview if they need
        // the demonstration, or call the tool surface in a script.
        embeddingDim: result.embedding.length,
        embeddingPreview: Array.from(result.embedding.slice(0, 8)),
        zones: result.zones,
        elapsedMs,
      },
      context.args.json,
    );
    return true;
  } finally {
    await session.close();
  }
}
