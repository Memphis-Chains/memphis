# @memphis/openclaw-plugin

Native OpenClaw memory provider powered by Memphis chains over HTTP.

## Features

- Implements `MemorySearchManager`
- Uses Memphis HTTP API (`/api/journal`, `/api/recall`, `/api/decide`)
- Append-only safe delete (tombstone decision)
- Lightweight request path with sub-100ms local overhead in tests

## Install

```bash
npm i @memphis/openclaw-plugin
```

## Usage

```ts
import { MemphisMemoryProvider } from '@memphis/openclaw-plugin';

export default {
  plugins: {
    memory: {
      provider: MemphisMemoryProvider,
      config: {
        baseUrl: 'http://localhost:3000',
        timeoutMs: 5000,
        defaultLimit: 10,
      },
    },
  },
};
```

## API Mapping

- `search(query, { limit })` -> `POST /api/recall`
- `save(content, metadata?.tags)` -> `POST /api/journal`
- `get(id)` -> recall lookup by hash/index
- `delete(id)` -> `POST /api/decide` tombstone entry

## Test

```bash
npm test
```

The test suite includes:

1. Search mapping with mocked recall response
2. Save flow with mocked journal response
3. Delete flow through decide chain
4. Performance guard (`<100ms` overhead on mocked request path)
