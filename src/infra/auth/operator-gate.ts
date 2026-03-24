/**
 * Operator passphrase gate — sudo-like auth for dangerous CLI/TUI operations.
 *
 * Set during `memphis init`, stored as SHA256(salt+passphrase) in operator.json.
 * Session-cached for 15 minutes (like sudo). Gates destructive operations only.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as readline from 'node:readline/promises';

import { getDataDir } from '../../config/paths.js';
import { secureCompare } from '../../security/constant-time.js';
import type { CliArgs } from '../cli/types.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface OperatorConfig {
  schemaVersion: number;
  passphraseHash: string;
  salt: string;
  createdAt: string;
  updatedAt: string;
  recoveryQuestionHint: string;
  recoveryHash: string;
}

// ─── Gated operations registry ───────────────────────────────────────

interface GateRule {
  command: string;
  subcommand?: string | string[];
  condition?: (args: CliArgs) => boolean;
}

const GATED_OPERATIONS: GateRule[] = [
  { command: 'vault', subcommand: 'init' },
  { command: 'trust', subcommand: ['add', 'remove'] },
  { command: 'trust', subcommand: 'mode', condition: (a) => a.target === 'set' },
  { command: 'evolve', subcommand: 'rollback' },
  { command: 'backup', condition: (a) => !!a.restore || a.clean },
  { command: 'reset', condition: (a) => a.runtime || a.yes },
  { command: 'configure' },
];

// ─── Session cache ───────────────────────────────────────────────────

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const attemptLog = new Map<string, { count: number; firstAttemptAt: number }>();

let sessionAuthorizedAt: number | null = null;

export function isSessionAuthorized(): boolean {
  if (sessionAuthorizedAt === null) return false;
  if (Date.now() - sessionAuthorizedAt > SESSION_TTL_MS) {
    sessionAuthorizedAt = null;
    return false;
  }
  return true;
}

export function authorizeSession(): void {
  sessionAuthorizedAt = Date.now();
}

export function clearSessionAuth(): void {
  sessionAuthorizedAt = null;
}

// ─── Config persistence ──────────────────────────────────────────────

function getOperatorConfigPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(rawEnv), 'config', 'operator.json');
}

export function loadOperatorConfig(rawEnv: NodeJS.ProcessEnv = process.env): OperatorConfig | null {
  const configPath = getOperatorConfigPath(rawEnv);
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as OperatorConfig;
    if (!parsed.passphraseHash || !parsed.salt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveOperatorConfig(
  config: OperatorConfig,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const configPath = getOperatorConfigPath(rawEnv);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

export function isOperatorConfigured(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return loadOperatorConfig(rawEnv) !== null;
}

// ─── Hashing ─────────────────────────────────────────────────────────

export function generateSalt(): string {
  return randomBytes(16).toString('hex');
}

export function hashWithSalt(value: string, salt: string): string {
  return pbkdf2Sync(value, salt, 600_000, 32, 'sha256').toString('hex');
}

// ─── Validation ──────────────────────────────────────────────────────

export function validateOperatorPassphrase(
  passphrase: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const config = loadOperatorConfig(rawEnv);
  if (!config) return false;

  const now = Date.now();
  const record = attemptLog.get(config.salt) ?? { count: 0, firstAttemptAt: now };
  if (now - record.firstAttemptAt > ATTEMPT_WINDOW_MS) {
    record.count = 0;
    record.firstAttemptAt = now;
  }
  if (record.count >= MAX_ATTEMPTS) {
    throw new Error(`Rate limited. Try again in ${Math.ceil((ATTEMPT_WINDOW_MS - (now - record.firstAttemptAt)) / 1000)}s`);
  }

  const inputHash = hashWithSalt(passphrase, config.salt);
  const valid = secureCompare(inputHash, config.passphraseHash);

  if (!valid) {
    record.count++;
    attemptLog.set(config.salt, record);
  } else {
    attemptLog.delete(config.salt);
  }

  return valid;
}

// ─── Gate check ──────────────────────────────────────────────────────

export function isGatedOperation(command?: string, subcommand?: string, args?: CliArgs): boolean {
  if (!command) return false;

  for (const rule of GATED_OPERATIONS) {
    if (rule.command !== command) continue;

    // Check subcommand match
    if (rule.subcommand !== undefined) {
      const subs = Array.isArray(rule.subcommand) ? rule.subcommand : [rule.subcommand];
      if (!subs.includes(subcommand ?? '')) continue;
    }

    // Check condition
    if (rule.condition && args && !rule.condition(args)) continue;

    return true;
  }

  return false;
}

// ─── Interactive prompts ─────────────────────────────────────────────

async function promptPassphrase(
  rl: readline.Interface,
  prompt = 'Operator passphrase: ',
): Promise<string> {
  // Note: readline doesn't hide input natively. For real security,
  // we'd use a TTY raw mode approach. This is acceptable for CLI.
  const answer = await rl.question(prompt);
  return answer.trim();
}

/**
 * Require operator authentication. Checks session cache first,
 * then prompts interactively. Returns true if authorized.
 */
