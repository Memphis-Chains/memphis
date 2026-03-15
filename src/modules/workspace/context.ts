import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { z } from 'zod';

import { AppError } from '../../core/errors.js';

const MEMPHIS_DIR_NAME = '.memphis';
const CONTEXT_FILE_NAME = 'context.json';
const MANAGED_BLOCK_START = '<!-- memphis:context:start -->';
const MANAGED_BLOCK_END = '<!-- memphis:context:end -->';

const workspaceContextSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceName: z.string().min(1),
  purpose: z.string().min(1),
  directories: z.object({
    memory: z.string().min(1),
    notes: z.string().min(1),
    apps: z.string().min(1),
  }),
  preferredFormats: z.array(z.string().min(1)).min(1),
  rules: z.array(z.string().min(1)).min(1),
});

export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;

export type WorkspaceStatus = {
  path: string;
  kind: 'directory' | 'file';
  status: 'created' | 'updated' | 'kept' | 'skipped';
  detail: string;
};

export type WorkspaceMutationResult = {
  root: string;
  contextPath: string;
  statuses: WorkspaceStatus[];
};

function resolveWorkspaceRoot(pathValue?: string): string {
  return resolve(pathValue?.trim() ? pathValue : process.cwd());
}

function contextDir(root: string): string {
  return join(root, MEMPHIS_DIR_NAME);
}

function workspaceContextPath(root: string): string {
  return join(contextDir(root), CONTEXT_FILE_NAME);
}

function defaultWorkspaceContext(root: string): WorkspaceContext {
  const name = basename(root) || 'workspace';
  return {
    schemaVersion: 1,
    workspaceName: name,
    purpose: 'Shared MemphisOS workspace for supervised, auditable agent work.',
    directories: {
      memory: 'memory',
      notes: 'notes',
      apps: 'apps',
    },
    preferredFormats: ['markdown', 'json'],
    rules: [
      'Prefer local-first, auditable, and reversible changes.',
      'Treat secrets as vault-managed values, not committed files.',
      'Keep human-facing plans and notes in Markdown.',
      'Use MemphisOS as the control plane; keep vendor-specific integrations downstream.',
    ],
  };
}

function ensureDirectory(pathValue: string, statuses: WorkspaceStatus[]): void {
  const existed = existsSync(pathValue);
  mkdirSync(pathValue, { recursive: true });
  statuses.push({
    path: pathValue,
    kind: 'directory',
    status: existed ? 'kept' : 'created',
    detail: existed ? 'directory already present' : 'directory created',
  });
}

function loadWorkspaceContext(root: string): WorkspaceContext {
  const pathValue = workspaceContextPath(root);
  if (!existsSync(pathValue)) {
    throw new AppError('VALIDATION_ERROR', `workspace context not found: ${pathValue}`, 404, {
      path: pathValue,
      hint: 'run `memphis workspace init` first',
    });
  }
  const raw = JSON.parse(readFileSync(pathValue, 'utf8')) as unknown;
  return workspaceContextSchema.parse(raw);
}

function writeWorkspaceContext(
  root: string,
  force: boolean,
  statuses: WorkspaceStatus[],
): WorkspaceContext {
  const pathValue = workspaceContextPath(root);
  if (existsSync(pathValue) && !force) {
    const loaded = loadWorkspaceContext(root);
    statuses.push({
      path: pathValue,
      kind: 'file',
      status: 'kept',
      detail: 'workspace context already present',
    });
    return loaded;
  }

  const existed = existsSync(pathValue);
  const context = defaultWorkspaceContext(root);
  writeFileSync(pathValue, `${JSON.stringify(context, null, 2)}\n`, 'utf8');
  statuses.push({
    path: pathValue,
    kind: 'file',
    status: existed ? 'updated' : 'created',
    detail: existed
      ? 'workspace context rewritten from default template'
      : 'workspace context created',
  });
  return context;
}

function renderManagedContextBlock(context: WorkspaceContext): string {
  const lines = [
    MANAGED_BLOCK_START,
    '## Memphis Workspace Context',
    '',
    `- workspace: \`${context.workspaceName}\``,
    `- purpose: ${context.purpose}`,
    `- notes dir: \`${context.directories.notes}/\``,
    `- memory dir: \`${context.directories.memory}/\``,
    `- apps dir: \`${context.directories.apps}/\``,
    `- preferred formats: \`${context.preferredFormats.join(', ')}\``,
    '',
    '## Working Rules',
    ...context.rules.map((rule) => `- ${rule}`),
    MANAGED_BLOCK_END,
  ];
  return lines.join('\n');
}

