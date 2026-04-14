# Web Search Feature Design - v1.2.0

> Created: 2026-04-01  
> Status: Design Proposal

## Executive Summary

**Web search (Brave Search + DuckDuckGo fallback) is NOT currently implemented.**  
Memphis has internal memory search (`memphis_recall`, `memphis_search`) but no external web search capability.

This document designs the v1.2.0 web search feature.

---

## 1. Current State Analysis

### 1.1 Existing Search Functionality

| Tool | Type | Description |
|------|------|-------------|
| `memphis_recall` | Semantic memory search | Searches Memphis chains via embeddings |
| `memphis_search` | Exact phrase search | Exact string match in indexed memory |
| `memphis_web_fetch` | URL fetcher | Fetches a single public URL (tier 1) |

**No web search provider exists.**

### 1.2 Provider Architecture Pattern

Memphis providers follow a consistent pattern in `src/providers/`:

```
src/providers/
├── index.ts          # Provider interface + implementations (Ollama, MiniMax, etc.)
├── factory.ts        # Provider factory
├── runtime.ts        # Runtime wrapper
├── capability-matrix.ts
└── {provider}/
    └── adapter.ts    # Provider-specific implementation
```

Key patterns:
- **Vault-first API keys**: `*_VAULT_KEY` env var → vault lookup → `*_API_KEY` fallback
- **Provider interface**: `isConfigured()`, `isAvailable()`, `chat()`, etc.
- **Graceful cascade**: Primary → fallback → local-fallback

### 1.3 Tool Tier System

| Tier | Type | Examples |
|------|------|----------|
| 0 | Core read/write | `memphis_recall`, `memphis_journal`, `memphis_search` |
| 1 | Network | `memphis_web_fetch` |
| 2 | Execute | `memphis_exec`, `memphis_self_modify` |

---

## 2. Proposed Architecture

### 2.1 New Files

```
src/providers/web-search/
├── brave.adapter.ts      # Brave Search API integration
├── duckduckgo.adapter.ts # DuckDuckGo HTML/API fallback
└── index.ts              # WebSearchProvider interface + factory

src/mcp/tools/
└── web-search.ts         # memphis_web_search tool implementation

src/gateway/
├── tool-executor.ts       # Add web_search case
└── tool-registry.ts      # Add web_search metadata
```

### 2.2 WebSearchProvider Interface

```typescript
export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  snippet?: string;
}

export interface WebSearchProvider {
  name: string;
  isConfigured(): boolean;
  search(query: string, limit?: number): Promise<WebSearchResult[]>;
}
```

### 2.3 Brave Search Adapter (Primary)

**API Endpoint**: `https://api.search.brave.com/res/v1/web/search`

**Environment Variables**:
```bash
BRAVE_SEARCH_VAULT_KEY=brave_search_api_key  # vault reference
BRAVE_SEARCH_API_KEY=***                     # direct (dev only)
BRAVE_SEARCH_SUBSCRIPTION_KEY=***            # Brave subscription key
```

**Features**:
- Web search with Brave's SafeSearch
- Returns title, URL, description, snippet
- Respects rate limits

### 2.4 DuckDuckGo Adapter (Fallback)

**API Options**:
1. **HTML scrape** (no API key) - lightweight, unreliable
2. **DuckDuckGo API** (free API token) - more reliable
3. **Bangs API** - for specific site searches

**Environment Variables**:
```bash
DDG_API_TOKEN=***  # Optional - for more reliable API access
```

**Fallback chain**: DDG API → HTML scrape → error

### 2.5 Cascade Logic

```
memphis_web_search(query)
  └─► Brave Search (if BRAVE_SEARCH_API_KEY configured)
      └─► DuckDuckGo (if DDG_API_TOKEN or no key)
          └─► Error: "No search provider configured"
```

---

## 3. Tool Integration

### 3.1 Tool Definition

```typescript
{
  name: 'memphis_web_search',
  description: 'Search the web using Brave Search (primary) or DuckDuckGo (fallback)',
  tier: 1,  // Network capability
  inputSchema: {
    type: 'object',
    properties: {
      query: { 
        type: 'string', 
        description: 'Web search query' 
      },
      limit: { 
        type: 'number', 
        default: 10,
        description: 'Max results (1-50)' 
      }
    },
    required: ['query']
  }
}
```

### 3.2 Tool Registry Entry

```typescript
memphis_web_search: {
  name: 'memphis_web_search',
  tier: 1,
  capabilities: ['network', 'read'],
  description: 'Search the web',
}
```

---

## 4. Configuration

### 4.1 Environment Variables

