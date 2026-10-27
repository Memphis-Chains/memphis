import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { CommandHandler } from './command-handler.js';
import { MEMPHIS_KARTOGRAF_ENABLE } from '../../../config/env-registry.js';
import { getDataDir } from '../../../config/paths.js';
import { verifyCheckpoint, type CheckpointEnvelope } from '../../../kartograf/checkpoint.js';
import {
  activateBundle,
  inspectInstalledBundle,
  installBundle,
  selectedBundle,
} from '../../../kartograf/installed.js';
import { closeKartografRuntime, getKartografRuntime } from '../../../kartograf/runtime.js';
import type { CliContext } from '../context.js';
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
 *      `<data-dir>/kartograf/checkpoints/<canonical-envelope-hash>/`.
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
    if (subcommand === 'activate') return handleActivate(context);
    if (subcommand === 'status') return handleStatus(context);
    if (subcommand === 'query') return handleQuery(context);
    throw new Error(
      `Unknown kartograf subcommand: ${String(subcommand)}. Available: verify, install, activate, status, query.`,
    );
  },
};

type ParsedEnvelope =
  | { ok: true; envelope: CheckpointEnvelope; path: string }
  | { ok: false; error: string; path: string };

function readEnvelopeFrom(sourcePath: string): ParsedEnvelope {
  const resolved = resolve(sourcePath);
  try {
    const info = lstatSync(resolved);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
      return {
        ok: false,
        error: 'Checkpoint envelope must be a bounded regular file',
        path: resolved,
      };
    }
    const raw = readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'envelope is not a JSON object', path: resolved };
    }
    return { ok: true, envelope: parsed as CheckpointEnvelope, path: resolved };
  } catch {
    return {
      ok: false,
      error: 'Checkpoint envelope could not be read as valid JSON',
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
    process.exitCode = 2;
    print(
      { ok: false, mode: 'kartograf.verify', path: read.path, error: read.error },
      context.args.json,
    );
    return true;
  }
  const result = verifyCheckpoint(read.envelope);
  if (!result.valid) process.exitCode = 2;
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

const ALLOWED_SOURCES = new Set(['hf-hub', 'github-release', 'file', 'federation', 'agora']);

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
    process.exitCode = 2;
    print(
      { ok: false, mode: 'kartograf.install', path: read.path, error: read.error },
      context.args.json,
    );
    return true;
  }
  const verify = verifyCheckpoint(read.envelope);
  if (!verify.valid) {
    process.exitCode = 2;
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

  try {
    const bundle = await installBundle(read.path, process.env, context.args.dryRun);
    if (context.args.forceActive) {
      if (context.args.trustedSigner !== bundle.envelope.signer_did)
        throw new Error('Activation requires the expected --trusted-signer DID');
      if (!context.args.dryRun) {
        await activateBundle(bundle.id, context.args.trustedSigner, process.env);
        await closeKartografRuntime();
      }
    }
    print(
      {
        ok: true,
        mode: context.args.dryRun ? 'kartograf.install.dry-run' : 'kartograf.install',
        path: read.path,
        stageDir: dirname(bundle.envelopePath),
        envelopeOut: bundle.envelopePath,
        checkpointId: bundle.id,
        signerDid: bundle.envelope.signer_did,
        distributionSource: bundle.envelope.distribution_source,
        activated: Boolean(context.args.forceActive && !context.args.dryRun),
        restartRequired: Boolean(context.args.forceActive && !context.args.dryRun),
        artifactWarnings: [],
      },
      context.args.json,
    );
  } catch (error) {
    print(
      {
        ok: false,
        mode: 'kartograf.install',
        reason: error instanceof Error ? error.message : 'Checkpoint install failed',
      },
      context.args.json,
    );
    process.exitCode = 2;
  }
  return true;
}

async function handleActivate(context: CliContext): Promise<boolean> {
  try {
    const bundle = await activateBundle(
      context.args.target ?? '',
      context.args.trustedSigner ?? '',
      process.env,
      context.args.dryRun,
    );
    await closeKartografRuntime();
    print(
      {
        ok: true,
        mode: context.args.dryRun ? 'kartograf.activate.dry-run' : 'kartograf.activate',
        checkpointId: bundle.id,
        signerDid: bundle.envelope.signer_did,
        activated: !context.args.dryRun,
        restartRequired: !context.args.dryRun,
      },
      context.args.json,
    );
  } catch (error) {
    print(
      {
        ok: false,
        mode: 'kartograf.activate',
        reason: error instanceof Error ? error.message : 'Checkpoint activation failed',
      },
      context.args.json,
    );
    process.exitCode = 2;
  }
  return true;
}

