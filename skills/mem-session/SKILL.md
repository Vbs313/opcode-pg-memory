---
name: mem-session
description: Log and search conversational sessions for later review. Use when user wants to track progress across multiple turns or search past conversations.
---

# Session Memory

Log conversational sessions and search across them. Useful for long-running tasks, research, or tracking decisions over time.

## When to Use Session Logging

- Starting a complex multi-step task
- Researching a topic across multiple sources
- Tracking decisions made during a session
- User asks "what did we discuss about X?"

## Workflow

### Step 1: Start a Session

```
start_session(name="Investigating database connection leak")
```

This creates a new named session in the database.

### Step 2: Log Messages

The session logs messages automatically. To add explicit notes:

Use `log_message`:
```
log_message(role="agent", content="Discovered that the connection pool timeout is set too low")
```

### Step 3: Search Sessions

Search across all logged sessions:

```
search_sessions(query="connection pool")
```

Returns matching sessions with excerpts.

### Step 4: End a Session

When the task is complete:

```
end_session(summary="Found root cause: pool_size too small. Fixed by increasing to 50.")
```

The session is closed and a summary is saved for future reference.
