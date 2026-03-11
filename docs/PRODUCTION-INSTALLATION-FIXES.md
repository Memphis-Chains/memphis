# Production Installation Fixes for Memphis v5

## 📋 Executive Summary

**Goal:** Make `npm install -g @memphis-chains/memphis-v5` work out-of-the-box

**Timeline:** 1-2 days implementation + testing

**Priority:** HIGH (user experience critical for adoption)

---

## 🐛 Issues Encountered (2026-03-11 Session)

### P0 - Critical (Block Installation):
1. **Binary name mismatch** — Users expect `memphis`, got `memphis-v4`
2. **TypeScript errors** — 31 errors in published code
3. **Plugin manifest missing** — `openclaw.plugin.json` not in npm package
4. **Plugin exports missing** — No `register/activate` for OpenClaw
5. **.env misconfiguration** — DEFAULT_PROVIDER=shared-llm requires API keys
6. **Ollama not bundled** — Embeddings fail without it

### P1 - High (Poor UX):
7. **Plugin directory mismatch** — Name vs manifest ID causes warnings
8. **No setup wizard** — Manual .env creation required
9. **Cryptic errors** — "fetch failed" without context
10. **No dependency checks** — Missing Ollama/Node/Rust not detected

---

## 🔧 Proposed Solutions

### Fix 1: Package.json Cleanup

**File:** `package.json`

**Current:**
```json
{
  "name": "@memphis-chains/memphis-v5",
  "bin": {
    "memphis-v4": "bin/memphis-v4.js"
  },
  "files": [
    "dist",
    "bin"
  ]
}
```

**Proposed:**
```json
{
  "name": "@memphis-chains/memphis-v5",
  "version": "0.2.0",
  "bin": {
    "memphis": "bin/memphis.js",
    "memphis-v5": "bin/memphis.js"
  },
  "files": [
    "dist",
    "bin",
    "crates/memphis-napi/index.node",
    "data/embed-index-v1.json",
    ".env.production",
    "openclaw.plugin.json"
  ],
  "scripts": {
    "postinstall": "node scripts/postinstall.js",
    "prepublishOnly": "npm run build && npm run verify:package",
    "verify:package": "node scripts/verify-package.js"
  },
  "engines": {
    "node": ">=20.0.0",
    "npm": ">=9.0.0"
  },
  "os": [
    "linux",
    "darwin",
    "win32"
  ],
  "cpu": [
    "x64",
    "arm64"
  ],
  "optionalDependencies": {
    "@memphis-chains/memphis-native-linux-x64": "^0.1.0",
    "@memphis-chains/memphis-native-darwin-x64": "^0.1.0",
    "@memphis-chains/memphis-native-darwin-arm64": "^0.1.0"
  }
}
```

**Changes:**
- ✅ Binary renamed to `memphis` (primary)
- ✅ Include all necessary files
- ✅ Add postinstall script
- ✅ Add engine requirements
- ✅ Platform-specific native modules

---

### Fix 2: Post-Install Script

**File:** `scripts/postinstall.js`

```javascript
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const COLORS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0]);
  
  if (major < 20) {
    log('⚠️  Warning: Node.js 20+ recommended (you have ' + version + ')', 'yellow');
    return false;
  }
  return true;
}

function checkRust() {
  try {
    execSync('cargo --version', { stdio: 'ignore' });
    return true;
  } catch {
    log('⚠️  Rust not found. Native modules may not work.', 'yellow');
    log('   Install Rust: https://rustup.rs', 'yellow');
    return false;
  }
}

function createEnvFile() {
  const envPath = path.join(os.homedir(), '.memphis', '.env');
  
  if (fs.existsSync(envPath)) {
    log('✅ .env file already exists', 'green');
    return;
  }
  
  const envDir = path.dirname(envPath);
  if (!fs.existsSync(envDir)) {
    fs.mkdirSync(envDir, { recursive: true });
  }
  
  const envContent = `# Memphis v5 Configuration