```bash
# Primary: Brave Search
BRAVE_SEARCH_VAULT_KEY=brave_search_api_key
BRAVE_SEARCH_API_KEY=
BRAVE_SEARCH_SUBSCRIPTION_KEY=

# Fallback: DuckDuckGo  
DDG_API_TOKEN=

# Feature toggle
WEB_SEARCH_ENABLED=true
WEB_SEARCH_DEFAULT_LIMIT=10
```

### 4.2 Vault Keys

```
brave_search_api_key     # Brave Search API key
brave_search_subscription_key  # Brave subscription key  
ddg_api_token           # DuckDuckGo API token (optional)
```

---

## 5. Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Create `src/providers/web-search/index.ts` with interface
- [ ] Implement `WebSearchProvider` interface
- [ ] Add vault key resolution for Brave/DDG

### Phase 2: Brave Search Adapter
- [ ] Create `src/providers/web-search/brave.adapter.ts`
- [ ] Implement Brave Search API v1
- [ ] Add response parsing (WebSearchResult[])
- [ ] Error handling and rate limit handling

### Phase 3: DuckDuckGo Fallback
- [ ] Create `src/providers/web-search/duckduckgo.adapter.ts`
- [ ] Implement DDG HTML scrape fallback
- [ ] Optional DDG API integration
- [ ] Fallback cascade logic

### Phase 4: Tool Integration
- [ ] Create `src/mcp/tools/web-search.ts`
- [ ] Add tool definition to `tool-executor.ts`
- [ ] Add tool metadata to `tool-registry.ts`
- [ ] Add system prompt hints for web search

### Phase 5: Testing & Polish
- [ ] Unit tests for both adapters
- [ ] Integration tests
- [ ] Error message refinement
- [ ] Documentation

---

## 6. API Details

### 6.1 Brave Search API

**Endpoint**: `GET https://api.search.brave.com/res/v1/web/search`

**Headers**:
```
Accept: application/json
X-Subscription-Token: {subscription_key}
```

**Query Parameters**:
- `q` - search query
- `count` - number of results (1-20)
- `offset` - pagination offset
- `safesearch` - strict/moderate/off

**Response Mapping**:
```typescript
{
  web: {
    results: [{
      title: string,
      url: string,
      description: string,
      is_source_local: boolean,
      is_source_both: boolean,
    }]
  }
}
```

### 6.2 DuckDuckGo Fallback Options

**Option A: HTML Scrape** (no API key)
- Endpoint: `https://html.duckduckgo.com/html/?q={query}`
- Parse `<a class="result__a">` and `<a class="result__snippet">`
- Unreliable, may break

**Option B: API** (free token from `https://api.duckduckgo.com/`)
- Endpoint: `https://api.duckduckgo.com/?q={query}&format=json`
- Limited results, no snippet

**Option C: Instant Answer API**
- `https://api.duckduckgo.com/?q={query}&format=json&no_redirect=1`

---

## 7. Security Considerations

1. **SSRF Protection**: Reuse `isSafeUrl()` from `web-fetch.ts` for any URL validation
2. **Rate Limiting**: Track requests per minute
3. **Result Filtering**: Strip tracking parameters from URLs
4. **Tier Enforcement**: `memphis_web_search` is tier 1 (network)
5. **Audit Logging**: Log all web searches to system chain

---

## 8. Error Handling

| Error | Response |
|-------|----------|
| Brave API key not set | Fall to DuckDuckGo |
| Brave API rate limited | Fall to DuckDuckGo |
| Brave API error | Fall to DuckDuckGo |
| DDG fails | Return error: "Search unavailable" |
| Neither configured | Return error: "Configure BRAVE_SEARCH_API_KEY or DDG_API_TOKEN" |

---

## 9. Deprecation & Future

- Consider adding Google Search API as third fallback
- Consider adding "site:reddit.com" or "site:stackoverflow.com" specialized searches
- Consider search result caching (Redis/in-memory)

---

## 10. Reference Implementation Pattern

```typescript
// src/providers/web-search/brave.adapter.ts
export class BraveSearchAdapter implements WebSearchProvider {
  name = 'brave';
  private apiKey: string;
  private subscriptionKey: string;

  constructor() {
    this.apiKey = resolveVaultKey('brave_search_api_key') || process.env.BRAVE_SEARCH_API_KEY;
    this.subscriptionKey = process.env.BRAVE_SEARCH_SUBSCRIPTION_KEY || '';
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async search(query: string, limit: number = 10): Promise<WebSearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(limit, 20)));
    
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.subscriptionKey,
      }
    });
    
    // Parse and return results
  }
}
```
