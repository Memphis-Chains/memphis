# NPM Installation — Memphis v5

## ✅ Package Published!

**Registry:** GitHub Packages
**Version:** 0.1.0-alpha.1
**Tag:** alpha
**Access:** restricted (organization only)

---

## 📦 Installation Methods

### Method 1: Install from GitHub Packages

**Prerequisites:**
1. GitHub account with access to @memphis-chains org
2. Personal Access Token with `read:packages` scope

**Setup (one-time):**

```bash
# Create ~/.npmrc
echo "@memphis-chains:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_TOKEN" >> ~/.npmrc
```

**Install:**
```bash
npm install @memphis-chains/memphis-v5@alpha
```

---

### Method 2: Clone & Build (Recommended for alpha)

```bash
# Clone repo
git clone https://github.com/Memphis-Chains/memphis-v5.git
cd memphis-v5

# Install & build
npm install
npm run build

# Link globally
npm link

# Verify
memphis health
```

---

### Method 3: One-liner Script (Linux/macOS/WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis-v5/main/scripts/install.sh | bash
```

---

## 📦 Package Details

**View package:**
```bash
npm view @memphis-chains/memphis-v5@alpha --registry=https://npm.pkg.github.com
```

**Package info:**
- Name: `@memphis-chains/memphis-v5`
- Version: `0.1.0-alpha.1`
- Size: 137.4 kB (561.2 kB unpacked)
- Files: 148
- License: MIT
- Registry: GitHub Packages

---

## 🔐 Authentication

**To install from GitHub Packages:**

1. **Create PAT:**
   - Go to: https://github.com/settings/tokens/new
   - Scopes: `read:packages`
   - Generate token

2. **Configure npm:**
   ```bash
   npm login --scope=@memphis-chains --registry=https://npm.pkg.github.com
   # Username: YOUR_GITHUB_USERNAME
   # Password: YOUR_TOKEN
   # Email: YOUR_EMAIL
   ```

3. **Verify:**
   ```bash
   npm whoami --registry=https://npm.pkg.github.com
   ```

---

## 🚀 Quick Start (After Install)

```bash
# Initialize Memphis
memphis health

# Create first memory
memphis journal "Memphis v5 installed successfully!"

# Search memories
memphis search "installed"

# View status
memphis status
```

---

## 📋 Available Tags

| Tag | Version | Status | Description |
|-----|---------|--------|-------------|
| `alpha` | 0.1.0-alpha.1 | ✅ Latest | Internal testing |
| `beta` | — | 🔄 Planned | Public beta (TBD) |
| `latest` | — | 🔄 Planned | Production (v1.0.0) |

---

## 🔗 Links

- **Package:** https://github.com/Memphis-Chains/memphis-v5/packages/memphis-v5
- **Repo:** https://github.com/Memphis-Chains/memphis-v5
- **Releases:** https://github.com/Memphis-Chains/memphis-v5/releases
- **Docs:** https://github.com/Memphis-Chains/memphis-v5#readme

---

## ⚠️ Alpha Notice

**This is an ALPHA release** for internal testing only.

- ✅ Core features working
- ⚠️ Security audit pending
- ⚠️ Limited documentation
- ⚠️ API may change

**Not production-ready yet.**

---

## 📝 Next Steps

- [ ] Install Memphis
- [ ] Try semantic search
- [ ] Create memory files
- [ ] Connect to OpenClaw
- [ ] Multi-agent sync (optional)

---

**△⬡◈ Memphis v5 — OpenClaw's Memory Layer**