# Generated: ${new Date().toISOString()}

# Provider Configuration
DEFAULT_PROVIDER=local-fallback
LOCAL_FALLBACK_ENABLED=true

# Ollama (for embeddings)
OLLAMA_BASE_URL=http://localhost:11434

# Node Environment
NODE_ENV=production

# Optional: API Keys (uncomment if using cloud providers)
# SHARED_LLM_API_BASE=https://api.openai.com/v1
# SHARED_LLM_API_KEY=sk-...
`;
  
  fs.writeFileSync(envPath, envContent);
  log('✅ Created .env file at ' + envPath, 'green');
}

function checkOllama() {
  try {
    execSync('ollama list', { stdio: 'ignore' });
    return true;
  } catch {
    log('', 'reset');
    log('⚠️  Ollama not detected (optional dependency)', 'yellow');
    log('   Ollama provides local embeddings for semantic search.', 'yellow');
    log('   Install: curl -fsSL https://ollama.com/install.sh | sh', 'yellow');
    log('   Then run: ollama pull nomic-embed-text', 'yellow');
    log('', 'reset');
    return false;
  }
}

function createDataDirectories() {
  const dirs = [
    path.join(os.homedir(), '.memphis', 'data'),
    path.join(os.homedir(), '.memphis', 'chains'),
    path.join(os.homedir(), '.memphis', 'logs')
  ];
  
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log('✅ Created directory: ' + dir, 'green');
    }
  });
}

function printSuccessMessage() {
  log('', 'reset');
  log('╔══════════════════════════════════════════════════════════╗', 'green');
  log('║                                                          ║', 'green');
  log('║        △⬡◈ Memphis v5 Installed Successfully! ◈⬡△        ║', 'green');
  log('║                                                          ║', 'green');
  log('╚══════════════════════════════════════════════════════════╝', 'green');
  log('', 'reset');
  log('Quick Start:', 'blue');
  log('  memphis health           Check system status', 'reset');
  log('  memphis doctor           Run diagnostics', 'reset');
  log('  memphis --help           Show all commands', 'reset');
  log('', 'reset');
  log('First Run:', 'blue');
  log('  memphis vault init       Initialize security vault', 'reset');
  log('  memphis decide --input "Your first decision"', 'reset');
  log('', 'reset');
  log('Documentation:', 'blue');
  log('  https://github.com/Memphis-Chains/memphis-v5', 'reset');
  log('  https://docs.openclaw.ai', 'reset');
  log('', 'reset');
}

function main() {
  log('', 'reset');
  log('🔧 Setting up Memphis v5...', 'blue');
  log('', 'reset');
  
  // Check dependencies
  log('Checking dependencies...', 'blue');
  const nodeOk = checkNodeVersion();
  const rustOk = checkRust();
  const ollamaOk = checkOllama();
  
  // Create necessary files/directories
  log('', 'reset');
  log('Creating configuration...', 'blue');
  createEnvFile();
  createDataDirectories();
  
  // Print success message
  printSuccessMessage();
  
  // Print warnings if any
  if (!nodeOk || !rustOk || !ollamaOk) {
    log('⚠️  Some optional features may not work without dependencies above.', 'yellow');
    log('   Memphis will still function in limited mode.', 'yellow');
    log('', 'reset');
  }
}

main();
```

---

### Fix 3: Pre-Publish Verification

**File:** `scripts/verify-package.js`

