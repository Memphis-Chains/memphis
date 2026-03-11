# Production Installation Improvements Plan

**Date:** 2026-03-11
**Status:** 🚧 IN PROGRESS
**Target Version:** v0.3.0-beta

---

## 📋 Issues Encountered

Based on today's debugging session, here are the installation issues identified:

### 🔴 CRITICAL (Blockers)

| # | Issue | Impact | Status |
|---|-------|--------|--------|
| 1 | Binary name mismatch | Users can't run `memphis` command | 🔄 Agent 1 |
| 2 | TypeScript errors (31 errors) | Build fails | 🔄 Agent 1 |
| 3 | Plugin manifest missing | Plugin not detected by OpenClaw | 🔄 Agent 1 |
| 4 | Plugin exports missing | Plugin can't register/activate | 🔄 Agent 2 |
| 5 | .env misconfiguration | Requires API keys that may not exist | 🔄 Agent 2 |
| 6 | Ollama not bundled | Missing dependency | 🔄 Agent 2 |

### 🟡 MEDIUM (Friction)

| # | Issue | Impact | Status |
|---|-------|--------|--------|
| 7 | Plugin directory mismatch | Confusion in installation | 🔄 Agent 3 |
| 8 | No setup wizard | Manual .env creation | 🔄 Agent 3 |
| 9 | Poor error messages | Cryptic failures | 🔄 Agent 4 |
| 10 | No dependency checks | Missing tools not detected | 🔄 Agent 4 |

---

## 🔧 Proposed Fixes

### CRITICAL FIXES

#### 1. Binary Name Mismatch

**Problem:** Binary built as `memphis-v4` but referenced as `memphis`

**Solution:**
```json
// package.json
{
  "name": "@memphis-chains/memphis-v5",
  "bin": {
    "memphis": "./dist/cli.js"
  }
}
```

**Files to update:**
- `package.json` (bin field)
- `Cargo.toml` ([[bin]] name if Rust binary)
- `README.md` (all examples)
- Installation scripts

**Validation:**
```bash
npm run build
npm link
which memphis  # Should return path to memphis binary
memphis --version  # Should work
```

---

#### 2. TypeScript Errors (31 errors)

**Problem:** Outdated code causing TypeScript compilation errors

**Solution:**
- Run: `npm run typecheck`
- Fix all errors systematically
- Update type definitions
- Ensure strict mode compatibility

**Common fixes:**
- Add missing type annotations
- Fix type mismatches
- Update deprecated APIs
- Add proper null/undefined checks

**Validation:**
```bash
npm run typecheck  # Must exit 0
```

---

#### 3. Plugin Manifest Missing

**Problem:** `openclaw.plugin.json` not included in dist

**Solution:**
```json
// packages/@memphis/openclaw-plugin/package.json
{
  "files": [
    "dist",
    "openclaw.plugin.json",
    "README.md"
  ],
  "scripts": {
    "build": "tsc && cp openclaw.plugin.json dist/"
  }
}
```

**Manifest structure:**
```json
{
  "id": "@memphis/openclaw-plugin",
  "name": "Memphis Cognitive Engine",
  "version": "0.3.0-beta",
  "main": "dist/index.js",
  "description": "Memory and cognitive capabilities for OpenClaw",
  "author": "Memphis Chains",
  "license": "MIT",
  "keywords": ["memphis", "cognitive", "memory", "openclaw"],
  "engines": {
    "openclaw": ">=1.0.0"
  }
}
```

**Validation:**
```bash
npm run build
ls packages/@memphis/openclaw-plugin/dist/openclaw.plugin.json  # Must exist
```

---

#### 4. Plugin Exports Missing

**Problem:** No `register`/`activate` functions in plugin

**Solution:**
```typescript
// packages/@memphis/openclaw-plugin/src/index.ts

import type { PluginContext, PluginConfig } from './types';

/**
 * Register plugin with OpenClaw
 */
export async function register(context: PluginContext): Promise<void> {
  // Initialize Memphis engine
  // Register commands
  // Setup memory chains
  context.logger.info('Memphis plugin registered');
}

/**
 * Activate plugin with configuration
 */
export async function activate(config: PluginConfig): Promise<void> {
  // Start Memphis engine
  // Load chains
  // Initialize providers
  // Start background services
}

/**
 * Deactivate plugin
 */
export async function deactivate(): Promise<void> {
  // Save state
  // Close connections
  // Cleanup resources
}

/**
 * Get plugin status
 */
export function getStatus(): PluginStatus {
  return {
    active: true,
    chains: getChainCount(),
    embeddings: getEmbeddingCount(),
    lastActivity: getLastActivityTime()
  };
}
```

