import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_QUERY_LIMIT = 5;
const DEFAULT_REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

type KnowledgeSourceFormat = 'markdown' | 'workspace-context';
type WorkspaceContextSource = {
  workspaceName: string;
  purpose: string;
  directories: Record<string, string>;
  preferredFormats: string[];
  rules: string[];
};
type KnowledgeSourceDefinition = {
  id: KnowledgeSourceId;
  label: string;
  description: string;
  optional: boolean;
  format: KnowledgeSourceFormat;
  path: string;
};
type KnowledgeSection = {
  title: string;
  content: string;
};
type LoadedKnowledgeSource = {
  status: KnowledgeSourceStatus;
  sections: KnowledgeSection[];
};

export type KnowledgeSourceId =
  | 'workspace-context'
  | 'architecture-model'
  | 'knowledge-synth'
  | 'long-term-memory';

export type KnowledgeSourceStatus = {
  id: KnowledgeSourceId;
  label: string;
  description: string;
  path: string;
  format: KnowledgeSourceFormat;
  optional: boolean;
  available: boolean;
  modifiedAt: string | null;
  bytes: number;
  sectionCount: number;
  warning: string | null;
};

export type KnowledgeStatusResult = {
  ok: true;
  mode: 'knowledge.status' | 'knowledge.sources';
  generatedAt: string;
  workspaceRoot: string;
  repoRoot: string;
  summary: {
    loaded: number;
    missingOptional: number;
    missingRequired: number;
  };
  sources: KnowledgeSourceStatus[];
};

export type KnowledgeQueryHit = {
  sourceId: KnowledgeSourceId;
  sourceLabel: string;
  sourcePath: string;
  section: string;
  score: number;
  snippet: string;
};

export type KnowledgeQueryResult = {
  ok: true;
  mode: 'knowledge.query';
  generatedAt: string;
  topic: string;
  source: KnowledgeSourceId | null;
  limit: number;
  availableSources: number;
  hits: KnowledgeQueryHit[];
};

export class KnowledgeService {
  private readonly repoRoot: string;
  private readonly workspaceRoot: string;

  constructor(options: { repoRoot?: string; workspaceRoot?: string } = {}) {
    this.repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  }

  public buildStatus(): KnowledgeStatusResult {
    return this.buildStatusPayload('knowledge.status');
  }

  public listSources(): KnowledgeStatusResult {
    return this.buildStatusPayload('knowledge.sources');
  }

  public query(
    topic: string,
    options: {
      source?: string;
      limit?: number;
    } = {},
  ): KnowledgeQueryResult {
    const normalizedTopic = collapseWhitespace(topic);
    if (!normalizedTopic) {
      throw new Error('knowledge query requires a non-empty topic');
    }

    const requestedSource = this.resolveSourceId(options.source);
    const queryLimit = clampLimit(options.limit);
    const loadedSources = this.loadSources();
    const selectedSources = requestedSource
      ? loadedSources.filter((source) => source.status.id === requestedSource)
      : loadedSources;

    const hits = selectedSources
      .filter((source) => source.status.available)
      .flatMap((source) => {
        return source.sections
          .map((section) => {
            const score = scoreSection(normalizedTopic, section);
            if (score <= 0) {
              return null;
            }
            return {
              sourceId: source.status.id,
              sourceLabel: source.status.label,
              sourcePath: source.status.path,
              section: section.title,
              score,
              snippet: extractSnippet(section.content, normalizedTopic),
            } satisfies KnowledgeQueryHit;
          })
          .filter((item): item is KnowledgeQueryHit => item !== null);
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.sourceId !== right.sourceId) {
          return left.sourceId.localeCompare(right.sourceId);
        }
        return left.section.localeCompare(right.section);
      })
      .slice(0, queryLimit);

    return {
      ok: true,
      mode: 'knowledge.query',
      generatedAt: new Date().toISOString(),
      topic: normalizedTopic,
      source: requestedSource ?? null,
      limit: queryLimit,
      availableSources: selectedSources.filter((source) => source.status.available).length,
      hits,
    };
  }

  private buildStatusPayload(mode: KnowledgeStatusResult['mode']): KnowledgeStatusResult {
    const sources = this.loadSources().map((source) => source.status);
    return {
      ok: true,
      mode,
      generatedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      repoRoot: this.repoRoot,
      summary: {
        loaded: sources.filter((source) => source.available).length,
        missingOptional: sources.filter((source) => !source.available && source.optional).length,
        missingRequired: sources.filter((source) => !source.available && !source.optional).length,
      },
      sources,
    };
  }

  private loadSources(): LoadedKnowledgeSource[] {
    return this.sourceDefinitions().map((definition) => {
      if (!existsSync(definition.path)) {
        return {
          status: {
            ...baseStatus(definition),
            warning: 'source file not found',
          },
          sections: [],
        };
      }

      try {
        const stats = statSync(definition.path);
        const raw = readFileSync(definition.path, 'utf8');
        const sections = loadSections(definition, raw);
        return {
          status: {
            ...baseStatus(definition),
            available: true,
            modifiedAt: stats.mtime.toISOString(),
            bytes: stats.size,
            sectionCount: sections.length,
          },
          sections,
        };
      } catch (error) {
        return {
          status: {
            ...baseStatus(definition),
            warning: error instanceof Error ? error.message : String(error),
          },
          sections: [],
        };
      }
    });
  }

  private resolveSourceId(value?: string): KnowledgeSourceId | undefined {
    if (!value || !value.trim()) {
      return undefined;
    }

    const normalized = value.trim() as KnowledgeSourceId;
    if (this.sourceDefinitions().some((source) => source.id === normalized)) {
      return normalized;
    }

    throw new Error(
      `unknown knowledge source: ${value}. Expected one of: ${this.sourceDefinitions()
        .map((source) => source.id)
        .join(', ')}`,
    );
  }

  private sourceDefinitions(): KnowledgeSourceDefinition[] {
    return [
      {
        id: 'workspace-context',
        label: 'Workspace context',
        description: 'Current workspace rules and directories from .memphis/context.json.',
        optional: true,
        format: 'workspace-context',
        path: join(this.workspaceRoot, '.memphis', 'context.json'),
      },
      {
        id: 'architecture-model',
        label: 'Architecture model',
        description: 'Repo-local architecture snapshot aligned with shipped product truth.',
        optional: false,
        format: 'markdown',
        path: join(this.repoRoot, 'memory', 'architecture-model-2026-03-27.md'),
      },
      {
        id: 'knowledge-synth',
        label: 'Knowledge synth',
        description: 'Curated full-stack repo scan of active runtime knowledge.',
        optional: false,
        format: 'markdown',
        path: join(this.repoRoot, 'memory', 'memphis-knowledge-synth-2026-03-27.md'),
      },
      {
        id: 'long-term-memory',
        label: 'Long-term memory',
        description: 'Optional curated long-term memory note for Memphis.',
        optional: true,
        format: 'markdown',
        path: join(this.repoRoot, 'MEMORY.md'),
      },
    ];
  }
}

