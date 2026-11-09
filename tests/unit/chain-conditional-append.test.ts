import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendProposal, proposalBlockData, readProposals } from '../../src/cognitive/dreaming/proposal-chain.js';
import { createProposal, transitionProposal } from '../../src/cognitive/dreaming/proposal-lifecycle.js';
import { appendBlock, appendBlockConditional, exportChain, getChainAdapterStatus } from '../../src/infra/storage/chain-adapter.js';

const bridge = process.env.MEMPHIS_TEST_NATIVE_BRIDGE ?? join(process.cwd(), 'crates', 'memphis-napi');
const hasNative = existsSync(join(bridge, 'index.node'));
const backends = [
  { name: 'TypeScript', rust: false, competitorRust: false },
  { name: 'Rust NAPI', rust: true, competitorRust: true },
  { name: 'TypeScript and Rust NAPI', rust: false, competitorRust: true },
  { name: 'Rust NAPI and TypeScript', rust: true, competitorRust: false },
];

describe.each(backends)('$name conditional chain append', ({ rust, competitorRust }) => {
  it.skipIf((rust || competitorRust) && !hasNative)('serializes a decision with a competing writer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-chain-atomic-'));
    const env = { ...process.env, MEMPHIS_DATA_DIR: root, MEMPHIS_HOME: root,
      RUST_CHAIN_ENABLED: rust ? 'true' : 'false', RUST_CHAIN_BRIDGE_PATH: bridge };
    expect(getChainAdapterStatus(env).backend).toBe(rust ? 'rust-napi' : 'ts-legacy');
    const initial = createProposal({ id: 'proposal:atomic-fixture', kind: 'memory.add', target: { scope: 'shared' },
      patch: {}, evidence: [{ sessionId: 'fixture', sequence: 1, quote: 'evidence' }],
      prevalence: { occurrences: 1, sessions: 1, spanDays: 1, denominator: 1 }, confidence: 1, rationale: 'fixture' });
    await appendProposal(initial, env);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const first = appendBlockConditional('proposals', async () => {
      const current = (await readProposals(env))[0]!;
      expect(current.status).toBe('pending');
      entered();
      await gate;
      return { data: proposalBlockData(transitionProposal(current, 'accepted')), value: 'accepted' };
    }, env);
    await ready;
    let completed = false;
    const competingEnv = { ...env, RUST_CHAIN_ENABLED: competitorRust ? 'true' : 'false' };
    const competing = appendProposal(transitionProposal(initial, 'rejected'), competingEnv).then(() => { completed = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(completed).toBe(false);
    } finally { release(); }
    expect((await first).value).toBe('accepted');
    await competing;
    expect((await readProposals(env))[0]?.status).toBe('rejected');
  }, 20_000);

  it.skipIf((rust || competitorRust) && !hasNative)('does not append when the precondition refuses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-chain-precondition-'));
    const env = { ...process.env, MEMPHIS_DATA_DIR: root, MEMPHIS_HOME: root,
      RUST_CHAIN_ENABLED: rust ? 'true' : 'false', RUST_CHAIN_BRIDGE_PATH: bridge };
    await expect(appendBlockConditional('proposals', async () => { throw new Error('synthetic refusal'); }, env))
      .rejects.toThrow(/synthetic refusal/);
    expect(await readProposals(env)).toEqual([]);
  }, 20_000);

  it.skipIf((rust || competitorRust) && !hasNative)('keeps an ordinary append payload stable while waiting for the lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-chain-capture-'));
    const env = { ...process.env, MEMPHIS_DATA_DIR: root, MEMPHIS_HOME: root,
      RUST_CHAIN_ENABLED: rust ? 'true' : 'false', RUST_CHAIN_BRIDGE_PATH: bridge };
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const holder = appendBlockConditional('journal', async () => {
      entered(); await gate; return { value: undefined };
    }, env);
    await ready;
    const data = { type: 'journal', content: 'original', tags: ['original'] };
    const append = appendBlock('journal', data, { ...env, RUST_CHAIN_ENABLED: competitorRust ? 'true' : 'false' });
    data.content = 'changed'; data.tags.push('changed');
    release(); await holder; await append;
    const blocks = await exportChain('journal', env);
    expect(blocks.blocks[0]?.data.content).toBe('original');
    expect(blocks.blocks[0]?.data.tags).toEqual(['original']);
  }, 20_000);
});

it('native preflight refuses invalid existing blocks before executing the decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-invalid-native-chain-'));
  const fixture = join(root, 'bridge.cjs');
  writeFileSync(fixture, `module.exports = {
    chain_append: (_chain, block) => JSON.stringify({ok:true,data:{appended:true,chain:[JSON.parse(block)]}}),
    chain_validate: () => JSON.stringify({ok:true,data:{valid:false,errors:['synthetic invalid block']}}),
    chain_query: () => JSON.stringify({ok:true,data:{count:0,blocks:[]}})
  };`);
  const env = { ...process.env, MEMPHIS_DATA_DIR: root, MEMPHIS_HOME: root,
    RUST_CHAIN_ENABLED: 'true', RUST_CHAIN_BRIDGE_PATH: fixture };
  const p = createProposal({ id: 'proposal:invalid-fixture', kind: 'memory.add', target: { scope: 'shared' },
    patch: {}, evidence: [{ sessionId: 'fixture', sequence: 1, quote: 'evidence' }],
    prevalence: { occurrences: 1, sessions: 1, spanDays: 1, denominator: 1 }, confidence: 1, rationale: 'fixture' });
  await appendProposal(p, env);
  let invoked = false;
  await expect(appendBlockConditional('proposals', async () => {
    invoked = true;
    return { data: proposalBlockData(transitionProposal(p, 'accepted')), value: undefined };
  }, env)).rejects.toThrow(/preflight rejected block/);
  expect(invoked).toBe(false);
  // A JavaScript caller cannot disable preflight with an extra argument.
  await expect(Reflect.apply(appendBlockConditional, undefined, ['proposals', async () => {
    invoked = true;
    return { data: proposalBlockData(transitionProposal(p, 'accepted')), value: undefined };
  }, env, false])).rejects.toThrow(/preflight rejected block/);
  expect(invoked).toBe(false);
  expect((await readProposals(env))[0]?.status).toBe('pending');
});