**Validation:**
```bash
npm run build
node -e "const plugin = require('./packages/@memphis/openclaw-plugin/dist'); console.log(typeof plugin.register, typeof plugin.activate)"
# Should output: function function
```

---

#### 5. .env Misconfiguration

**Problem:** DEFAULT_PROVIDER requires API keys that may not exist

**Solution:**

**Updated `.env.example`:**
```env
# Memphis Configuration
# =====================

# Default provider (ollama, openai, anthropic)
# Default: ollama (no API key required)
DEFAULT_PROVIDER=ollama

# Ollama Configuration (default provider)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=nomic-embed-text

# Optional: API Keys for other providers
# Uncomment and fill if using these providers
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...

# Memory Configuration
MEMPHIS_DATA_DIR=~/.memphis
MEMPHIS_CHAINS_DIR=~/.memphis/chains
MEMPHIS_EMBEDDINGS_DIR=~/.memphis/embeddings

# Security (optional, generated automatically)
# MEMPHIS_VAULT_PEPPER=your-secure-pepper-here

# Sync Configuration (optional)
# MEMPHIS_SYNC_ENABLED=false
# MEMPHIS_SYNC_PEERS=10.0.0.22:8765,10.0.0.25:8765

# Logging
LOG_LEVEL=info
```

**Graceful fallback logic:**
```typescript
// src/core/config/provider.ts
export function getDefaultProvider(): Provider {
  const provider = process.env.DEFAULT_PROVIDER || 'ollama';
  
  // If using non-ollama provider, check for API key
  if (provider !== 'ollama') {
    const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
    if (!apiKey) {
      console.warn(`⚠️  DEFAULT_PROVIDER=${provider} but no API key found.`);
      console.warn(`   Falling back to ollama. To use ${provider}, set ${provider.toUpperCase()}_API_KEY.`);
      return 'ollama';
    }
  }
  
  return provider;
}
```

**Validation:**
```bash
# Should work without any .env file
rm .env
memphis health  # Should use defaults
```

---

#### 6. Ollama Not Bundled

**Problem:** Dependency not installed or checked

**Solution:**

**Update `package.json`:**
```json
{
  "peerDependencies": {
    "ollama": ">=0.1.0"
  },
  "peerDependenciesMeta": {
    "ollama": {
      "optional": true
    }
  },
  "scripts": {
    "postinstall": "node scripts/check-ollama.js"
  }
}
```

**Create check script:**
```javascript
// scripts/check-ollama.js
const { execSync } = require('child_process');

console.log('🔍 Checking Ollama installation...\n');

try {
  // Check if Ollama is installed
  const version = execSync('ollama --version', { encoding: 'utf-8' });
  console.log('✅ Ollama found:', version.trim());
  
  // Check if Ollama is running
  try {
    execSync('curl -s http://localhost:11434/api/tags', { stdio: 'ignore' });
    console.log('✅ Ollama server running\n');
  } catch {
    console.log('⚠️  Ollama installed but server not running');
    console.log('   Start with: ollama serve\n');
  }
} catch {
  console.log('⚠️  Ollama not found');
  console.log('\n📦 Install Ollama:');
  console.log('   curl -fsSL https://ollama.ai/install.sh | sh\n');
  console.log('   Or visit: https://ollama.ai\n');
}
```

**Add to README:**
```markdown
## Prerequisites

### Required
- Node.js >= 18
- Ollama (for embeddings)

### Install Ollama
\`\`\`bash
# Linux/macOS
curl -fsSL https://ollama.ai/install.sh | sh

# Start server
ollama serve

# Pull embedding model
ollama pull nomic-embed-text
\`\`\`
```

**Validation:**
```bash
npm install  # Should check for Ollama
memphis health  # Should detect missing Ollama gracefully
```

---

### MEDIUM FIXES

#### 7. Plugin Directory Mismatch

**Problem:** Directory name vs manifest ID inconsistency

**Solution:**
- Directory: `packages/@memphis/openclaw-plugin`
- Package name: `@memphis/openclaw-plugin`
- Manifest ID: `@memphis/openclaw-plugin`

Ensure all three match exactly.

**Validation:**
```bash
# Check consistency
cat packages/@memphis/openclaw-plugin/package.json | grep '"name"'
cat packages/@memphis/openclaw-plugin/openclaw.plugin.json | grep '"id"'
# Should both be: @memphis/openclaw-plugin
```

