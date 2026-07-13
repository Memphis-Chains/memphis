import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { getChainPath, getDataDir, normalizeChainName } from '../config/paths.js';
import { loadAgentProfile, writeAgentProfile } from '../infra/agent-profile.js';
import { isOperatorConfigured } from '../infra/auth/operator-gate.js';
import { resolveDotEnvPath } from '../infra/config/dotenv-file.js';
import { appendBlock } from '../infra/storage/chain-adapter.js';
import { resolveVaultPath } from '../infra/storage/vault-paths.js';
import { updateSoulMemory } from '../soul/memory.js';
import type { SoulMemoryUpdate } from '../soul/types.js';

export type FirstRunMode = 'minimal-baseline' | 'guided-conversation';
export type FirstRunState =
  | 'not-initialized'
  | 'initialized-clean'
  | 'legacy-migrateable'
  | 'legacy-manual';

export type GuidedFirstRunAnswers = {
  agentName: string;
  ownerName: string;
  languages: string[];
  communicationStyle: string;
  purpose: string;
  boundaries: string;
  memoryExpectations: string;
  identityStance: string;
};

export type FirstRunRecord = {
  schemaVersion: 1;
  initializedAt: string;
  mode: FirstRunMode;
  createdChains: string[];
  createdBlocks: number;
  summary: string;
  origin?: 'controlled-init' | 'legacy-repair';
  legacyChains?: string[];
};

export type FirstRunStatus = {
  state: FirstRunState;
  initialized: boolean;
  record: FirstRunRecord | null;
  envPresent: boolean;
  vaultInitialized: boolean;
  operatorConfigured: boolean;
  legacyChains: string[];
  legacyFiles: number;
  reasons: string[];
  recommendedAction: string;
};

export type FirstRunPlanPreview = {
  mode: FirstRunMode;
  summary: string;
  createdChains: string[];
  createdBlocks: number;
  prompts?: string[];
};

export type FirstRunPlan = {
  canInitialize: boolean;
  blocked: boolean;
  requiresRepair: boolean;
  requiresManualRecovery: boolean;
  legacyDetected: boolean;
  legacyAdoptionRequired: boolean;
  suggestedMode: FirstRunMode | null;
  supportedModes: FirstRunMode[];
  nextCommand: string;
  summary: string;
  preview: {
    minimalBaseline: FirstRunPlanPreview;
    guidedConversation: FirstRunPlanPreview;
  } | null;
};

export type FirstRunStatusReport = FirstRunStatus & {
  plan: FirstRunPlan;
};

export type FirstRunPreview = {
  mode: FirstRunMode;
  summary: string;
  createdChains: string[];
  createdBlocks: number;
  blocks: Array<{ chain: string; data: Record<string, unknown> }>;
  soulMemoryUpdate?: SoulMemoryUpdate;
  identity: {
    agentName: string;
    ownerName: string;
  };
};

export type FirstRunApplyResult = {
  ok: boolean;
  record: FirstRunRecord;
  createdChains: string[];
  createdBlocks: number;
  summary: string;
};

export type LegacyScanResult = {
  state: Extract<FirstRunState, 'legacy-migrateable' | 'legacy-manual'> | null;
  chains: string[];
  files: number;
  reasons: string[];
};

const FIRST_RUN_SCHEMA_VERSION = 1;
const ONBOARDING_TAG = 'onboarding-originated';
const FIRST_RUN_FILE = 'first-run.json';
const TECHNICAL_BASELINE_TAG = 'technical-baseline';
const GUIDED_ONBOARDING_TAG = 'guided-onboarding';
const GUIDED_CONVERSATION_PROMPTS = [
  'agent name',
  'operator name',
  'preferred languages',
  'communication style',
  'primary purpose',
  'boundaries and constraints',
  'memory expectations',
  'identity stance',
] as const;

function getFirstRunRecordPath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(rawEnv), 'config', FIRST_RUN_FILE);
}

function getEnvFilePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  // Route through the shared `resolveDotEnvPath` so onboarding status
  // checks look at the same file the rest of the CLI writes to.
  // Previously this defaulted to `.env` in cwd while config mutations
  // honoured the install root — `inspectFirstRunStatus` then reported
  // `envPresent=false` even right after a successful `memphis init`
  // that wrote to installRoot/.env. Codex P1 follow-up on #222.
  return resolveDotEnvPath(rawEnv);
}

