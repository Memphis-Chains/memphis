#!/usr/bin/env node
/* global process, console */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const outDir = path.join(repoRoot, 'docs', 'api');
const tmpJsonPath = path.join(repoRoot, '.tmp', 'typedoc-api.json');


const cliCommands = [
  ['health', 'Local runtime health check.'],
  ['providers:health', 'Provider connectivity/health report.'],
  ['providers list', 'Configured providers.'],
  ['models list', 'Available models + capabilities.'],
  ['chat', 'Single-shot generation.'],
  ['ask', 'Session-aware generation with context memory.'],
  ['decide history|transition', 'Decision lifecycle history and transitions.'],
  ['infer', 'Infer decision signal from text.'],
  ['mcp serve|serve-once|serve-status|serve-stop', 'Native MCP transport lifecycle.'],
  ['onboarding wizard|bootstrap', 'Interactive/env bootstrap flows.'],
  ['chain import_json', 'Import chain blocks from JSON payload.'],
  ['vault init|add|get|list', 'Vault key/value lifecycle.'],
  ['embed store|search|reset', 'Embedding store and semantic search.'],
  ['completion <bash|zsh|fish>', 'Shell completion script generation.'],
  ['doctor', 'Runtime readiness checks.'],
  ['tui', 'Interactive terminal UI.'],
];

const httpEndpoints = [
  ['GET', '/health', 'Service health payload and dependency checks.'],
  ['GET', '/metrics', 'Prometheus metrics exposition.'],
  ['GET', '/v1/metrics', 'JSON metrics snapshot.'],
  ['GET', '/v1/providers/health', 'Provider health list.'],
  ['GET', '/v1/ops/status', 'Operational status summary.'],
  ['POST', '/v1/chat/generate', 'Generate model response.'],
  ['POST', '/v1/vault/init', 'Initialize vault state.'],
  ['POST', '/v1/vault/encrypt', 'Encrypt and persist vault entry.'],
  ['POST', '/v1/vault/decrypt', 'Decrypt a vault entry.'],
  ['GET', '/v1/vault/entries', 'List stored encrypted entries (+ integrity flag).'],
  ['GET', '/v1/sessions', 'List generation sessions.'],
  ['GET', '/v1/sessions/:sessionId/events', 'List generation events for a session.'],
];

function runTypeDoc() {
  mkdirSync(path.dirname(tmpJsonPath), { recursive: true });
  const cmd = [
    'npx typedoc',
    '--options typedoc.api.json',
    '--json',
    tmpJsonPath,
  ].join(' ');
  execSync(cmd, { stdio: 'pipe' });
}

function typeToString(t) {
  if (!t) return 'void';
  switch (t.type) {
    case 'intrinsic':
    case 'literal':
      return String(t.name ?? JSON.stringify(t.value));
    case 'reference': {
      const base = t.name || 'unknown';
      if (t.typeArguments?.length) return `${base}<${t.typeArguments.map(typeToString).join(', ')}>`;
      return base;
    }
    case 'array':
      return `${typeToString(t.elementType)}[]`;
    case 'union':
      return t.types.map(typeToString).join(' | ');
    case 'intersection':
      return t.types.map(typeToString).join(' & ');
    case 'reflection':
      return 'object';
    case 'tuple':
      return `[${(t.elements || []).map(typeToString).join(', ')}]`;
    case 'query':
      return `typeof ${typeToString(t.queryType)}`;
    case 'typeOperator':
      return `${t.operator} ${typeToString(t.target)}`;
    default:
      return t.name || t.type || 'unknown';
  }
}

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.sources?.[0]?.fileName) out.push(node);
  if (Array.isArray(node.children)) node.children.forEach((c) => walk(c, out));
  if (Array.isArray(node.signatures)) node.signatures.forEach((s) => walk(s, out));
  return out;
}

function collectApiByFile(project) {
  const all = walk(project, []);
  const map = new Map();
  for (const n of all) {
    const file = n.sources?.[0]?.fileName;
    if (!file || !file.startsWith('src/')) continue;
    if (!map.has(file)) map.set(file, []);
    map.get(file).push(n);
  }
  return map;
}

function extractSignatures(nodes) {
  const lines = [];
  const seen = new Set();
  for (const n of nodes || []) {
    const sigs = n.signatures || (n.kindString === 'Function' ? [n] : []);
    for (const s of sigs || []) {
      const params = (s.parameters || [])
        .map((p) => `${p.name}${p.flags?.isOptional ? '?' : ''}: ${typeToString(p.type)}`)
        .join(', ');
      const signature = `${s.name}(${params}): ${typeToString(s.type)}`;
      if (!seen.has(signature)) {
        seen.add(signature);
        lines.push(`- \`${signature}\``);
      }
    }
  }
  return lines.length ? lines.join('\n') : '- _No exported function signatures captured by TypeDoc._';
}

function writeDoc(relative, content) {
  const filePath = path.join(outDir, relative);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${content.trim()}\n`);
}

function groupedCoreDocs(byFile) {
  const groups = {
    'core/ask.md': ['src/core/ask-session-store.ts'],
    'core/chain.md': ['src/infra/storage/chain-adapter.ts'],
    'core/embed.md': ['src/infra/storage/rust-embed-adapter.ts'],
    'core/vault.md': ['src/infra/storage/rust-vault-adapter.ts'],
    'core/decision.md': [
      'src/core/decision-gate.ts',
      'src/core/decision-audit-log.ts',
      'src/core/decision-history-store.ts',
      'src/core/decision-lifecycle.ts',
    ],
    'core/errors.md': ['src/core/errors.ts', 'src/core/types.ts'],
  };

  const errorCodes = [
    'VALIDATION_ERROR',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_RATE_LIMIT',
    'CONFIG_ERROR',
    'INTERNAL_ERROR',
  ];

  for (const [target, files] of Object.entries(groups)) {
    const nodes = files.flatMap((f) => byFile.get(f) || []);
    const title = target.split('/').pop().replace('.md', '');
    const extra = target === 'core/errors.md'
      ? `\n## Error Codes\n${errorCodes.map((c) => `- \`${c}\``).join('\n')}\n`
      : '';

    writeDoc(
      target,
      `# Core API: ${title}\n\n## Signatures\n${extractSignatures(nodes)}\n\n## Examples\n\n\`\`\`ts\n// import from runtime modules and call with validated input\n\`\`\`\n${extra}`,
    );
  }
}