---

#### 8. No Setup Wizard

**Problem:** Users must manually create .env file

**Solution: Add `memphis setup` command**

```typescript
// src/infra/cli/commands/setup.ts
import inquirer from 'inquirer';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

interface SetupAnswers {
  provider: 'ollama' | 'openai' | 'anthropic';
  apiKey?: string;
  dataDir: string;
  embeddingModel: string;
  enableSync: boolean;
  syncPeers?: string;
}

export async function runSetupWizard(): Promise<void> {
  console.log('🧠 Memphis Setup Wizard\n');
  console.log('This will create your .env configuration file.\n');

  // Check if .env already exists
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: '.env already exists. Overwrite?',
        default: false
      }
    ]);
    
    if (!overwrite) {
      console.log('Setup cancelled.');
      return;
    }
  }

  // Interactive prompts
  const answers: SetupAnswers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Choose your default provider:',
      choices: [
        { name: 'Ollama (local, free)', value: 'ollama' },
        { name: 'OpenAI (requires API key)', value: 'openai' },
        { name: 'Anthropic (requires API key)', value: 'anthropic' }
      ],
      default: 'ollama'
    },
    {
      type: 'input',
      name: 'apiKey',
      message: 'Enter your API key:',
      when: (ans) => ans.provider !== 'ollama',
      validate: (input) => input.length > 0 || 'API key is required'
    },
    {
      type: 'input',
      name: 'dataDir',
      message: 'Data directory:',
      default: '~/.memphis'
    },
    {
      type: 'input',
      name: 'embeddingModel',
      message: 'Embedding model (Ollama):',
      default: 'nomic-embed-text',
      when: (ans) => ans.provider === 'ollama'
    },
    {
      type: 'confirm',
      name: 'enableSync',
      message: 'Enable multi-agent sync?',
      default: false
    },
    {
      type: 'input',
      name: 'syncPeers',
      message: 'Sync peers (comma-separated IPs):',
      when: (ans) => ans.enableSync,
      validate: (input) => {
        if (!input) return true;
        const ips = input.split(',').map(s => s.trim());
        return ips.every(ip => /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(ip)) || 'Invalid IP format';
      }
    }
  ]);

  // Generate .env content
  const envContent = generateEnvFile(answers);
  
  // Write .env
  writeFileSync(envPath, envContent);
  
  console.log('\n✅ Configuration saved to .env\n');
  console.log('📝 Next steps:');
  console.log('   1. Run: memphis health');
  console.log('   2. Try: memphis journal "My first entry"');
  console.log('   3. Read: memphis --help\n');
}

function generateEnvFile(answers: SetupAnswers): string {
  const lines = [
    '# Memphis Configuration',
    '# Generated by setup wizard\n',
    `DEFAULT_PROVIDER=${answers.provider}`,
    `MEMPHIS_DATA_DIR=${answers.dataDir}`,
    `MEMPHIS_CHAINS_DIR=${answers.dataDir}/chains`,
    `MEMPHIS_EMBEDDINGS_DIR=${answers.dataDir}/embeddings\n`
  ];

  if (answers.provider === 'ollama') {
    lines.push(`OLLAMA_MODEL=${answers.embeddingModel}\n`);
  } else if (answers.apiKey) {
    const keyName = `${answers.provider.toUpperCase()}_API_KEY`;
    lines.push(`${keyName}=${answers.apiKey}\n`);
  }

  if (answers.enableSync) {
    lines.push('MEMPHIS_SYNC_ENABLED=true');
    if (answers.syncPeers) {
      lines.push(`MEMPHIS_SYNC_PEERS=${answers.syncPeers}`);
    }
    lines.push('');
  }

  lines.push('LOG_LEVEL=info\n');

  return lines.join('\n');
}
```

**Add to CLI:**
```typescript
// src/infra/cli/commands/system.ts
import { runSetupWizard } from './setup';

export async function handleSetupCommand(): Promise<void> {
  await runSetupWizard();
}
```

**Validation:**
```bash
memphis setup  # Should run interactive wizard
cat .env  # Should show generated config
```

---

#### 9. Poor Error Messages

**Problem:** Cryptic failures without helpful context

**Solution: Create user-friendly error system**