export function loadFirstRunRecord(rawEnv: NodeJS.ProcessEnv = process.env): FirstRunRecord | null {
  const path = getFirstRunRecordPath(rawEnv);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FirstRunRecord;
    if (parsed.schemaVersion !== FIRST_RUN_SCHEMA_VERSION) return null;
    if (!parsed.initializedAt || !parsed.mode || !Array.isArray(parsed.createdChains)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeFirstRunRecord(
  record: FirstRunRecord,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const path = getFirstRunRecordPath(rawEnv);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function listChainDirectories(rawEnv: NodeJS.ProcessEnv = process.env): string[] {
  const chainsRoot = getChainPath(undefined, rawEnv);
  if (!existsSync(chainsRoot)) return [];
  try {
    return readdirSync(chainsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !isArchivedChainDirectory(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function isArchivedChainDirectory(name: string): boolean {
  return /(?:^|[.-])(?:backup|bak|repair-backup|repair-backups)(?:[.-]|$)/iu.test(name);
}

export function scanLegacyChainState(rawEnv: NodeJS.ProcessEnv = process.env): LegacyScanResult {
  const chainsRoot = getChainPath(undefined, rawEnv);
  if (!existsSync(chainsRoot)) {
    return { state: null, chains: [], files: 0, reasons: [] };
  }

  const chains = new Set<string>();
  const reasons = new Set<string>();
  let files = 0;
  let state: LegacyScanResult['state'] = null;

  for (const chainDir of listChainDirectories(rawEnv)) {
    const absoluteDir = join(chainsRoot, chainDir);
    const entries = readdirSync(absoluteDir)
      .filter((entry) => entry.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));

    for (const entry of entries) {
      const absolutePath = join(absoluteDir, entry);
      files += 1;
      const normalizedChain = normalizeChainName(chainDir) ?? chainDir;
      try {
        const payload = JSON.parse(readFileSync(absolutePath, 'utf8')) as Record<string, unknown>;
        const rootShapeOk =
          typeof payload.index === 'number' &&
          typeof payload.timestamp === 'string' &&
          typeof payload.chain === 'string' &&
          typeof payload.prev_hash === 'string' &&
          typeof payload.hash === 'string' &&
          typeof payload.data === 'object' &&
          payload.data !== null &&
          !Array.isArray(payload.data);

        if (!rootShapeOk) {
          if (normalizedChain === 'patterns') {
            if (state !== 'legacy-manual') {
              state = 'legacy-migrateable';
            }
            chains.add(normalizedChain);
            reasons.add(`derived patterns block needs rebuild in ${absolutePath}`);
          } else {
            state = 'legacy-manual';
            chains.add(normalizedChain);
            reasons.add(`invalid root block shape in ${absolutePath}`);
          }
          continue;
        }

        const data = payload.data as Record<string, unknown>;
        const tags =
          Array.isArray(data.tags) && data.tags.every((value) => typeof value === 'string');
        const typeOk = typeof data.type === 'string' && data.type.trim().length > 0;
        const contentOk = typeof data.content === 'string';

        if (!typeOk || !contentOk || !tags) {
          if (state !== 'legacy-manual') {
            state = 'legacy-migrateable';
          }
          chains.add(normalizedChain);
          reasons.add(`legacy block shape in ${absolutePath}`);
        }
      } catch {
        if (normalizedChain === 'patterns') {
          if (state !== 'legacy-manual') {
            state = 'legacy-migrateable';
          }
          chains.add(normalizedChain);
          reasons.add(`derived patterns block needs rebuild in ${absolutePath}`);
        } else {
          state = 'legacy-manual';
          chains.add(normalizedChain);
          reasons.add(`unreadable chain block ${absolutePath}`);
        }
      }
    }
  }

  return {
    state,
    chains: [...chains].sort((left, right) => left.localeCompare(right)),
    files,
    reasons: [...reasons].sort((left, right) => left.localeCompare(right)),
  };
}

function hasMeaningfulExistingState(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const chainsRoot = getChainPath(undefined, rawEnv);
  if (!existsSync(chainsRoot)) return false;

  for (const chainDir of listChainDirectories(rawEnv)) {
    const absoluteDir = join(chainsRoot, chainDir);
    const count = readdirSync(absoluteDir).filter((entry) => entry.endsWith('.json')).length;
    if (count > 0) return true;
  }

  return false;
}

export function inspectFirstRunStatus(rawEnv: NodeJS.ProcessEnv = process.env): FirstRunStatus {
  const record = loadFirstRunRecord(rawEnv);
  const legacy = scanLegacyChainState(rawEnv);
  const envPresent = existsSync(resolve(getEnvFilePath(rawEnv)));
  const vaultInitialized = existsSync(resolve(resolveVaultPath('vault-state.json', rawEnv)));
  const operatorConfigured = isOperatorConfigured(rawEnv);

  if (legacy.state === 'legacy-manual') {
    return {
      state: 'legacy-manual',
      initialized: false,
      record,
      envPresent,
      vaultInitialized,
      operatorConfigured,
      legacyChains: legacy.chains,
      legacyFiles: legacy.files,
      reasons: legacy.reasons,
      recommendedAction:
        'Archive the existing runtime and start clean, or implement a manual legacy chain recovery before normal use',
    };
  }

  if (legacy.state === 'legacy-migrateable') {
    return {
      state: 'legacy-migrateable',
      initialized: false,
      record,
      envPresent,
      vaultInitialized,
      operatorConfigured,
      legacyChains: legacy.chains,
      legacyFiles: legacy.files,
      reasons: legacy.reasons,
      recommendedAction:
        'Run memphis repair runtime to normalize legacy chain blocks before normal use',
    };
  }

  if (record) {
    return {
      state: 'initialized-clean',
      initialized: true,
      record,
      envPresent,
      vaultInitialized,
      operatorConfigured,
      legacyChains: [],
      legacyFiles: 0,
      reasons: [],
      recommendedAction: 'none',
    };
  }

  if (hasMeaningfulExistingState(rawEnv)) {
    return {
      state: 'legacy-migrateable',
      initialized: false,
      record,
      envPresent,
      vaultInitialized,
      operatorConfigured,
      legacyChains: [],
      legacyFiles: 0,
      reasons: ['meaningful runtime state exists without a canonical first-run record'],
      recommendedAction:
        'Treat this runtime as pre-init legacy state; repair or archive it before claiming a controlled first-run',
    };
  }

  return {
    state: 'not-initialized',
    initialized: false,
    record,
    envPresent,
    vaultInitialized,
    operatorConfigured,
    legacyChains: [],
    legacyFiles: 0,
    reasons: [],
    recommendedAction: 'Run memphis init',
  };
}

function buildGuidedConversationTemplatePreview(
  rawEnv: NodeJS.ProcessEnv = process.env,
): FirstRunPlanPreview {
  const profile = loadAgentProfile(rawEnv);
  const agentName = profile?.agentName ?? 'Memphis Agent';
  const ownerName = profile?.ownerName ?? 'local operator';

  return {
    mode: 'guided-conversation',
    summary: [
      `Guided first-run will ask for identity, purpose, boundaries, and memory stance before writing onboarding state.`,
      `Default agent=${agentName}.`,
      `Default operator=${ownerName}.`,
    ].join(' '),
    createdChains: ['journal', 'system'],
    createdBlocks: 4,
    prompts: [...GUIDED_CONVERSATION_PROMPTS],
  };
}

export function buildFirstRunPlan(
  status: FirstRunStatus,
  rawEnv: NodeJS.ProcessEnv = process.env,
): FirstRunPlan {
  const preview =
    status.state === 'not-initialized'
      ? {
          minimalBaseline: {
            mode: 'minimal-baseline' as const,
            summary: buildMinimalBaselinePreview(rawEnv).summary,
            createdChains: ['journal', 'system'],
            createdBlocks: 2,
          },
          guidedConversation: buildGuidedConversationTemplatePreview(rawEnv),
        }
      : null;

  switch (status.state) {
    case 'initialized-clean':
      return {
        canInitialize: false,
        blocked: false,
        requiresRepair: false,
        requiresManualRecovery: false,
        legacyDetected: status.record?.origin === 'legacy-repair',
        legacyAdoptionRequired: false,
        suggestedMode: null,
        supportedModes: [],
        nextCommand: 'none',
        summary:
          status.record?.origin === 'legacy-repair'
            ? 'Controlled first-run state is explicit via legacy adoption. Memphis should keep using the existing runtime history instead of inventing a new onboarding run.'
            : 'Controlled first-run is complete. Memphis should continue from the existing canonical runtime state.',
        preview: null,
      };
    case 'legacy-migrateable':
      return {
        canInitialize: false,
        blocked: false,
        requiresRepair: true,
        requiresManualRecovery: false,
        legacyDetected: true,
        legacyAdoptionRequired: !status.record,
        suggestedMode: null,
        supportedModes: [],
        nextCommand: 'memphis repair runtime',
        summary:
          'Legacy runtime state was detected. Normalize it first so Memphis can converge memory, sessions, and first-run ownership before normal use.',
        preview: null,
      };
    case 'legacy-manual':
      return {
        canInitialize: false,
        blocked: true,
        requiresRepair: false,
        requiresManualRecovery: true,
        legacyDetected: true,
        legacyAdoptionRequired: !status.record,
        suggestedMode: null,
        supportedModes: [],
        nextCommand: status.recommendedAction,
        summary:
          'Legacy runtime state is not safely recoverable automatically. Manual recovery or archival is required before Memphis can trust this runtime.',
        preview: null,
      };
    case 'not-initialized':
    default:
      return {
        canInitialize: status.envPresent,
        blocked: !status.envPresent,
        requiresRepair: false,
        requiresManualRecovery: false,
        legacyDetected: false,
        legacyAdoptionRequired: false,
        suggestedMode: 'guided-conversation',
        supportedModes: ['guided-conversation', 'minimal-baseline'],
        nextCommand: status.envPresent ? 'memphis init' : 'npm run bootstrap',
        summary: status.envPresent
          ? 'Controlled first-run is ready. Guided conversation is the preferred operator path; minimal-baseline remains the fail-safe path.'
          : 'Memphis is not bootstrapped yet. Create a .env first, then run the controlled first-run flow.',
        preview,
      };
  }
}

export function inspectFirstRunStatusReport(
  rawEnv: NodeJS.ProcessEnv = process.env,
): FirstRunStatusReport {
  const status = inspectFirstRunStatus(rawEnv);
  return {
    ...status,
    plan: buildFirstRunPlan(status, rawEnv),
  };
}

export function buildMinimalBaselinePreview(
  rawEnv: NodeJS.ProcessEnv = process.env,
): FirstRunPreview {
  const profile = loadAgentProfile(rawEnv);
  const identity = {
    agentName: profile?.agentName ?? 'Memphis Agent',
    ownerName: profile?.ownerName ?? 'local operator',
  };
  const blocks = [
    {
      chain: 'system',
      data: {
        type: 'system',
        content:
          'Memphis first-run completed in minimal-baseline mode. No conversational soul/identity onboarding was applied.',
        tags: [ONBOARDING_TAG, TECHNICAL_BASELINE_TAG, 'first-run', 'mode:minimal-baseline'],
      },
    },
    {
      chain: 'journal',
      data: {
        type: 'journal',
        content: `Operator ${identity.ownerName} initialized ${identity.agentName} with a minimal technical baseline only.`,
        tags: [ONBOARDING_TAG, TECHNICAL_BASELINE_TAG, 'first-run', 'mode:minimal-baseline'],
      },
    },
  ];

  return {
    mode: 'minimal-baseline',
    summary:
      'Minimal baseline will create only transparent technical onboarding records and no conversational soul framing.',
    createdChains: ['journal', 'system'],
    createdBlocks: blocks.length,
    blocks,
    identity,
  };
}

export function buildGuidedConversationPreview(answers: GuidedFirstRunAnswers): FirstRunPreview {
  const agentName = answers.agentName.trim();
  const ownerName = answers.ownerName.trim();
  const languages = answers.languages.length > 0 ? answers.languages : ['pl', 'en'];
  const memoryUpdate: SoulMemoryUpdate = {
    user: {
      name: ownerName,
      languages,
      preferences: [answers.communicationStyle, answers.memoryExpectations],
    },
    self: {
      personality: answers.identityStance,
      learnings: [
        `Primary purpose: ${answers.purpose}`,
        `Boundaries: ${answers.boundaries}`,
        `Memory expectations: ${answers.memoryExpectations}`,
      ],
    },
    context: {
      activeWork: 'controlled first-run completed',
    },
  };

  const blocks = [
    {
      chain: 'journal',
      data: {
        type: 'journal',
        content: [
          `Operator ${ownerName} established ${agentName} through a guided first-run conversation.`,
          `Identity stance: ${answers.identityStance}.`,
          `Preferred languages: ${languages.join(', ')}.`,
          `Communication style: ${answers.communicationStyle}.`,
        ].join(' '),
        tags: [
          ONBOARDING_TAG,
          GUIDED_ONBOARDING_TAG,
          'identity',
          'first-run',
          'mode:guided-conversation',
        ],
      },
    },
    {
      chain: 'journal',
      data: {
        type: 'journal',
        content: `Purpose agreed by operator: ${answers.purpose}.`,
        tags: [
          ONBOARDING_TAG,
          GUIDED_ONBOARDING_TAG,
          'purpose',
          'first-run',
          'mode:guided-conversation',
        ],
      },
    },
    {
      chain: 'journal',
      data: {
        type: 'journal',
        content: `Operator boundaries and constraints: ${answers.boundaries}. Memory expectations: ${answers.memoryExpectations}.`,
        tags: [
          ONBOARDING_TAG,
          GUIDED_ONBOARDING_TAG,
          'boundaries',
          'first-run',
          'mode:guided-conversation',
        ],
      },
    },
    {
      chain: 'system',
      data: {
        type: 'system',
        content: `Guided first-run completed for ${agentName}. Operator=${ownerName}. Summary: purpose=${answers.purpose}; style=${answers.communicationStyle}; stance=${answers.identityStance}.`,
        tags: [ONBOARDING_TAG, GUIDED_ONBOARDING_TAG, 'first-run', 'mode:guided-conversation'],
      },
    },
  ];

  return {
    mode: 'guided-conversation',
    summary: [
      `Agent: ${agentName}`,
      `Operator: ${ownerName}`,
      `Languages: ${languages.join(', ')}`,
      `Style: ${answers.communicationStyle}`,
      `Purpose: ${answers.purpose}`,
      `Boundaries: ${answers.boundaries}`,
      `Memory: ${answers.memoryExpectations}`,
      `Identity: ${answers.identityStance}`,
    ].join(' | '),
    createdChains: ['journal', 'system'],
    createdBlocks: blocks.length,
    blocks,
    soulMemoryUpdate: memoryUpdate,
    identity: { agentName, ownerName },
  };
}

export async function applyFirstRunPreview(
  preview: FirstRunPreview,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<FirstRunApplyResult> {
  writeAgentProfile(preview.identity, rawEnv);
  if (preview.soulMemoryUpdate) {
    updateSoulMemory(preview.soulMemoryUpdate, rawEnv);
  }

  for (const item of preview.blocks) {
    await appendBlock(item.chain, item.data, rawEnv);
  }

  const record: FirstRunRecord = {
    schemaVersion: FIRST_RUN_SCHEMA_VERSION,
    initializedAt: new Date().toISOString(),
    mode: preview.mode,
    createdChains: preview.createdChains,
    createdBlocks: preview.createdBlocks,
    summary: preview.summary,
    origin: 'controlled-init',
  };
  writeFirstRunRecord(record, rawEnv);

  return {
    ok: true,
    record,
    createdChains: preview.createdChains,
    createdBlocks: preview.createdBlocks,
    summary: preview.summary,
  };
}

export function recordLegacyRuntimeAdoption(
  input: {
    summary: string;
    createdChains: string[];
    createdBlocks: number;
    legacyChains?: string[];
  },
  rawEnv: NodeJS.ProcessEnv = process.env,
): FirstRunRecord {
  const record: FirstRunRecord = {
    schemaVersion: FIRST_RUN_SCHEMA_VERSION,
    initializedAt: new Date().toISOString(),
    mode: 'minimal-baseline',
    createdChains: input.createdChains,
    createdBlocks: input.createdBlocks,
    summary: input.summary,
    origin: 'legacy-repair',
    legacyChains: input.legacyChains,
  };
  writeFirstRunRecord(record, rawEnv);
  return record;
}
