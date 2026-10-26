import { loadSoulManifest } from '../src/soul/manifest.js';
import { generateSoulManifest } from '../src/soul/manifest.js';
const env = { ...process.env } as NodeJS.ProcessEnv;
const m = loadSoulManifest(env) ?? generateSoulManifest(env);
const tools = m.capabilities.tools;
console.log(JSON.stringify({
  total: tools.length,
  vault_list_present: tools.includes('memphis_vault_list'),
  sample: tools.slice(0, 5),
}, null, 2));