export async function requireOperatorAuth(
  rl?: readline.Interface,
  rawEnv: NodeJS.ProcessEnv = process.env,
  inlinePassphrase?: string,
): Promise<boolean> {
  // Already authorized this session
  if (isSessionAuthorized()) return true;

  // Not configured = first-time use, allow through
  const config = loadOperatorConfig(rawEnv);
  if (!config) return true;

  // Non-interactive: passphrase provided as argument
  if (inlinePassphrase) {
    const valid = validateOperatorPassphrase(inlinePassphrase, rawEnv);
    if (valid) authorizeSession();
    return valid;
  }

  // Interactive: prompt
  const ownRl = rl === undefined;
  const activeRl =
    rl ??
    readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

  try {
    const passphrase = await promptPassphrase(activeRl, '🔐 Operator passphrase: ');
    const valid = validateOperatorPassphrase(passphrase, rawEnv);
    if (valid) {
      authorizeSession();
    } else {
      process.stderr.write('❌ Invalid passphrase.\n');
    }
    return valid;
  } finally {
    if (ownRl) activeRl.close();
  }
}

/**
 * Enroll a new operator passphrase during first-time setup.
 */
export async function enrollOperatorPassphrase(
  rl: readline.Interface,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; error?: string }> {
  const existing = loadOperatorConfig(rawEnv);
  if (existing) {
    return {
      ok: false,
      error:
        'Operator passphrase already configured. Use "memphis operator set-passphrase" to change it.',
    };
  }

  process.stderr.write('\n── Operator Passphrase Setup ──────────────────────────\n');
  process.stderr.write('This passphrase gates dangerous operations (like sudo).\n');
  process.stderr.write('You will need it for: vault init, trust changes, rollbacks.\n\n');

  const passphrase = await promptPassphrase(rl, 'Choose operator passphrase: ');
  if (passphrase.length < 8) {
    return { ok: false, error: 'Passphrase must be at least 8 characters.' };
  }

  const confirm = await promptPassphrase(rl, 'Confirm passphrase: ');
  if (passphrase !== confirm) {
    return { ok: false, error: 'Passphrases do not match.' };
  }

  const recoveryQ = await rl.question('Recovery question (in case you forget): ');
  const recoveryA = await promptPassphrase(rl, 'Recovery answer: ');
  if (!recoveryQ.trim() || !recoveryA.trim()) {
    return { ok: false, error: 'Recovery question and answer are required.' };
  }

  const salt = generateSalt();
  const now = new Date().toISOString();

  const config: OperatorConfig = {
    schemaVersion: 1,
    passphraseHash: hashWithSalt(passphrase, salt),
    salt,
    createdAt: now,
    updatedAt: now,
    recoveryQuestionHint: recoveryQ.trim(),
    recoveryHash: hashWithSalt(recoveryA.trim(), salt),
  };

  saveOperatorConfig(config, rawEnv);
  authorizeSession();

  process.stderr.write('✅ Operator passphrase set. Session authorized.\n\n');
  return { ok: true };
}

/**
 * Change operator passphrase (requires old passphrase first).
 */
export async function changeOperatorPassphrase(
  rl: readline.Interface,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; error?: string }> {
  const existing = loadOperatorConfig(rawEnv);
  if (!existing) {
    return {
      ok: false,
      error:
        'No operator passphrase configured. Use "memphis init" or "memphis operator set-passphrase".',
    };
  }

  const oldPass = await promptPassphrase(rl, 'Current passphrase: ');
  if (!validateOperatorPassphrase(oldPass, rawEnv)) {
    return { ok: false, error: 'Current passphrase is incorrect.' };
  }

  const newPass = await promptPassphrase(rl, 'New passphrase: ');
  if (newPass.length < 8) {
    return { ok: false, error: 'Passphrase must be at least 8 characters.' };
  }

  const confirm = await promptPassphrase(rl, 'Confirm new passphrase: ');
  if (newPass !== confirm) {
    return { ok: false, error: 'Passphrases do not match.' };
  }

  const salt = generateSalt();
  const now = new Date().toISOString();

  existing.passphraseHash = hashWithSalt(newPass, salt);
  existing.salt = salt;
  existing.updatedAt = now;

  saveOperatorConfig(existing, rawEnv);
  authorizeSession();

  return { ok: true };
}

/**
 * Recover passphrase via recovery answer.
 */
export async function recoverOperatorPassphrase(
  rl: readline.Interface,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; error?: string }> {
  const existing = loadOperatorConfig(rawEnv);
  if (!existing) {
    return { ok: false, error: 'No operator passphrase configured.' };
  }

  process.stderr.write(`Recovery question: ${existing.recoveryQuestionHint}\n`);
  const answer = await promptPassphrase(rl, 'Your answer: ');
  const answerHash = hashWithSalt(answer.trim(), existing.salt);

  if (!secureCompare(answerHash, existing.recoveryHash)) {
    return { ok: false, error: 'Recovery answer is incorrect.' };
  }

  const newPass = await promptPassphrase(rl, 'Set new passphrase: ');
  if (newPass.length < 8) {
    return { ok: false, error: 'Passphrase must be at least 8 characters.' };
  }

  const confirm = await promptPassphrase(rl, 'Confirm new passphrase: ');
  if (newPass !== confirm) {
    return { ok: false, error: 'Passphrases do not match.' };
  }

  const salt = generateSalt();
  const now = new Date().toISOString();

  existing.passphraseHash = hashWithSalt(newPass, salt);
  existing.salt = salt;
  existing.updatedAt = now;

  saveOperatorConfig(existing, rawEnv);
  authorizeSession();

  process.stderr.write('✅ Passphrase reset. Session authorized.\n');
  return { ok: true };
}
