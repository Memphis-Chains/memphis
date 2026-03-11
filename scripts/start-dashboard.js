#!/usr/bin/env node
/**
 * Start Memphis Web Dashboard
 * 
 * @usage memphis dashboard [--port 3131]
 */

import { createDashboard } from '../dashboard/web-dashboard.js';

const args = process.argv.slice(2);
const portArg = args.find(a => a.startsWith('--port'));
const port = portArg ? parseInt(portArg.split('=')[1] || portArg) : 3131;

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║     🦞 Memphis Web Dashboard v5         ║');
console.log('╚══════════════════════════════════════════╝');
console.log('');

// Sample data for demo
const sampleBlocks = [
  {
    index: 0,
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    chain: 'journal',
    data: { type: 'journal', content: 'Working on Memphis v5', tags: ['memphis-v5', 'work'] },
  },
  {
    index: 1,
    timestamp: new Date(Date.now() - 1800000).toISOString(),
    chain: 'decision',
    data: { type: 'decision', content: 'Port cognitive models', tags: ['decision', 'cognitive'] },
  },
  {
    index: 2,
    timestamp: new Date().toISOString(),
    chain: 'journal',
    data: { type: 'journal', content: 'Dashboard complete', tags: ['memphis-v5', 'dashboard'] },
  },
];

const dashboard = createDashboard(sampleBlocks, { port });

dashboard.start().then(() => {
  console.log(`✅ Dashboard running at ${dashboard.getUrl()}`);
  console.log('');
  console.log('📊 Features:');
  console.log('  • Real-time stats');
  console.log('  • Cognitive insights');
  console.log('  • Predictive patterns');
  console.log('  • Quick wins');
  console.log('  • Mood tracking');
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');
}).catch(error => {
  console.error('❌ Failed to start dashboard:', error);
  process.exit(1);
});

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Stopping dashboard...');
  await dashboard.stop();
  process.exit(0);
});
