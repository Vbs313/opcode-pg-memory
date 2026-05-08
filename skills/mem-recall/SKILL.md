---
name: mem-recall
description: Search cross-session memory database. Use when user asks "did we already fix this?", "how did we solve X last time?", or needs context from previous sessions.
---

# Memory Recall

Search past work across all sessions. Simple workflow: search → filter → fetch.

## When to Use

Use when users ask about PREVIOUS sessions (not current conversation):

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"
- "What do we know about Y?"

## 3-Layer Workflow (ALWAYS Follow)

### Step 1: Search — Get Index with IDs

Use the `search_memories` tool:

```
search_memories(query="authentication", limit=20, scope="project")
```

**Returns:** Table with IDs, timestamps, types, titles, relevance scores.

**Parameters:**
- `query` (string) — Search term
- `limit` (number) — Max results, default 10, max 50
- `scope` (string) — "session", "project", or "global"
- `type` (string, optional) — Filter by: "observation", "reflection", "entity"
- `min_score` (number, optional) — Minimum relevance score 0-1

### Step 2: Timeline — Get Context Around Interesting Results

Use the `timeline` tool:

```
timeline(anchor_id="obs-123", depth_before=3, depth_after=3)
```

**Returns:** `depth_before + 1 + depth_after` items in chronological order around the anchor.

**Parameters:**
- `anchor_id` (string) — Observation ID to center around
- `depth_before` (number, optional) — Items before anchor, default 3, max 10
- `depth_after` (number, optional) — Items after anchor, default 3, max 10

### Step 3: Fetch — Get Full Details ONLY for Filtered IDs

Review titles from Step 1 and context from Step 2. Pick relevant IDs.

Use the `get_memory` tool:

```
get_memory(id="obs-123")
```

**Returns:** Full details of the memory entry.

**NEVER fetch full details without filtering first.** Step 1 + Step 2 use ~100 tokens. Step 3 per fetch uses ~500 tokens. Always filter before fetch.