```typescript
// src/core/errors/user-errors.ts

export interface UserError {
  code: string;
  message: string;
  suggestion: string;
  docs?: string;
}

export const USER_ERRORS: Record<string, UserError> = {
  MISSING_ENV: {
    code: 'E001',
    message: 'Configuration file (.env) not found',
    suggestion: "Run 'memphis setup' to create your configuration",
    docs: 'https://docs.memphis.dev/setup'
  },
  
  MISSING_OLLAMA: {
    code: 'E002',
    message: 'Ollama is not installed or not running',
    suggestion: 'Install Ollama: https://ollama.ai\n   Then start: ollama serve',
    docs: 'https://docs.memphis.dev/prerequisites'
  },
  
  INVALID_API_KEY: {
    code: 'E003',
    message: 'Invalid or missing API key',
    suggestion: 'Check your API key in .env file\n   Get a new key from your provider dashboard',
    docs: 'https://docs.memphis.dev/api-keys'
  },
  
  NETWORK_ERROR: {
    code: 'E004',
    message: 'Network connection failed',
    suggestion: 'Check your internet connection\n   If using a proxy, configure HTTP_PROXY',
    docs: 'https://docs.memphis.dev/troubleshooting'
  },
  
  PERMISSION_ERROR: {
    code: 'E005',
    message: 'Permission denied',
    suggestion: 'Check file permissions for ~/.memphis\n   Run: chmod -R 755 ~/.memphis',
    docs: 'https://docs.memphis.dev/permissions'
  },
  
  CHAIN_CORRUPTED: {
    code: 'E006',
    message: 'Chain data is corrupted',
    suggestion: "Run 'memphis doctor --fix' to repair\n   Or restore from backup: ~/.memphis/backups",
    docs: 'https://docs.memphis.dev/chain-repair'
  },
  
  PROVIDER_ERROR: {
    code: 'E007',
    message: 'Provider returned an error',
    suggestion: 'Try switching providers in .env\n   Or check provider status page',
    docs: 'https://docs.memphis.dev/providers'
  }
};

export function formatUserError(error: UserError, details?: string): string {
  const lines = [
    '',
    `❌ Error [${error.code}]: ${error.message}`,
    ''
  ];
  
  if (details) {
    lines.push(`   Details: ${details}`, '');
  }
  
  lines.push('💡 Suggestion:');
  lines.push('   ' + error.suggestion);
  
  if (error.docs) {
    lines.push('', `📚 Docs: ${error.docs}`);
  }
  
  lines.push('');
  
  return lines.join('\n');
}

export function throwUserError(code: keyof typeof USER_ERRORS, details?: string): never {
  const error = USER_ERRORS[code];
  console.error(formatUserError(error, details));
  process.exit(1);
}
```

**Usage example:**
```typescript
// Before
if (!fs.existsSync(envPath)) {
  throw new Error('.env not found');
}

// After
if (!fs.existsSync(envPath)) {
  throwUserError('MISSING_ENV');
}
```

**Validation:**
```bash
# Should show helpful error
rm .env
memphis health
# Output:
# ❌ Error [E001]: Configuration file (.env) not found
#
# 💡 Suggestion:
#    Run 'memphis setup' to create your configuration
#
# 📚 Docs: https://docs.memphis.dev/setup
```

---

#### 10. No Dependency Checks

**Problem:** Missing Ollama/Node/Rust not detected

**Solution: Enhanced `memphis doctor` command**