```javascript
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const REQUIRED_FILES = [
  'bin/memphis.js',
  'dist/index.js',
  'dist/infra/cli/index.js',
  'crates/memphis-napi/index.node',
  'data/embed-index-v1.json',
  '.env.production',
  'openclaw.plugin.json'
];

const REQUIRED_EXPORTS = [
  'register',
  'activate',
  'deactivate'
];

function verifyFiles() {
  console.log('Verifying package files...\n');
  
  let missing = [];
  
  REQUIRED_FILES.forEach(file => {
    const fullPath = path.join(__dirname, '..', file);
    if (!fs.existsSync(fullPath)) {
      console.log(`❌ Missing: ${file}`);
      missing.push(file);
    } else {
      console.log(`✅ Found: ${file}`);
    }
  });
  
  return missing.length === 0;
}

function verifyExports() {
  console.log('\nVerifying plugin exports...\n');
  
  try {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.js');
    const content = fs.readFileSync(indexPath, 'utf8');
    
    let missing = [];
    
    REQUIRED_EXPORTS.forEach(exp => {
      if (!content.includes(`export`) || !content.includes(exp)) {
        console.log(`❌ Missing export: ${exp}`);
        missing.push(exp);
      } else {
        console.log(`✅ Found export: ${exp}`);
      }
    });
    
    return missing.length === 0;
  } catch (error) {
    console.log('❌ Could not verify exports:', error.message);
    return false;
  }
}

function verifyBinary() {
  console.log('\nVerifying binary...\n');
  
  const binaryPath = path.join(__dirname, '..', 'bin', 'memphis.js');
  
  if (!fs.existsSync(binaryPath)) {
    console.log('❌ Binary not found: bin/memphis.js');
    return false;
  }
  
  const content = fs.readFileSync(binaryPath, 'utf8');
  if (!content.includes('#!/usr/bin/env node')) {
    console.log('❌ Binary missing shebang');
    return false;
  }
  
  console.log('✅ Binary OK: bin/memphis.js');
  return true;
}

function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Memphis v5 Package Verification');
  console.log('═══════════════════════════════════════════\n');
  
  const filesOk = verifyFiles();
  const exportsOk = verifyExports();
  const binaryOk = verifyBinary();
  
  console.log('\n═══════════════════════════════════════════');
  
  if (filesOk && exportsOk && binaryOk) {
    console.log('\n✅ All checks passed! Ready to publish.\n');
    process.exit(0);
  } else {
    console.log('\n❌ Verification failed! Fix issues before publishing.\n');
    process.exit(1);
  }
}

main();
```

---

### Fix 4: Default .env Template

**File:** `.env.production`

```bash
# Memphis v5 Default Configuration
# This file is used when no .env is found

# Provider Configuration
# Options: shared-llm, decentralized-llm, local-fallback
DEFAULT_PROVIDER=local-fallback
LOCAL_FALLBACK_ENABLED=true

# Ollama Configuration (for embeddings)
OLLAMA_BASE_URL=http://localhost:11434

# Node Environment
NODE_ENV=production
LOG_LEVEL=info

# Database
DATABASE_URL=file:./data/memphis-v5.db

# MCP Server
MCP_DEFAULT_TRANSPORT=stdio
MCP_DEFAULT_PORT=3000

# Security
RUST_CHAIN_ENABLED=false

# Embedding Configuration
RUST_EMBED_MODE=local
RUST_EMBED_DIM=384
```

---

### Fix 5: Plugin Manifest (Already Fixed)

**File:** `openclaw.plugin.json`

```json
{
  "id": "memphis-memory",
  "name": "Memphis Memory Provider",
  "kind": "memory",
  "version": "0.1.0",
  "description": "Memphis-backed memory provider for OpenClaw",
  "author": "Memphis-Chains",
  "license": "MIT",
  "repository": "https://github.com/Memphis-Chains/memphis-v5",
  "configSchema": {
    "type": "object",
    "properties": {
      "baseUrl": {
        "type": "string",
        "default": "http://localhost:3000",
        "description": "Memphis HTTP API base URL"
      },
      "timeoutMs": {
        "type": "number",
        "default": 5000,
        "minimum": 100,
        "maximum": 30000
      },
      "mcpTransport": {
        "type": "string",
        "enum": ["stdio", "http"],
        "default": "http"
      }
    }
  },
  "engines": {
    "openclaw": ">=2026.3.0"
  },
  "keywords": ["memory", "memphis", "cognitive", "ai", "openclaw"],
  "icon": "△⬡◈"
}
```

