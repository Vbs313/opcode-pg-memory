---
name: mem-reflect
description: Extract reusable patterns from completed work. Use after finishing a significant task to capture learnings for future sessions.
---

# Memory Reflection

After completing significant work, reflect to extract patterns and insights that future sessions can reuse.

## When to Reflect

- After fixing a difficult bug
- After implementing a complex feature
- After learning something about the codebase architecture
- After discovering a useful configuration or workaround

## Workflow

### Step 1: Trigger Reflection

Use the `hindsight_reflect` tool:

```
hindsight_reflect(trigger_type="manual")
```

This analyzes the current session's observations and extracts:
- Patterns and anti-patterns
- Architectural decisions
- Configuration discoveries
- Reusable solutions

### Step 2: Verify the Result

The reflection is automatically stored in the database and will be injected into future sessions via `experimental.chat.system.transform`.

### One-Time Setup

Run this once per project to initialize the knowledge base:

```
/init-deep
```

This creates an AGENTS.md file with the project's memory structure.