```typescript
// src/infra/cli/utils/dependencies.ts

import { execSync } from 'child_process';
import { VERSION as NODE_VERSION } from '../../version';

export interface DependencyStatus {
  name: string;
  installed: boolean;
  version?: string;
  required: boolean;
  minVersion?: string;
  suggestion?: string;
}

export async function checkDependencies(): Promise<DependencyStatus[]> {
  return [
    await checkNodeVersion(),
    await checkOllama(),
    await checkRustToolchain(),
    await checkMemphisData()
  ];
}

async function checkNodeVersion(): Promise<DependencyStatus> {
  const nodeVersion = process.version.slice(1); // Remove 'v'
  const minVersion = '18.0.0';
  const installed = compareVersions(nodeVersion, minVersion) >= 0;
  
  return {
    name: 'Node.js',
    installed,
    version: nodeVersion,
    required: true,
    minVersion,
    suggestion: installed ? undefined : `Upgrade to Node.js >= ${minVersion}`
  };
}

async function checkOllama(): Promise<DependencyStatus> {
  try {
    const version = execSync('ollama --version 2>/dev/null', { encoding: 'utf-8' }).trim();
    
    // Check if server is running
    let running = false;
    try {
      execSync('curl -s http://localhost:11434/api/tags', { stdio: 'ignore' });
      running = true;
    } catch {}
    
    return {
      name: 'Ollama',
      installed: true,
      version: version.split(' ')[1] || 'unknown',
      required: true,
      suggestion: running ? undefined : 'Start Ollama server: ollama serve'
    };
  } catch {
    return {
      name: 'Ollama',
      installed: false,
      required: true,
      suggestion: 'Install: curl -fsSL https://ollama.ai/install.sh | sh'
    };
  }
}

async function checkRustToolchain(): Promise<DependencyStatus> {
  try {
    const version = execSync('rustc --version 2>/dev/null', { encoding: 'utf-8' }).trim();
    return {
      name: 'Rust',
      installed: true,
      version: version.split(' ')[1],
      required: false,
      suggestion: undefined
    };
  } catch {
    return {
      name: 'Rust',
      installed: false,
      required: false,
      suggestion: 'Optional for building from source: https://rustup.rs'
    };
  }
}

async function checkMemphisData(): Promise<DependencyStatus> {
  const dataDir = process.env.MEMPHIS_DATA_DIR || expandTilde('~/.memphis');
  const exists = fs.existsSync(dataDir);
  
  return {
    name: 'Memphis Data Dir',
    installed: exists,
    version: undefined,
    required: true,
    suggestion: exists ? undefined : `Create: mkdir -p ${dataDir}`
  };
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] || 0;
    const partB = partsB[i] || 0;
    if (partA > partB) return 1;
    if (partA < partB) return -1;
  }
  return 0;
}

// Enhanced doctor command
export async function runDoctorCommand(fix: boolean = false): Promise<void> {
  console.log('🏥 Memphis Doctor — Dependency Check\n');
  
  const deps = await checkDependencies();
  let allGood = true;
  
  for (const dep of deps) {
    const icon = dep.installed ? '✅' : (dep.required ? '❌' : '⚠️ ');
    const version = dep.version ? ` (v${dep.version})` : '';
    const minVer = dep.minVersion ? ` [requires >= ${dep.minVersion}]` : '';
    
    console.log(`${icon} ${dep.name}${version}${minVer}`);
    
    if (!dep.installed && dep.suggestion) {
      console.log(`   ${dep.suggestion}`);
      allGood = false;
    }
  }
  
  console.log('');
  
  // Additional checks
  console.log('📋 Configuration:');
  console.log(`   Config file: ${fs.existsSync('.env') ? '✅ Found' : '❌ Missing (run: memphis setup)'}`);
  console.log(`   Default provider: ${process.env.DEFAULT_PROVIDER || 'ollama (default)'}`);
  console.log('');
  
  if (allGood) {
    console.log('✅ All dependencies satisfied!\n');
    console.log('🚀 Ready to use Memphis. Try:');
    console.log('   memphis journal "My first entry"');
    console.log('   memphis ask --input "What did I work on today?"');
    console.log('');
  } else {
    console.log('❌ Some issues found. Fix them and run again.\n');
    process.exit(1);
  }
}
```

**Add to CLI:**
```typescript
// src/infra/cli/commands/system.ts
program
  .command('doctor')
  .description('Check system dependencies and configuration')
  .option('--fix', 'Attempt to fix issues automatically')
  .action(async (options) => {
    await runDoctorCommand(options.fix);
  });
```

**Validation:**
```bash
memphis doctor
# Should show all dependencies with status
# Should provide suggestions for missing items
```

---

## 📊 Implementation Status

### Agent Assignments

| Agent | Issues | Status |
|-------|--------|--------|
| **Agent 1** | #1-3 (Binary, TS, Manifest) | 🔄 In Progress |
| **Agent 2** | #4-6 (Plugin, .env, Ollama) | 🔄 In Progress |
| **Agent 3** | #7-8 (Directory, Setup) | 🔄 In Progress |
| **Agent 4** | #9-10 (Errors, Deps) | 🔄 In Progress |

---

## ✅ Success Criteria

After all fixes:

1. ✅ Fresh install works without errors
2. ✅ `memphis setup` creates valid configuration
3. ✅ `memphis doctor` validates environment
4. ✅ Plugin loads in OpenClaw
5. ✅ All commands work out-of-box
6. ✅ Error messages are actionable
7. ✅ Dependencies are checked automatically

---

## 🚀 Next Steps

After completion:
1. Test fresh installation on clean system
2. Update installation documentation
3. Create video tutorial
4. Publish v0.3.0-beta
5. Gather user feedback

---

**Document Created:** 2026-03-11 11:09 CET
**Status:** Implementation in progress
**Target Completion:** 2026-03-11 11:30 CET
