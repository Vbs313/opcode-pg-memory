# Claude Code MCP Configuration

Add this block to your project's `CLAUDE.md` file (or `~/.claude/settings.json` for global):

## Option A: Project-level (CLAUDE.md)

Create or edit `CLAUDE.md` in your project root:

```markdown
# Project Guide

## MCP Servers

{  
  "mcpServers": {  
    "opcode-pg-memory": {  
      "type": "stdio",  
      "command": "node",  
      "args": ["PATH_TO_OPCODE_PG_MEMORY/dist/mcp-server.js"],  
      "env": {  
        "PG_HOST": "localhost",  
        "PG_PORT": "5432",  
        "PG_DATABASE": "opencode_memory",  
        "PG_USER": "opencode",  
        "PG_PASSWORD": "your_password_here",  
        "PG_MEMORY_PLATFORM": "claude-code"  
      }  
    }  
  }  
}
```

## Option B: Global (~/.claude/settings.json)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "opcode-pg-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["PATH_TO_OPCODE_PG_MEMORY/dist/mcp-server.js"],
      "env": {
        "PG_HOST": "localhost",
        "PG_PORT": "5432",
        "PG_DATABASE": "opencode_memory",
        "PG_USER": "opencode",
        "PG_PASSWORD": "your_password_here",
        "PG_MEMORY_PLATFORM": "claude-code"
      }
    }
  }
}
```
