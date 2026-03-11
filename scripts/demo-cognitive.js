#!/usr/bin/env node
/**
 * Memphis v5 Demo Script
 * 
 * Showcases all cognitive features in an interactive demo
 * 
 * @usage node scripts/demo-cognitive.js
 */

import { ModelC_PredictivePatterns } from '../src/cognitive/model-c.js';
import { ModelE_MetaCognitiveReflection } from '../src/cognitive/model-e.js';
import { ModelD_CollectiveCoordination } from '../src/cognitive/model-d.js';
import { InsightGenerator } from '../src/cognitive/insight-generator.js';
import { ProactiveAssistant, ASSISTANT_PRESETS } from '../src/cognitive/proactive-assistant.js';
import type { Block } from '../src/memory/chain.js';

// Sample blocks for demo
const sampleBlocks: Block[] = [
  {
    index: 0,
    timestamp: '2026-03-10T10:00:00Z',
    chain: 'journal',
    data: {
      type: 'journal',
      content: 'Started working on Memphis v5 cognitive layer',
      tags: ['memphis-v5', 'cognitive', 'start'],
    },
    prev_hash: '0'.repeat(64),
    hash: 'abc123',
  },
  {
    index: 1,
    timestamp: '2026-03-10T12:00:00Z',
    chain: 'journal',
    data: {
      type: 'decision',
      content: 'Decided to port cognitive models from v3',
      tags: ['decision', 'architecture', 'porting'],
    },
    prev_hash: 'abc123',
    hash: 'def456',
  },
  {
    index: 2,
    timestamp: '2026-03-10T14:00:00Z',
    chain: 'journal',
    data: {
      type: 'journal',
      content: 'Implemented Model C - predictive patterns',
      tags: ['memphis-v5', 'cognitive', 'model-c'],
    },
    prev_hash: 'def456',
    hash: 'ghi789',
  },
  {
    index: 3,
    timestamp: '2026-03-10T16:00:00Z',
    chain: 'journal',
    data: {
      type: 'journal',
      content: 'Implemented Model E - meta-cognitive reflection',
      tags: ['memphis-v5', 'cognitive', 'model-e'],
    },
    prev_hash: 'ghi789',
    hash: 'jkl012',
  },
  {
    index: 4,
    timestamp: '2026-03-10T18:00:00Z',
    chain: 'journal',
    data: {
      type: 'ask',
      content: 'How to integrate with OpenClaw?',
      tags: ['question', 'openclaw', 'integration'],
    },
    prev_hash: 'jkl012',
    hash: 'mno345',
  },
];

async function demoModelC() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Model C — Predictive Patterns         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const modelC = new ModelC_PredictivePatterns(sampleBlocks);
  
  // Learn patterns
  const patterns = await modelC.learn();
  console.log(`✨ Learned ${patterns.length} new patterns\n`);

  // Generate predictions
  const context = {
    timeOfDay: new Date().getHours(),
    dayOfWeek: new Date().getDay(),
    tags: ['memphis-v5', 'cognitive'],
  };

  const predictions = modelC.predict(context);
  
  console.log('🔮 Predictions for current context:');
  for (const pred of predictions) {
    console.log(`  • ${pred.title} (${(pred.confidence * 100).toFixed(0)}% confidence)`);
    console.log(`    ${pred.reasoning}`);
  }

  // Stats
  const stats = modelC.getStats();
  console.log(`\n📊 Model C Stats:`);
  console.log(`  • Total patterns: ${stats.totalPatterns}`);
  console.log(`  • Avg occurrences: ${stats.avgOccurrences.toFixed(1)}`);
  console.log(`  • Avg accuracy: ${(stats.avgAccuracy * 100).toFixed(1)}%`);
}

async function demoModelE() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Model E — Meta-Cognitive Reflection   ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const modelE = new ModelE_MetaCognitiveReflection(sampleBlocks);

  // Daily reflection
  const daily = modelE.daily();
  console.log(modelE.format(daily));
}

async function demoModelD() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Model D — Collective Coordination     ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Create coordinator with Memphis + Watra
  const modelD = new ModelD_CollectiveCoordination({
    consensusThreshold: 0.6,
    votingTimeout: 300000,
    agents: [
      { id: 'memphis', name: 'Memphis', endpoint: '10.0.0.80', publicKey: 'key1', weight: 1.0 },
      { id: 'watra', name: 'Watra', endpoint: '10.0.0.22', publicKey: 'key2', weight: 0.8 },
    ],
  });

  // Create proposal
  const proposal = modelD.propose(
    'Start v5 development sprint',
    'Begin implementation of cognitive layer for Memphis v5',
    'memphis',
    'strategic'
  );
  console.log(`📝 Proposal created: "${proposal.title}"\n`);

  // Vote
  await modelD.vote(proposal.id, 'memphis', 'approve', 'Critical for v5 release');
  await modelD.vote(proposal.id, 'watra', 'approve', 'Ready to test');

  // Get result
  const result = modelD.getProposal(proposal.id)?.result;
  if (result) {
    console.log(`📊 Voting Result:`);
    console.log(`  • Approved: ${result.approved ? '✅' : '❌'}`);
    console.log(`  • Weighted score: ${(result.weightedScore * 100).toFixed(1)}%`);
    console.log(`  • Consensus: ${result.consensusReached ? '✅' : '❌'}`);
  }
}

async function demoInsightGenerator() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      Insight Generator — Full Report    ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const generator = new InsightGenerator(sampleBlocks);
  const report = await generator.generate();

  console.log(generator.format(report));
}

async function demoProactiveAssistant() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    Proactive Assistant — Demo Mode      ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const assistant = new ProactiveAssistant(sampleBlocks, ASSISTANT_PRESETS.balanced);
  
  const messages = await assistant.check();
  
  console.log(`📬 Generated ${messages.length} proactive message(s):\n`);
  
  for (const msg of messages) {
    console.log(`  ${msg.emoji} ${msg.title}`);
    console.log(`    ${msg.message}`);
    console.log('');
  }

  const status = assistant.getStatus();
  console.log(`🤖 Assistant Status:`);
  console.log(`  • Enabled: ${status.enabled}`);
  console.log(`  • Current mood: ${status.currentMood || 'unknown'}`);
  console.log(`  • Check interval: ${status.checkInterval}min`);
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║                                                        ║');
  console.log('║          🦞  MEMPHIS v5 — COGNITIVE DEMO  🦞          ║');
  console.log('║                                                        ║');
  console.log('║        "OpenClaw executes. Memphis remembers."        ║');
  console.log('║                                                        ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  try {
    await demoModelC();
    await demoModelE();
    await demoModelD();
    await demoInsightGenerator();
    await demoProactiveAssistant();

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║           ✅ Demo Complete!              ║');
    console.log('╚══════════════════════════════════════════╝\n');
    
    console.log('📊 Summary:');
    console.log('  • Model C: Predictive patterns ✅');
    console.log('  • Model E: Meta-cognitive reflection ✅');
    console.log('  • Model D: Collective coordination ✅');
    console.log('  • Insight Generator: Full reports ✅');
    console.log('  • Proactive Assistant: Smart messaging ✅');
    console.log('');
    console.log('🚀 Memphis v5 cognitive layer is ready!');
    console.log('');

  } catch (error) {
    console.error('❌ Demo failed:', error);
    process.exit(1);
  }
}

main();
