#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
TMP_HOME="$TMP_DIR/home"
TMP_WORK="$TMP_DIR/work"
BRIDGE_PATH="$TMP_DIR/bridge.cjs"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_HOME" "$TMP_WORK" "$TMP_WORK/data"

cat >"$BRIDGE_PATH" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const rowStorePath = path.join(process.env.MEMPHIS_DATA_DIR || process.cwd(), 'smoke-rows.json');

function loadRows() {
  try {
    return JSON.parse(fs.readFileSync(rowStorePath, 'utf8'));
  } catch {
    return [];
  }
}

function saveRows(rows) {
  fs.mkdirSync(path.dirname(rowStorePath), { recursive: true });
  fs.writeFileSync(rowStorePath, JSON.stringify(rows), 'utf8');
}

module.exports = {
  chain_append: (chainJson, blockJson) => {
    const chain = JSON.parse(chainJson);
    const block = JSON.parse(blockJson);
    return JSON.stringify({
      ok: true,
      data: { appended: true, length: chain.length + 1, chain: [...chain, block] },
    });
  },
  chain_validate: () => JSON.stringify({ ok: true, data: { valid: true, errors: [] } }),
  chain_query: (chainJson, contains, tag) => {
    const chain = JSON.parse(chainJson);
    const blocks = chain.filter((block) => {
      const content = String(block?.data?.content ?? '');
      const tags = Array.isArray(block?.data?.tags) ? block.data.tags : [];
      return (!contains || content.includes(contains)) && (!tag || tags.includes(tag));
    });
    return JSON.stringify({ ok: true, data: { count: blocks.length, blocks } });
  },
  embed_reset: () => {
    saveRows([]);
    return JSON.stringify({ ok: true, data: { cleared: true } });
  },
  embed_store: (id, text) => {
    const rows = loadRows().filter((row) => row.id !== id);
    rows.push({ id, text });
    saveRows(rows);
    return JSON.stringify({ ok: true, data: { id, count: rows.length, dim: 32, provider: 'smoke-bridge' } });
  },
  embed_search: (query, topK = 5) => {
    const hits = loadRows()
      .filter((row) => row.text.toLowerCase().includes(String(query).toLowerCase()))
      .slice(0, topK)
      .map((row, index) => ({ id: row.id, score: 0.99 - index * 0.01, text_preview: row.text.slice(0, 80) }));
    return JSON.stringify({ ok: true, data: { query, count: hits.length, hits } });
  },
  vaultInitFull: (passphrase, question) => ({
    vault: {
      salt: Buffer.from('salt-salt-salt-1234'),
      master_key: Buffer.from(passphrase.padEnd(32, '!').slice(0, 32)),
    },
    did: 'did:memphis:smoke',
    qa_question: question,
  }),
  vaultStore: (_vault, key, plaintext) => ({
    id: 'entry-' + key,
    key,
    ciphertext: Buffer.from(plaintext),
    nonce: Buffer.from('nonce-123456789012'),
    tag: Buffer.from('tag-123456789012'),
    createdAt: new Date().toISOString(),
  }),
  vaultRetrieve: (_vault, entry) => Buffer.from(entry.ciphertext),
};
EOF

export HOME="$TMP_HOME"
export NODE_ENV=test
export DEFAULT_PROVIDER=local-fallback
export MEMPHIS_DATA_DIR="$TMP_WORK/.memphis"
export MEMPHIS_VAULT_STATE_PATH="$TMP_WORK/data/vault-state.json"
export MEMPHIS_VAULT_PEPPER="memphis-0123456789abcdef0123456789abcdef"
export RUST_CHAIN_ENABLED=true
export RUST_CHAIN_BRIDGE_PATH="$BRIDGE_PATH"

run_cli() {
  (cd "$TMP_WORK" && "$ROOT_DIR/node_modules/.bin/tsx" "$ROOT_DIR/src/infra/cli/index.ts" "$@")
}

run_cli onboarding wizard --write --profile dev-local --out .env --force --json >/tmp/memphis-smoke-bootstrap.json
run_cli guide --json >/tmp/memphis-smoke-guide.json

set +e
run_cli doctor --json >/tmp/memphis-smoke-doctor.json
DOCTOR_EXIT=$?
set -e
if [[ "$DOCTOR_EXIT" -ne 0 && "$DOCTOR_EXIT" -ne 1 ]]; then
  echo "doctor command failed unexpectedly with exit=$DOCTOR_EXIT"
  exit 1
fi

run_cli health --json >/tmp/memphis-smoke-health.json
run_cli chat --input "Memphis smoke acceptance chat" --json >/tmp/memphis-smoke-chat.json
run_cli vault init --passphrase StrongPassphrase!123 --recovery-question pet --recovery-answer nori --json >/tmp/memphis-smoke-vault.json
run_cli embed store --id smoke-note --value "Memphis remembers durable operator memory" --json >/tmp/memphis-smoke-store.json
run_cli embed search --query durable --top-k 5 --json >/tmp/memphis-smoke-search.json

node <<'EOF'
const fs = require('node:fs');

function read(name) {
  return JSON.parse(fs.readFileSync(`/tmp/memphis-smoke-${name}.json`, 'utf8'));
}

const bootstrap = read('bootstrap');
if (bootstrap.ok !== true || typeof bootstrap.write?.agentProfilePath !== 'string') {
  throw new Error('bootstrap did not write agent profile');
}

const guide = read('guide');
if (!Array.isArray(guide.sections) || !guide.sections.some((section) => section.title === 'Tools' && section.lines.some((line) => line.includes('memphis_recall')))) {
  throw new Error('guide does not expose runtime tools');
}

const doctor = read('doctor');
if (!Array.isArray(doctor.checks)) {
  throw new Error('doctor output missing checks');
}

const health = read('health');
if (health.status !== 'ok') {
  throw new Error('health command did not report ok');
}

const chat = read('chat');
if (chat.providerUsed !== 'local-fallback' || typeof chat.output !== 'string' || !chat.output.includes('Memphis smoke acceptance chat')) {
  throw new Error('chat command did not complete canonical acceptance turn');
}

const vault = read('vault');
if (vault.ok !== true || typeof vault.vault?.did !== 'string') {
  throw new Error('vault init did not return did');
}

const store = read('store');
if (store.ok !== true || store.data?.indexed !== true) {
  throw new Error('embed store did not write durable indexed memory');
}

const search = read('search');
if (search.ok !== true || !Array.isArray(search.data?.hits) || search.data.hits[0]?.id !== store.data.memoryId) {
  throw new Error('embed search did not return stored memory');
}
EOF

echo "SMOKE_TEST_OK"
