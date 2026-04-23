import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    throw new Error(
      `Unknown kartograf subcommand: ${String(subcommand)}. Available: verify, install.`,
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
