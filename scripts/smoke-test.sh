#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
TMP_HOME="$TMP_DIR/home"
TMP_WORK="$TMP_DIR/work"
BRIDGE_PATH="$TMP_DIR/bridge.cjs"
BOOTSTRAP_JSON="$TMP_DIR/bootstrap.json"
GUIDE_JSON="$TMP_DIR/guide.json"
DOCTOR_JSON="$TMP_DIR/doctor.json"
HEALTH_JSON="$TMP_DIR/health.json"
CHAT_JSON="$TMP_DIR/chat.json"
VAULT_JSON="$TMP_DIR/vault.json"
STORE_JSON="$TMP_DIR/store.json"
SEARCH_JSON="$TMP_DIR/search.json"

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

function ok(data) {
  return JSON.stringify({ ok: true, data });
}

function parseEnv(envJson) {
  try {
    return JSON.parse(envJson || '{}');
  } catch {
    return {};
  }
}

function dataDir(envJson, cwd) {
  const env = parseEnv(envJson);
  const raw =
    env.MEMPHIS_DATA_DIR ||
    process.env.MEMPHIS_DATA_DIR ||
    path.join(env.HOME || process.env.HOME || cwd, '.memphis');
  return path.resolve(cwd || process.cwd(), raw);
}

function normalizeChainName(input) {
  const aliases = {
    decision: 'decisions',
    case: 'cases',
    pattern: 'patterns',
    reflection: 'reflections',
  };
  return aliases[input] || input;
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
  pathsResolveDataDir: (envJson, cwd) => ok(dataDir(envJson, cwd)),
  pathsResolveVaultState: (envJson, cwd) => {
    const env = parseEnv(envJson);
    return ok(
      env.MEMPHIS_VAULT_STATE_PATH || path.join(dataDir(envJson, cwd), 'vault-state.json')
    );
  },
  pathsResolveVaultEntries: (envJson, cwd) => {
    const env = parseEnv(envJson);
    return ok(
      env.MEMPHIS_VAULT_ENTRIES_PATH || path.join(dataDir(envJson, cwd), 'vault-entries.json')
    );
  },
  pathsResolveChainsDir: (envJson, cwd) => ok(path.join(dataDir(envJson, cwd), 'chains')),
  pathsResolveChainPath: (envJson, cwd, chainName) =>
    ok(path.join(dataDir(envJson, cwd), 'chains', normalizeChainName(chainName))),
  pathsResolveEmbedIndex: (envJson, cwd) => ok(path.join(dataDir(envJson, cwd), 'embeddings.ndjson')),
  pathsResolveCaseIndex: (envJson, cwd) => ok(path.join(dataDir(envJson, cwd), 'case-index.sqlite')),
  pathsResolveDatabasePath: (envJson, cwd) => ok(path.join(dataDir(envJson, cwd), 'memphis.db')),
  pathsNormalizeChainName: (input) => ok(normalizeChainName(input)),
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
# The smoke is a test scenario, not a production install. The bootstrap
# wizard above (`onboarding wizard --profile dev-local --force`) writes
# template vault entries into the fresh tmpdir; the explicit `vault init`
# step further down then triggers the existing-entries guard
# (#279 hardening). Setting FORCE_REINIT=1 here lets the smoke wipe and
# re-initialize the test vault deliberately. Production operators NEVER
# set this flag silently — see docs/operator/FORCE-FLAGS.md.
export MEMPHIS_VAULT_FORCE_REINIT=1

run_cli() {
  (cd "$TMP_WORK" && "$ROOT_DIR/node_modules/.bin/tsx" "$ROOT_DIR/src/infra/cli/index.ts" "$@")
}

run_cli onboarding wizard --write --profile dev-local --out .env --force --json >"$BOOTSTRAP_JSON"

# S10-5 (#393) added a first-run gate on chat/ask/tui — without an
# `initialized-clean` record the smoke's `chat` invocation below exits 1
# with NOT_INITIALIZED instead of producing the canonical local-fallback
# acceptance turn. We can't run the full `memphis init --non-interactive`
# flow here because it initializes the real vault, conflicting with the
# explicit `vault init` step further down (and the mock bridge).
# Instead, write a minimal `initialized-clean` first-run record stub
# directly at the canonical path: <dataDir>/config/first-run.json.
mkdir -p "$MEMPHIS_DATA_DIR/config"
cat >"$MEMPHIS_DATA_DIR/config/first-run.json" <<'EOF'
{
  "schemaVersion": 1,
  "initializedAt": "2026-05-02T00:00:00.000Z",
  "mode": "minimal-baseline",
  "createdChains": [],
  "createdBlocks": 0,
  "summary": "smoke-test stub for first-run gate (S10-5 bypass)",
  "origin": "controlled-init"
}
EOF

run_cli guide --json >"$GUIDE_JSON"

set +e
run_cli doctor --json >"$DOCTOR_JSON"
DOCTOR_EXIT=$?
set -e
if [[ "$DOCTOR_EXIT" -ne 0 && "$DOCTOR_EXIT" -ne 1 ]]; then
  echo "doctor command failed unexpectedly with exit=$DOCTOR_EXIT"
  exit 1
fi

run_cli health --json >"$HEALTH_JSON"
run_cli chat --input "Memphis smoke acceptance chat" --json >"$CHAT_JSON"
run_cli vault init --passphrase StrongPassphrase!123 --recovery-question pet --recovery-answer nori --json >"$VAULT_JSON"
run_cli embed store --id smoke-note --value "Memphis remembers durable operator memory" --json >"$STORE_JSON"
run_cli embed search --query durable --top-k 5 --json >"$SEARCH_JSON"

node - "$BOOTSTRAP_JSON" "$GUIDE_JSON" "$DOCTOR_JSON" "$HEALTH_JSON" "$CHAT_JSON" "$VAULT_JSON" "$STORE_JSON" "$SEARCH_JSON" <<'EOF'
const fs = require('node:fs');

const [bootstrapPath, guidePath, doctorPath, healthPath, chatPath, vaultPath, storePath, searchPath] = process.argv.slice(2);

function read(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const bootstrap = read(bootstrapPath);
if (bootstrap.ok !== true || typeof bootstrap.write?.agentProfilePath !== 'string') {
  throw new Error('bootstrap did not write agent profile');
}

const guide = read(guidePath);
if (!Array.isArray(guide.sections) || !guide.sections.some((section) => section.title === 'Tools' && section.lines.some((line) => line.includes('memphis_recall')))) {
  throw new Error('guide does not expose runtime tools');
}

const doctor = read(doctorPath);
if (!Array.isArray(doctor.checks)) {
  throw new Error('doctor output missing checks');
}

const health = read(healthPath);
if (health.status !== 'ok') {
  throw new Error('health command did not report ok');
}

const chat = read(chatPath);
if (chat.providerUsed !== 'local-fallback' || typeof chat.output !== 'string' || !chat.output.includes('Memphis smoke acceptance chat')) {
  throw new Error('chat command did not complete canonical acceptance turn');
}

const vault = read(vaultPath);
if (vault.ok !== true || typeof vault.vault?.did !== 'string') {
  throw new Error('vault init did not return did');
}

const store = read(storePath);
if (store.ok !== true || store.data?.indexed !== true) {
  throw new Error('embed store did not write durable indexed memory');
}

const search = read(searchPath);
if (search.ok !== true || !Array.isArray(search.data?.hits) || search.data.hits[0]?.id !== store.data.memoryId) {
  throw new Error('embed search did not return stored memory');
}
EOF

echo "SMOKE_TEST_OK"