function writeCliDocs(byFile) {
  const files = {
    ask: ['src/core/ask-session-store.ts', 'src/infra/cli/index.ts'],
    chain: ['src/infra/cli/import-json.ts', 'src/infra/storage/chain-adapter.ts'],
    embed: ['src/infra/storage/rust-embed-adapter.ts', 'src/infra/cli/index.ts'],
    vault: ['src/infra/storage/rust-vault-adapter.ts', 'src/infra/storage/vault-entry-store.ts', 'src/infra/cli/index.ts'],
    mcp: ['src/bridges/mcp-native-gateway.ts', 'src/bridges/mcp-native-transport.ts', 'src/infra/cli/index.ts'],
    onboarding: ['src/infra/cli/onboarding-wizard.ts', 'src/infra/cli/index.ts'],
    providers: ['src/infra/cli/provider-capabilities.ts', 'src/infra/cli/index.ts'],
    health: ['src/infra/cli/index.ts', 'src/infra/http/health.ts'],
  };

  writeDoc(
    'cli/index.md',
    `# CLI API\n\n## Command Surface\n${cliCommands.map(([cmd, d]) => `- \`${cmd}\` — ${d}`).join('\n')}\n\n## Global Flags\n- \`--json\` structured output\n- \`--provider\`, \`--model\`, \`--strategy\` generation routing\n- \`--interactive\`/\`--tui\` terminal UX\n\n## Error Codes\nSee [../core/errors.md](../core/errors.md).`,
  );

  const examples = {
    ask: 'memphis-v4 ask --input "hello" --session demo',
    chain: 'memphis-v4 chain import_json --file ./blocks.json --write --confirm-write',
    embed: 'memphis-v4 embed search --query "onboarding" --top-k 5',
    vault: 'memphis-v4 vault add --key token --value secret',
    mcp: 'memphis-v4 mcp serve --port 8789',
    onboarding: 'memphis-v4 onboarding wizard --interactive --write --out .env',
    providers: 'memphis-v4 providers list',
    health: 'memphis-v4 health',
  };

  for (const [name, sourceFiles] of Object.entries(files)) {
    const nodes = sourceFiles.flatMap((f) => byFile.get(f) || []);
    writeDoc(
      `cli/${name}.md`,
      `# CLI: ${name}\n\n## Signatures\n${extractSignatures(nodes)}\n\n## Example\n\n\`\`\`bash\n${examples[name]}\n\`\`\``,
    );
  }
}

function writeHttpDocs(byFile) {
  const files = {
    health: ['src/infra/http/health.ts'],
    metrics: ['src/infra/http/server.ts'],
    chat: ['src/infra/http/routes/chat.ts'],
    ops: ['src/infra/http/server.ts'],
    providers: ['src/infra/http/server.ts'],
    vault: ['src/infra/http/server.ts', 'src/infra/storage/rust-vault-adapter.ts'],
    sessions: ['src/infra/http/server.ts', 'src/core/contracts/repository.ts'],
  };

  writeDoc(
    'http/index.md',
    `# HTTP API\n\n## Endpoints\n${httpEndpoints.map(([m, p, d]) => `- \`${m} ${p}\` — ${d}`).join('\n')}\n\n## Auth\nProtected endpoints require \`Authorization: Bearer $MEMPHIS_API_TOKEN\` when token is configured.\n\n## Error Codes\nHTTP handlers return structured errors with code/message/requestId. See [../core/errors.md](../core/errors.md).`,
  );

  for (const [name, sourceFiles] of Object.entries(files)) {
    const nodes = sourceFiles.flatMap((f) => byFile.get(f) || []);
    writeDoc(
      `http/${name}.md`,
      `# HTTP: ${name}\n\n## Signatures\n${extractSignatures(nodes)}\n\n## Example\n\n\`\`\`bash\ncurl -s http://127.0.0.1:8787${name === 'health' ? '/health' : '/v1/ops/status'}\n\`\`\``,
    );
  }
}

function writeIndex() {
  writeDoc(
    'index.md',
    `# Memphis v4 API Reference\n\nGenerated from TypeScript exports via TypeDoc + custom markdown renderer.\n\n## Sections\n- [CLI](./cli/index.md)\n- [HTTP](./http/index.md)\n- [Core](./core/ask.md)\n\n## Notes\n- Private/internal/protected members are excluded.\n- Test files are excluded.\n- Re-generate with \`npm run docs:api\`.`,
  );
}

function main() {
  rmSync(outDir, { recursive: true, force: true });
  runTypeDoc();
  const project = JSON.parse(readFileSync(tmpJsonPath, 'utf8'));
  const byFile = collectApiByFile(project);

  writeIndex();
  writeCliDocs(byFile);
  writeHttpDocs(byFile);
  groupedCoreDocs(byFile);

  rmSync(path.join(repoRoot, '.tmp'), { recursive: true, force: true });
  console.log('API docs generated in docs/api');
}

main();