interface InstalledCheckpoint {
  artifactsValid?: boolean;
  checkpointId?: string;
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

async function listInstalledCheckpoints(): Promise<{
  stageRoot: string;
  checkpoints: InstalledCheckpoint[];
}> {
  const stageRoot = join(getDataDir(process.env), 'kartograf', 'checkpoints');
  if (!existsSync(stageRoot) || lstatSync(stageRoot).isSymbolicLink())
    return { stageRoot, checkpoints: [] };

  const slugs = readdirSync(stageRoot).filter((entry) => {
    try {
      if (!/^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(entry)) return false;
      return lstatSync(join(stageRoot, entry)).isDirectory();
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
    let artifactsValid = false;
    let checkpointId: string | undefined;
    try {
      const bundle = await inspectInstalledBundle(envelopePath);
      artifactsValid = true;
      checkpointId = bundle.id;
    } catch {
      /* report integrity failure without loading a model */
    }
    checkpoints.push({
      artifactsValid,
      checkpointId,
      signerSlug: verify.valid ? verify.signerDid.slice(-12) : slug,
      envelopePath,
      ok: verify.valid && artifactsValid,
      signerDid: verify.valid ? verify.signerDid : null,
      distributionSource: read.envelope.distribution_source ?? null,
      version: read.envelope.version ?? null,
      hasOnnx: existsSync(join(stageRoot, slug, 'model.onnx')),
      hasTokenizer: existsSync(join(stageRoot, slug, 'tokenizer.json')),
      reason: !verify.valid
        ? verify.reason
        : artifactsValid
          ? undefined
          : 'Checkpoint artifacts are missing or failed integrity validation',
    });
  }
  return { stageRoot, checkpoints };
}

async function handleStatus(context: CliContext): Promise<boolean> {
  const { stageRoot, checkpoints } = await listInstalledCheckpoints();
  let selected = null;
  let selectionError: string | null = null;
  try {
    selected = await selectedBundle(process.env);
  } catch {
    selectionError = 'Active checkpoint selection failed integrity validation';
  }
  if (selectionError) process.exitCode = 2;
  const runtime = await getKartografRuntime(process.env);
  print(
    {
      ok: selectionError === null,
      mode: 'kartograf.status',
      stageRoot,
      installed: checkpoints.length,
      checkpoints,
      selected_checkpoint: selected?.id ?? null,
      active_checkpoint:
        runtime.kind === 'ready' && selected?.envelopePath === runtime.envelopePath
          ? selected.id
          : null,
      runtime: runtime.kind,
      selectionError,
    },
    context.args.json,
  );
  return true;
}

async function handleQuery(context: CliContext): Promise<boolean> {
  const query = (context.args.query ?? context.args.target ?? '').toString().trim();
  if (!query) {
    print(
      {
        ok: false,
        mode: 'kartograf.query',
        error: 'kartograf query requires --query <text>',
      },
      context.args.json,
    );
    process.exitCode = 2;
    return true;
  }

  const usable = await selectedBundle(process.env);
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
    process.exitCode = 2;
    return true;
  }

  if (MEMPHIS_KARTOGRAF_ENABLE.read(process.env) !== '1') {
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
    process.exitCode = 2;
    return true;
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
    process.exitCode = 2;
    print(
      {
        ok: false,
        mode: 'kartograf.query',
        error: `installed envelope unreadable: ${read.error}`,
      },
      context.args.json,
    );
    process.exitCode = 2;
    return true;
  }
  const session = await createKartografSession({
    checkpointPath: usable.envelopePath,
    headsConfig: read.envelope.heads_config,
    ...(Number.isFinite(topK) ? { topKZones: topK as number } : {}),
  });

  // Codex review (#573, 2026-05-12): createKartografSession falls back
  // to StubKartografSession when the ONNX/tokenizer load throws (ABI
  // mismatch, missing artifact, opset gap). Without this check the CLI
  // would happily print ok:true with a zero-vector embedding and a
  // single "none" zone — looking successful while silently returning
  // garbage. Detect the stub by its sentinel checkpointId prefix and
  // surface the load failure with the same hint shape as the disabled
  // / no-checkpoint paths.
  if (session.checkpointId.startsWith('stub:')) {
    await session.close();
    print(
      {
        ok: false,
        mode: 'kartograf.query',
        error: 'ONNX session load failed; runtime fell back to stub',
        hint:
          'Check daemon stderr / kartograf-handler stderr for the underlying ONNX load error. ' +
          'Most common: onnxruntime-node ABI mismatch with @huggingface/transformers nested ' +
          'copy, or model.onnx sha mismatch vs envelope.',
      },
      context.args.json,
    );
    process.exitCode = 2;
    return true;
  }

  try {
    const t0 = Date.now();
    const result = await session.embed(query);
    const elapsedMs = Date.now() - t0;
    print(
      {
        ok: true,
        mode: 'kartograf.query',
        checkpointId: result.checkpointId,
        selectedCheckpointId: usable.id,
        signerDid: usable.envelope.signer_did,
        query,
        // Don't dump the full 256-d vector by default — surface the
        // norm + first 8 dims so operators can sanity-check without
        // flooding the terminal. Full vector available via --json
        // consumers can re-derive from .embeddingPreview if they need
        // the demonstration, or call the tool surface in a script.
        ...(context.args.json
          ? {
              embedding: Array.from(result.embedding),
              topZone: result.zones[0]?.zone,
              confidence: result.zones[0]?.score,
            }
          : {}),
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