function baseStatus(definition: KnowledgeSourceDefinition): KnowledgeSourceStatus {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    path: definition.path,
    format: definition.format,
    optional: definition.optional,
    available: false,
    modifiedAt: null,
    bytes: 0,
    sectionCount: 0,
    warning: null,
  };
}

function loadSections(definition: KnowledgeSourceDefinition, raw: string): KnowledgeSection[] {
  if (definition.format === 'workspace-context') {
    return buildWorkspaceContextSections(raw);
  }
  return splitMarkdownSections(raw, definition.label);
}

function buildWorkspaceContextSections(raw: string): KnowledgeSection[] {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const directories = asStringRecord(parsed.directories);
  const preferredFormats = asStringArray(parsed.preferredFormats);
  const rules = asStringArray(parsed.rules);

  const workspaceName =
    typeof parsed.workspaceName === 'string' && parsed.workspaceName.trim()
      ? parsed.workspaceName.trim()
      : 'workspace';
  const purpose =
    typeof parsed.purpose === 'string' && parsed.purpose.trim()
      ? parsed.purpose.trim()
      : 'No purpose declared.';

  const context: WorkspaceContextSource = {
    workspaceName,
    purpose,
    directories,
    preferredFormats,
    rules,
  };

  return [
    {
      title: 'Workspace summary',
      content: [
        `Workspace: ${context.workspaceName}`,
        `Purpose: ${context.purpose}`,
        `Directories: memory=${context.directories.memory ?? 'memory'}, notes=${context.directories.notes ?? 'notes'}, apps=${context.directories.apps ?? 'apps'}`,
        `Preferred formats: ${context.preferredFormats.join(', ') || 'none'}`,
      ].join('\n'),
    },
    {
      title: 'Workspace rules',
      content: context.rules.length > 0 ? context.rules.join('\n') : 'No workspace rules declared.',
    },
  ];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === 'string' && item.trim().length > 0),
  ) as Record<string, string>;
}

function splitMarkdownSections(content: string, fallbackTitle: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let currentTitle = fallbackTitle;
  let currentBody: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const body = collapseWhitespace(currentBody.join(' '));
      if (body) {
        sections.push({ title: currentTitle, content: body });
      }
      currentTitle = heading[1].trim();
      currentBody = [];
      continue;
    }

    currentBody.push(line.trim());
  }

  const body = collapseWhitespace(currentBody.join(' '));
  if (body) {
    sections.push({ title: currentTitle, content: body });
  }

  return sections.length > 0
    ? sections
    : [{ title: fallbackTitle, content: collapseWhitespace(content) }];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clampLimit(value?: number): number {
  const resolved = Number.isFinite(value) ? Number(value) : DEFAULT_QUERY_LIMIT;
  return Math.max(1, Math.min(10, Math.trunc(resolved || DEFAULT_QUERY_LIMIT)));
}

function scoreSection(topic: string, section: KnowledgeSection): number {
  const query = topic.toLowerCase();
  const title = section.title.toLowerCase();
  const body = section.content.toLowerCase();
  const terms = [...new Set(query.split(/[^a-z0-9]+/i).filter((term) => term.length >= 2))];
  let score = 0;

  if (title.includes(query)) {
    score += 8;
  }
  if (body.includes(query)) {
    score += 5;
  }

  for (const term of terms) {
    if (title.includes(term)) {
      score += 3;
    }
    if (body.includes(term)) {
      score += 1;
    }
  }

  return score;
}

function extractSnippet(content: string, topic: string): string {
  const normalized = collapseWhitespace(content);
  if (!normalized) {
    return '';
  }

  const haystack = normalized.toLowerCase();
  const terms = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length >= 2);
  const index = [topic.toLowerCase(), ...terms]
    .map((term) => haystack.indexOf(term))
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0];

  if (index === undefined) {
    return trimSnippet(normalized);
  }

  const start = Math.max(0, index - 60);
  const end = Math.min(normalized.length, index + 180);
  return trimSnippet(normalized.slice(start, end), start > 0, end < normalized.length);
}

function trimSnippet(value: string, prefix = false, suffix = value.length >= 180): string {
  const trimmed = collapseWhitespace(value).slice(0, 180).trim();
  return `${prefix ? '...' : ''}${trimmed}${suffix ? '...' : ''}`;
}
