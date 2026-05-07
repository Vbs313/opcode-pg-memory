# OmO Adapter (Unused)

Archived on 2026-05-07.

## Contents

| File | Lines | Description |
|------|-------|-------------|
| `adapter.ts` | 747 | OmO adapter: Agent lifecycle, memory injection, reflection coordination |
| `types.ts` | 231 | OmO type definitions (Agent, Task, Config, Wisdom) |
| `recall-memory-omo.ts` | 366 | OmO recall_memory: agent scope filtering + token budget |
| `hindsight-reflect-omo.ts` | 431 | OmO hindsight_reflect: Wisdom sync + cross-agent stats |

## Why Archived

Audit found that none of these 4 files (1,544 lines total) are imported, initialized, or registered in `src/index.ts`. Zero runtime entry points — completely disconnected dead code.

- No runtime risk (code never executes)
- But causes structural confusion: `src/mcp/` had unregistered tools
- Misleading: references PG tables/columns that don't exist (`omo_coordination`, `agent_task_id`)

## Re-enablement Steps

### 1. Create PG schema

Run migration script:

```bash
psql -d PGOMO -f scripts/migration-omo-schema.sql
```

This adds `source_agent` and `agent_task_id` columns to `observations`, `entities`, `semantic_cache`, and creates the `omo_coordination` table.

### 2. Connect the adapter

In `src/index.ts`:

```typescript
import { OmOAdapter } from './omo/adapter';

// After plugin.initialize():
const omoAdapter = new OmOAdapter({ pool, config: { ... } });
await omoAdapter.initialize();
```

### 3. Register OmO MCP tools

In `src/index.ts` tool object, replace recall_memory and hindsight_reflect with OmO versions:

```typescript
import { recallMemoryOmO } from './omo/adapter';
import { hindsightReflectOmO } from './omo/adapter';
```

### 4. Set environment variables

| Variable | Description |
|----------|-------------|
| `OMO_ENABLED` | Set to `true` |
| `OMO_AGENT_ID` | Current Agent ID |
| `OMO_SESSION_ID` | Current session ID |