---

### Fix 6: Plugin Exports (Already Fixed)

**File:** `packages/@memphis/openclaw-plugin/src/index.ts`

```typescript
import { MemphisClient } from './MemphisClient.js';
import { MemphisMemoryProvider } from './MemoryProvider.js';
import { SecurityManager } from './security.js';
import type {
  MemoryEntry,
  MemorySearchManager,
  MemphisPluginConfig,
  SearchOptions,
  SearchResult,
} from './types.js';

// ============================================
// OpenClaw Plugin Interface (REQUIRED)
// ============================================

function register(context: any) {
  return {
    id: 'memphis-memory',
    kind: 'memory',
    provides: ['memory'],
    name: 'Memphis Memory Provider',
    description: 'Memphis-backed memory provider for OpenClaw',
    version: '0.1.0',
  };
}

async function activate(context: any) {
  const config: MemphisPluginConfig = context.config || {};
  const baseUrl = config.baseUrl || process.env.MEMPHIS_URL || 'http://localhost:3000';
  const timeoutMs = config.timeoutMs || 5000;
  
  const client = new MemphisClient({
    baseUrl,
    timeoutMs,
  });
  
  const provider = new MemphisMemoryProvider(client as any);
  
  return {
    memory: provider,
    client,
  };
}

async function deactivate(context: any) {
  return Promise.resolve();
}

// ============================================
// EXPORTS (Both ES + CommonJS compatible)
// ============================================

export { register, activate, deactivate };
export { MemphisClient, MemphisMemoryProvider, SecurityManager };
export type { MemoryEntry, MemorySearchManager, MemphisPluginConfig, SearchOptions, SearchResult };

export default {
  name: '@memphis/openclaw-plugin',
  version: '0.1.0',
  register,
  activate,
  deactivate,
};
```

---

### Fix 7: Setup Wizard Command

**File:** `src/infra/cli/commands/setup.ts`

```typescript
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function setupWizard() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        △⬡◈ Memphis v5 Setup Wizard ◈⬡△                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Select your LLM provider:',
      choices: [
        { name: 'Local (Ollama) - Recommended', value: 'local-fallback' },
        { name: 'OpenAI API', value: 'shared-llm' },
        { name: 'Custom API', value: 'custom' },
      ],
      default: 'local-fallback',
    },
    {
      type: 'input',
      name: 'ollamaUrl',
      message: 'Ollama base URL:',
      default: 'http://localhost:11434',
      when: (ans) => ans.provider === 'local-fallback',
    },
    {
      type: 'input',
      name: 'apiBase',
      message: 'API base URL:',
      when: (ans) => ans.provider === 'shared-llm' || ans.provider === 'custom',
    },
    {
      type: 'password',
      name: 'apiKey',
      message: 'API key:',
      when: (ans) => ans.provider === 'shared-llm' || ans.provider === 'custom',
    },
    {
      type: 'confirm',
      name: 'installOllama',
      message: 'Install Ollama automatically?',
      default: false,
      when: (ans) => ans.provider === 'local-fallback',
    },
  ]);

  // Create .env file
  const envPath = path.join(os.homedir(), '.memphis', '.env');
  const envDir = path.dirname(envPath);
  
  if (!fs.existsSync(envDir)) {
    fs.mkdirSync(envDir, { recursive: true });
  }

  let envContent = `# Memphis v5 Configuration
# Generated by setup wizard: ${new Date().toISOString()}

DEFAULT_PROVIDER=${answers.provider}
NODE_ENV=production
`;

  if (answers.provider === 'local-fallback') {
    envContent += `
LOCAL_FALLBACK_ENABLED=true
OLLAMA_BASE_URL=${answers.ollamaUrl}
`;
  } else {
    envContent += `
