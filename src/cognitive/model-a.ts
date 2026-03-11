/**
 * Model A — Conscious Capture
 *
 * Explicit decision/notes/milestone recording with optional auto-capture.
 *
 * @version 5.0.0
 */

import type { Block } from '../memory/chain.js';
import { appendBlock } from '../infra/storage/chain-adapter.js';
import { ChainStore, type IStore } from './store.js';
import type { ModelAConfig } from './types.js';

export type ModelAEntryKind = 'decision' | 'note' | 'milestone';

export interface ModelACaptureInput {
  kind: ModelAEntryKind;
  title: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  chain?: string;
}

export interface ModelAAutoCaptureInput {
  content: string;
  tags?: string[];
  chain?: string;
  /** User confirmed capture when confirmation mode is enabled */
  confirmed?: boolean;
}

export interface ModelACaptureResult {
  captured: boolean;
  needsConfirmation?: boolean;
  reason?: string;
  preview?: ModelACaptureInput;
  chainRef?: { chain: string; index: number; hash: string; timestamp: string };
  block?: Block;
}

interface ModelADeps {
  append?: typeof appendBlock;
  store?: IStore;
}

const DEFAULT_CONFIG: ModelAConfig = {
  autoCapture: true,
  captureLevel: 'normal',
  requireConfirmation: true,
};

export class ModelA_ConsciousCapture {
  private readonly config: ModelAConfig;
  private readonly append: typeof appendBlock;
  private readonly store: IStore;

  constructor(config?: Partial<ModelAConfig>, deps?: ModelADeps) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = deps?.store ?? new ChainStore();
    this.append = deps?.append ?? this.store.append.bind(this.store);
  }

  /**
   * Explicit capture API for conscious records.
   */
  async capture(input: ModelACaptureInput): Promise<ModelACaptureResult> {
    const chain = input.chain ?? this.defaultChainFor(input.kind);
    const tags = this.normalizeTags(input.kind, input.tags);
    const type = input.kind === 'decision' ? 'decision' : 'journal';

    const content = this.buildContent(input);
    const title = input.title.trim();

    const data: Record<string, unknown> = {
      type,
      title,
      content,
      tags,
      source: 'model-a',
      kind: input.kind,
      metadata: input.metadata ?? {},
      mode: 'conscious',
      captureLevel: this.config.captureLevel,
    };

    const saved = await this.append(chain, data, process.env);

    return {
      captured: true,
      chainRef: {
        chain: saved.chain,
        index: saved.index,
        hash: saved.hash,
        timestamp: saved.timestamp,
      },
      block: {
        index: saved.index,
        chain: saved.chain,
        hash: saved.hash,
        timestamp: saved.timestamp,
        data: {
          ...data,
          content,
          tags,
        },
      },
    };
  }

  /**
   * Auto-capture from natural text.
   * - Respects ModelAConfig.autoCapture
   * - Optional confirmation gate
   */
  async autoCapture(input: ModelAAutoCaptureInput): Promise<ModelACaptureResult> {
    if (!this.config.autoCapture) {
      return { captured: false, reason: 'auto_capture_disabled' };
    }

    const inferred = this.inferCapture(input.content, input.tags, input.chain);
    if (!inferred) {
      return { captured: false, reason: 'no_capture_signal' };
    }

    if (this.config.requireConfirmation && !input.confirmed) {
      return {
        captured: false,
        needsConfirmation: true,
        reason: 'confirmation_required',
        preview: inferred,
      };
    }

    return this.capture(inferred);
  }

  private inferCapture(content: string, tags?: string[], chain?: string): ModelACaptureInput | null {
    const text = content.trim();
    if (!text) return null;

    const lowered = text.toLowerCase();

    const decisionSignal = /(decision:|decided\s+to|we\s+will|i\s+will|chose\s+|going\s+with|opted\s+for)/i.test(text);
    const milestoneSignal = /(milestone:|released?|shipped|completed|launched|finished)/i.test(text);

    let kind: ModelAEntryKind = 'note';
    if (decisionSignal) kind = 'decision';
    else if (milestoneSignal) kind = 'milestone';
    else if (text.length < 20) return null;

    const firstLine = text.split('\n')[0]?.trim() || text.slice(0, 80);
    const titlePrefix = kind === 'decision' ? 'Decision' : kind === 'milestone' ? 'Milestone' : 'Note';

    return {
      kind,
      title: this.truncate(`${titlePrefix}: ${firstLine.replace(/^\w+:\s*/i, '')}`, 120),
      content: text,
      tags: this.normalizeTags(kind, tags ?? this.extractTagsFromText(lowered)),
      chain,
      metadata: { autoCaptured: true },
    };
  }

  private defaultChainFor(kind: ModelAEntryKind): string {
    if (kind === 'decision') return 'decisions';
    if (kind === 'milestone') return 'journal';
    return 'journal';
  }

  private buildContent(input: ModelACaptureInput): string {
    const raw = input.content?.trim();

    if (this.config.captureLevel === 'minimal') {
      return raw || input.title;
    }

    if (this.config.captureLevel === 'verbose') {
      return [
        `Title: ${input.title}`,
        `Kind: ${input.kind}`,
        raw ? `Details: ${raw}` : undefined,
      ]
        .filter(Boolean)
        .join('\n');
    }

    return raw || input.title;
  }

  private normalizeTags(kind: ModelAEntryKind, tags?: string[]): string[] {
    const base = ['model-a', 'conscious', kind];
    const clean = (tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    return Array.from(new Set([...base, ...clean]));
  }

  private extractTagsFromText(lowered: string): string[] {
    const tags: string[] = [];
    if (lowered.includes('bug') || lowered.includes('fix')) tags.push('bug');
    if (lowered.includes('release') || lowered.includes('launch')) tags.push('release');
    if (lowered.includes('api')) tags.push('api');
    return tags;
  }

  private truncate(input: string, max: number): string {
    if (input.length <= max) return input;
    return `${input.slice(0, max - 1)}…`;
  }
}
