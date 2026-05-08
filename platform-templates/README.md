# Cross-Platform MCP Configuration

opcode-pg-memory can be used from any AI coding tool that supports the Model Context Protocol (MCP).

## Prerequisites

1. PostgreSQL must be running and accessible
2. Copy `.env.example` to `.env` and configure your database credentials
3. Build the plugin: `npm run build` or `bun run build` (or `npx tsc`)

## Setup Instructions

### Configure Database

Set these environment variables (or create a `.env` file in the plugin directory):

| Variable | Default | Description |
|----------|---------|-------------|
| `PG_HOST` | `localhost` | PostgreSQL host |
| `PG_PORT` | `5432` | PostgreSQL port |
| `PG_DATABASE` | `opencode_memory` | Database name |
| `PG_USER` | `opencode` | Database user |
| `PG_PASSWORD` | — | Database password |
| `PG_MEMORY_PLATFORM` | `opencode` | Platform identifier (opencode, claude-code, cursor, etc.) |

### Platform Configurations

| Platform | Config File | Template |
|----------|------------|----------|
| **Cursor** | `.cursor/mcp.json` (project) or global Cursor settings | `cursor-mcp.json` |
| **Windsurf** | `.windsurf/mcp.json` | `windsurf-mcp.json` |
| **Claude Code** | `CLAUDE.md` or `~/.claude/settings.json` | `claude-code-mcp.md` |
| **Continue.dev** | `~/.continue/config.json` | `continue-config.json` |
| **OpenCode** | Built-in (via `opencode.jsonc` plugin config) | Already configured |

### Using the Standalone SSE Server

For persistent background operation (all platforms can connect via SSE):

```bash
# Start the MCP server as a background process
node dist/mcp-server.js --transport sse --port 37777 &

# Configure each platform to connect via SSE instead of stdio
# Platform SSE config format:
# {
#   "mcpServers": {
#     "opcode-pg-memory": {
#       "type": "sse",
#       "url": "http://localhost:37777/sse"
#     }
#   }
# }
```

## MCP Tools Available

| Tool | Description |
|------|-------------|
| `recall_memory` | Search historical memories with semantic/BM25/graph retrieval |
| `hindsight_reflect` | Reflect on a session to extract reusable patterns |
| `import_document` | Import external documents into the knowledge base |