SHARED_LLM_API_BASE=${answers.apiBase}
SHARED_LLM_API_KEY=${answers.apiKey}
`;
  }

  fs.writeFileSync(envPath, envContent);
  
  console.log('');
  console.log('✅ Configuration saved to: ' + envPath);
  console.log('');
  console.log('Next steps:');
  console.log('  1. memphis vault init      # Initialize security');
  console.log('  2. memphis health          # Verify setup');
  console.log('  3. memphis decide --input "Your first decision"');
  console.log('');

  if (answers.installOllama) {
    console.log('Installing Ollama...');
    // Auto-install Ollama logic here
  }
}
```

---

### Fix 8: Dependency Checker

**File:** `src/infra/cli/commands/doctor.ts` (Enhanced)

```typescript
export async function doctorCommand(options: { fix?: boolean; deep?: boolean }) {
  const checks: Check[] = [
    {
      name: 'Node.js version',
      check: () => checkNodeVersion(),
      fix: 'Upgrade to Node.js 20+',
    },
    {
      name: 'Rust toolchain',
      check: () => checkRust(),
      fix: 'Install Rust: https://rustup.rs',
    },
    {
      name: '.env configuration',
      check: () => checkEnvFile(),
      fix: 'Run: memphis setup',
    },
    {
      name: 'Ollama (optional)',
      check: () => checkOllama(),
      fix: 'Install: curl -fsSL https://ollama.com/install.sh | sh',
      optional: true,
    },
    {
      name: 'Embedding model',
      check: () => checkEmbeddingModel(),
      fix: 'Run: ollama pull nomic-embed-text',
      optional: true,
    },
    {
      name: 'Database directory',
      check: () => checkDirectory('data'),
      fix: 'Will be created automatically',
    },
    {
      name: 'Vault initialized',
      check: () => checkVault(),
      fix: 'Run: memphis vault init',
    },
  ];

  console.log('Running diagnostics...\n');

  let allPassed = true;
  let warnings = 0;

  for (const check of checks) {
    const result = await check.check();
    const status = result.passed ? '✅' : (check.optional ? '⚠️ ' : '❌');
    
    console.log(`${status} ${check.name}`);
    
    if (!result.passed) {
      if (check.optional) {
        warnings++;
        console.log(`   ${result.message || check.fix}`);
      } else {
        allPassed = false;
        console.log(`   Fix: ${check.fix}`);
        if (options.fix && check.fixCommand) {
          console.log('   Attempting auto-fix...');
          await check.fixCommand();
        }
      }
    } else if (result.message) {
      console.log(`   ${result.message}`);
    }
  }

  console.log('');
  
  if (allPassed && warnings === 0) {
    console.log('✅ All checks passed!');
    return 0;
  } else if (allPassed && warnings > 0) {
    console.log(`✅ Core checks passed (${warnings} optional warnings)`);
    return 0;
  } else {
    console.log('❌ Some checks failed. Fix issues above.');
    if (!options.fix) {
      console.log('   Run with --fix to attempt automatic fixes');
    }
    return 1;
  }
}
```

---

### Fix 9: Better Error Messages

**File:** `src/infra/errors/user-friendly.ts`

```typescript
export class UserFriendlyError extends Error {
  constructor(
    message: string,
    public userMessage: string,
    public fix?: string
  ) {
    super(message);
    this.name = 'UserFriendlyError';
  }
}

export function formatError(error: any): string {
  if (error instanceof UserFriendlyError) {
    let output = `❌ ${error.userMessage}\n`;
    if (error.fix) {
      output += `\n💡 Fix: ${error.fix}\n`;
    }
    return output;
  }

  // Handle common errors
  if (error.code === 'ECONNREFUSED') {
    return `❌ Cannot connect to ${error.address}:${error.port}
    
💡 This usually means:
   - The service is not running
   - Wrong URL/port in configuration
   