function renderManagedContextFile(
  targetFile: 'AGENTS.md' | 'CLAUDE.md',
  context: WorkspaceContext,
): string {
  const title =
    targetFile === 'AGENTS.md' ? '# Workspace Agent Guide' : '# Claude Workspace Context';
  const intro =
    targetFile === 'AGENTS.md'
      ? 'This file contains Memphis-managed workspace context for agent tools.'
      : 'This file contains Memphis-managed workspace context for Claude-style coding agents.';

  return [
    title,
    '',
    intro,
    '',
    renderManagedContextBlock(context),
    '',
    '## Local Notes',
    '',
    'Add tool-specific notes below this line. Memphis only manages the block above.',
    '',
  ].join('\n');
}

function syncManagedContextFile(
  root: string,
  targetFile: 'AGENTS.md' | 'CLAUDE.md',
  context: WorkspaceContext,
  force: boolean,
  statuses: WorkspaceStatus[],
): void {
  const filePath = join(root, targetFile);
  const rendered = renderManagedContextFile(targetFile, context);

  if (!existsSync(filePath)) {
    writeFileSync(filePath, rendered, 'utf8');
    statuses.push({
      path: filePath,
      kind: 'file',
      status: 'created',
      detail: `${targetFile} created from Memphis workspace template`,
    });
    return;
  }

  const existing = readFileSync(filePath, 'utf8');
  if (existing.includes(MANAGED_BLOCK_START) && existing.includes(MANAGED_BLOCK_END)) {
    const next = existing.replace(
      new RegExp(`${MANAGED_BLOCK_START}[\\s\\S]*?${MANAGED_BLOCK_END}`),
      renderManagedContextBlock(context),
    );
    if (next === existing) {
      statuses.push({
        path: filePath,
        kind: 'file',
        status: 'kept',
        detail: `${targetFile} already in sync`,
      });
      return;
    }
    writeFileSync(filePath, next, 'utf8');
    statuses.push({
      path: filePath,
      kind: 'file',
      status: 'updated',
      detail: `${targetFile} Memphis-managed block updated`,
    });
    return;
  }

  if (force) {
    writeFileSync(filePath, rendered, 'utf8');
    statuses.push({
      path: filePath,
      kind: 'file',
      status: 'updated',
      detail: `${targetFile} overwritten because --force was set`,
    });
    return;
  }

  statuses.push({
    path: filePath,
    kind: 'file',
    status: 'skipped',
    detail: `${targetFile} exists without Memphis markers; rerun with --force to overwrite`,
  });
}

function ensureWorkspaceDirectories(
  root: string,
  context: WorkspaceContext,
  statuses: WorkspaceStatus[],
): void {
  ensureDirectory(join(root, context.directories.memory), statuses);
  ensureDirectory(join(root, context.directories.notes), statuses);
  ensureDirectory(join(root, context.directories.apps), statuses);
}

export function initializeWorkspace(
  pathValue?: string,
  options: { force?: boolean } = {},
): WorkspaceMutationResult {
  const root = resolveWorkspaceRoot(pathValue);
  const statuses: WorkspaceStatus[] = [];
  ensureDirectory(root, statuses);
  ensureDirectory(contextDir(root), statuses);
  const context = writeWorkspaceContext(root, options.force === true, statuses);
  ensureWorkspaceDirectories(root, context, statuses);
  syncManagedContextFile(root, 'AGENTS.md', context, options.force === true, statuses);
  syncManagedContextFile(root, 'CLAUDE.md', context, options.force === true, statuses);

  return {
    root,
    contextPath: workspaceContextPath(root),
    statuses,
  };
}

export function syncWorkspaceContext(
  pathValue?: string,
  options: { force?: boolean } = {},
): WorkspaceMutationResult {
  const root = resolveWorkspaceRoot(pathValue);
  const statuses: WorkspaceStatus[] = [];
  const context = loadWorkspaceContext(root);
  ensureWorkspaceDirectories(root, context, statuses);
  syncManagedContextFile(root, 'AGENTS.md', context, options.force === true, statuses);
  syncManagedContextFile(root, 'CLAUDE.md', context, options.force === true, statuses);

  return {
    root,
    contextPath: workspaceContextPath(root),
    statuses,
  };
}