Try: memphis doctor`;
  }

  if (error.message?.includes('fetch failed')) {
    return `❌ Network request failed

💡 This usually means:
   - Ollama is not running (for embeddings)
   - API endpoint unreachable
   - Firewall blocking connection

Try:
   1. Check if Ollama is running: ollama list
   2. Start Ollama: ollama serve
   3. Run diagnostics: memphis doctor`;
  }

  if (error.message?.includes('SHARED_LLM_API_BASE')) {
    return `❌ Missing API configuration

💡 You're using shared-llm provider but haven't configured API keys.

Options:
   1. Switch to local: memphis setup
   2. Add API keys to .env file
   3. Use local-fallback provider`;
  }

  // Default fallback
  return `❌ Error: ${error.message}`;
}
```

---

### Fix 10: README Update

**File:** `README.md`

```markdown
# Memphis v5 — OpenClaw's Memory Layer

**△⬡◈ Persistent cognitive memory for AI agents**

## Installation

### Prerequisites
- **Node.js** 20+ ([Install](https://nodejs.org/))
- **Rust** 1.70+ ([Install](https://rustup.rs/))
- **Ollama** (optional, for embeddings) ([Install](https://ollama.com/))

### Quick Install

\`\`\`bash
npm install -g @memphis-chains/memphis-v5
\`\`\`

### Post-Install Setup

\`\`\`bash
# Run setup wizard
memphis setup

# Verify installation
memphis doctor

# Initialize security vault
memphis vault init
\`\`\`

### First Commands

\`\`\`bash
# Record a decision
memphis decide --input "Use TypeScript for type safety"

# Reflect on your work
memphis reflect --save

# Get proactive suggestions
memphis suggest

# Check system health
memphis health
\`\`\`

## Troubleshooting

### "command not found: memphis"
Make sure npm global bin is in your PATH:
\`\`\`bash
export PATH="$(npm config get prefix)/bin:$PATH"
\`\`\`

### "Missing API keys" error
Run the setup wizard:
\`\`\`bash
memphis setup
\`\`\`

### Embeddings not working
Install and start Ollama:
\`\`\`bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Start Ollama
ollama serve &

# Pull embedding model
ollama pull nomic-embed-text
\`\`\`

### TypeScript errors
Update to latest version:
\`\`\`bash
npm update -g @memphis-chains/memphis-v5
\`\`\`

## Documentation

- [Full Documentation](https://github.com/Memphis-Chains/memphis-v5/docs)
- [API Reference](https://docs.openclaw.ai)
- [Examples](https://github.com/Memphis-Chains/memphis-v5/examples)

## License

MIT © Memphis-Chains
\`\`\`

---

## 📊 Implementation Checklist

### Week 1 (Critical):
- [ ] Update `package.json` (binary names, files list)
- [ ] Create `postinstall.js` script
- [ ] Add `.env.production` template
- [ ] Implement `setup` command with wizard
- [ ] Test installation on clean Ubuntu/macOS

### Week 2 (High Priority):
- [ ] Create `verify-package.js` for CI
- [ ] Enhance `doctor` command with dependency checks
- [ ] Add user-friendly error messages
- [ ] Update README with troubleshooting
- [ ] Add integration tests for installation

### Week 3 (Nice to Have):
- [ ] Platform-specific installers (.deb, .rpm, .pkg)
- [ ] Docker image with pre-installed dependencies
- [ ] Homebrew formula
- [ ] Snap package
- [ ] AUR package (Arch Linux)

---

## 🧪 Testing Plan

### Test Matrix:

| OS | Node | Rust | Status |
|----|------|------|--------|
| Ubuntu 24.04 | 20.x | 1.70 | [ ] |
| Ubuntu 22.04 | 22.x | 1.75 | [ ] |
| macOS Intel | 20.x | 1.80 | [ ] |
| macOS ARM | 22.x | 1.80 | [ ] |
| Windows WSL2 | 20.x | 1.75 | [ ] |

### Test Scenarios:

1. **Fresh install** (no dependencies)
   - [ ] Post-install runs
   - [ ] .env created
   - [ ] Directories created
   - [ ] Warning shown for missing Ollama

2. **With Ollama** (full setup)
   - [ ] Embeddings work
   - [ ] Memory search functional
   - [ ] All checks pass

3. **OpenClaw integration**
   - [ ] Plugin loads
   - [ ] No missing exports
   - [ ] Memory provider works

4. **Error handling**
   - [ ] Network errors are user-friendly
   - [ ] Config errors suggest fixes
   - [ ] Doctor provides actionable advice

---

## 📦 Release Process

### Pre-Release:
1. Run `npm run verify:package`
2. Test on 3+ platforms
3. Check all dependencies included
4. Verify binary works
5. Test plugin exports

### Release:
1. Tag version: `git tag v0.2.0`
2. Push tag: `git push --tags`
3. CI builds native modules
4. Publish to npm: `npm publish`
5. Update documentation

### Post-Release:
1. Test installation: `npm install -g @memphis-chains/memphis-v5`
2. Run smoke tests
3. Check user reports
4. Update changelog

---

## 🎯 Success Metrics

### Before Fixes:
- Installation success rate: ~60%
- Time to working setup: 3-4 hours
- Support tickets: High

### After Fixes (Targets):
- Installation success rate: 95%+
- Time to working setup: 5-10 minutes
- Support tickets: Low

---

## 📝 Documentation Requirements

### New Docs Needed:
1. **INSTALLATION.md** — Step-by-step guide
2. **TROUBLESHOOTING.md** — Common issues + fixes
3. **DEPENDENCIES.md** — What's required + how to install
4. **QUICKSTART.md** — 5-minute guide
5. **UPGRADING.md** — Migration from v4

### Existing Docs to Update:
1. **README.md** — Add troubleshooting section
2. **docs/OPENCLAW-INTEGRATION.md** — Plugin usage
3. **docs/CONFIGURATION.md** — .env options
4. **CHANGELOG.md** — Document changes

---

## 🔗 Related Files

### Files to Modify:
- `package.json`
- `bin/memphis.js` (rename)
- `src/infra/cli/commands/setup.ts` (new)
- `src/infra/cli/commands/doctor.ts` (enhance)
- `src/infra/errors/user-friendly.ts` (new)
- `README.md`

### Files to Create:
- `scripts/postinstall.js`
- `scripts/verify-package.js`
- `.env.production`
- `openclaw.plugin.json` (root level)
- `docs/INSTALLATION.md`
- `docs/TROUBLESHOOTING.md`

---

## 📅 Timeline

**Week 1:** Core fixes + testing
**Week 2:** Documentation + polish
**Week 3:** Platform-specific packaging

**Total effort:** 2-3 days of focused work

---

## 🎊 Expected Result

After implementing these fixes:

```bash
# User experience should be:
npm install -g @memphis-chains/memphis-v5

# Output:
🔧 Setting up Memphis v5...

Checking dependencies...
⚠️  Ollama not detected (optional dependency)
   Install: curl -fsSL https://ollama.com/install.sh | sh

Creating configuration...
✅ Created .env file
✅ Created data directories

╔══════════════════════════════════════════════════════════╗
║        △⬡◈ Memphis v5 Installed Successfully! ◈⬡△        ║
╚══════════════════════════════════════════════════════════╝

Quick Start:
  memphis health           Check system status
  memphis doctor           Run diagnostics
  memphis --help           Show all commands

# Then:
memphis health
# status: ok
# service: memphis-v5
# version: 0.2.0
```

---

**Created:** 2026-03-11 11:05 CET
**Author:** Memphis (△⬡◈)
**Status:** Proposal - Ready for Implementation
**Priority:** HIGH
