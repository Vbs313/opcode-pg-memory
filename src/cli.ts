#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_COMMAND_DIR = join(OPENCODE_CONFIG_DIR, "command");
const OPENCODE_SKILLS_DIR = join(homedir(), ".config", "opencode", "skills");
const PLUGIN_NAME = "opcode-pg-memory";
const REPO_URL = "https://github.com/Vbs313/opcode-pg-memory";

const PG_MEMORY_INIT_COMMAND = `---
description: Initialize pg-memory with codebase knowledge
---

# Initializing PG Memory

You are bootstrapping the pg-memory plugin for this project. This plugin provides:

- **Semantic memory search** via recall_memory MCP tool
- **Automatic observation recording** from tool executions
- **Topic segmentation** within sessions
- **Cross-session reflection** via hindsight_reflect

## Steps

1. Run \`recall_memory\` with a test query to verify connectivity
2. The plugin will automatically start recording observations as you work
3. After significant work, run \`hindsight_reflect\` to generate reflections

## Setup Verification
\`\`\`bash
opencode --print-logs --log-level INFO | findstr "PG Memory"
\`\`\`
`;

// Helper: strip JSONC comments (copied from supermemory pattern)
function stripJsoncComments(content: string): string {
  return content
    .replace(/\/\/.*$/gm, "")           // single-line
    .replace(/\/\*[\s\S]*?\*\//g, ""); // multi-line
}

function findOpencodeConfig(): string | null {
  const candidates = [
    join(OPENCODE_CONFIG_DIR, "opencode.jsonc"),
    join(OPENCODE_CONFIG_DIR, "opencode.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function addPluginToConfig(configPath: string): boolean {
  try {
    const content = readFileSync(configPath, "utf-8");
    if (content.includes(PLUGIN_NAME)) {
      console.log("Plugin already registered");
      return true;
    }
    const jsonContent = stripJsoncComments(content);
    let config: Record<string, unknown>;
    try { config = JSON.parse(jsonContent); }
    catch { console.error("Failed to parse config"); return false; }

    const plugins = (config.plugin as string[]) || [];
    plugins.push(PLUGIN_NAME);
    config.plugin = plugins;

    if (configPath.endsWith(".jsonc")) {
      if (content.includes('"plugin"')) {
        const newContent = content.replace(
          /("plugin"\s*:\s*\[)([^\]]*?)(\])/,
          (_match, start, middle, end) => {
            const trimmed = middle.trim();
            return trimmed === ""
              ? `${start}\n    "${PLUGIN_NAME}"\n  ${end}`
              : `${start}${middle.trimEnd()},\n    "${PLUGIN_NAME}"\n  ${end}`;
          }
        );
        writeFileSync(configPath, newContent);
      } else {
        const newContent = content.replace(
          /^(\s*\{)/,
          `$1\n  "plugin": ["${PLUGIN_NAME}"],`
        );
        writeFileSync(configPath, newContent);
      }
    } else {
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
    console.log(`Added plugin to ${configPath}`);
    return true;
  } catch (err) {
    console.error("Failed to update config:", err);
    return false;
  }
}

function createNewConfig(): boolean {
  const configPath = join(OPENCODE_CONFIG_DIR, "opencode.jsonc");
  mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  const config = `{\n  "plugin": ["${PLUGIN_NAME}"]\n}\n`;
  writeFileSync(configPath, config);
  console.log(`Created ${configPath}`);
  return true;
}

function createInitCommand(): boolean {
  mkdirSync(OPENCODE_COMMAND_DIR, { recursive: true });
  const initPath = join(OPENCODE_COMMAND_DIR, "pg-memory-init.md");
  writeFileSync(initPath, PG_MEMORY_INIT_COMMAND);
  console.log("Created /pg-memory-init command");
  return true;
}

const PG_MEMORY_SYNC_COMMAND = `---
description: Sync OpenCode sessions from SQLite to PostgreSQL
---

# PG Memory Sync

Run this command to sync historical OpenCode sessions into the pg-memory database:

\`\`\`bash
bunx opcode-pg-memory sync
\`\`\`

This imports all historical OpenCode sessions into the pg-memory PostgreSQL database for future retrieval.
`;

function createSyncCommand(): boolean {
  mkdirSync(OPENCODE_COMMAND_DIR, { recursive: true });
  const syncPath = join(OPENCODE_COMMAND_DIR, "pg-memory-sync.md");
  writeFileSync(syncPath, PG_MEMORY_SYNC_COMMAND);
  console.log("Created /pg-memory-sync command");
  return true;
}

const PG_MEMORY_REFLECT_COMMAND = `---
description: Reflect on current session to extract patterns and insights
---

# PG Memory Reflect

Summarize and reflect on the current session to extract reusable patterns, lessons, and insights.

## Instructions

1. Determine the current session ID
2. Call the \`hindsight_reflect\` MCP tool with the session ID
3. Present the results in a clear format: error patterns, tool usage, success patterns, recommendations
`;

function createReflectCommand(): boolean {
  mkdirSync(OPENCODE_COMMAND_DIR, { recursive: true });
  const reflectPath = join(OPENCODE_COMMAND_DIR, "pg-memory-reflect.md");
  writeFileSync(reflectPath, PG_MEMORY_REFLECT_COMMAND);
  console.log("Created /pg-memory-reflect command");
  return true;
}

const PG_MEMORY_SKILL = `# pg-memory — Long-term Memory for OpenCode

You have access to persistent long-term memory via the pg-memory plugin. Use it to search historical knowledge and reflect on completed work.

## Available Tools

### recall_memory — Search Historical Memories
Search for relevant entities, observations, and reflections from past sessions.
Call BEFORE starting any new task.
- recall_memory({ query: "your task goal" })

### hindsight_reflect — Summarize Session
Extract reusable patterns and lessons.
Call AFTER completing significant work.
- hindsight_reflect({ trigger_type: "manual" })

## Best Practice
Always call recall_memory(query=<current task goal>) before working on a new problem.
`;

function createSkill(): boolean {
  mkdirSync(OPENCODE_SKILLS_DIR, { recursive: true });
  const skillPath = join(OPENCODE_SKILLS_DIR, "pg-memory.md");
  writeFileSync(skillPath, PG_MEMORY_SKILL);
  console.log("Created pg-memory skill");
  return true;
}

function printHelp(): void {
  console.log(`
pg-memory - PostgreSQL-backed long-term memory for OpenCode

Commands:
  install    Register plugin and create commands
  sync       Sync OpenCode sessions from SQLite to PostgreSQL

Examples:
  bunx opcode-pg-memory install
  bunx opcode-pg-memory sync
  git clone ${REPO_URL} && cd opcode-pg-memory && bun run build

After installation, configure the MCP server in opencode.jsonc:
  "mcp": {
    "pg-memory": {
      "type": "local",
      "command": ["bun", "path/to/dist/mcp-server.js"],
      "enabled": true,
      "environment": { ... }
    }
  }
`);
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(0);
}

if (cmd === "install") {
  console.log("\nOpenCode PG Memory installer\n");
  const configPath = findOpencodeConfig();
  if (configPath) {
    console.log(`Found config: ${configPath}`);
    addPluginToConfig(configPath);
  } else {
    console.log("No config found, creating...");
    createNewConfig();
  }
  createInitCommand();
  createSyncCommand();
  createReflectCommand();
  createSkill();
  console.log("\nSetup complete!");
  console.log("\nNext steps:");
  console.log(`  1. cd ${process.cwd()}`);
  console.log("  2. cp .env.example .env && edit .env");
  console.log("  3. bun install && bun run build");
  console.log("  4. Restart OpenCode\n");
  process.exit(0);
}

if (cmd === "sync") {
  syncSessions().then(code => process.exit(code));
}

async function syncSessions(): Promise<number> {
  console.log("\nSyncing OpenCode sessions to PostgreSQL...\n");
  try {
    // @ts-ignore - bun:sqlite is a built-in bun module
    const { Database } = await import("bun:sqlite");
    const { Pool } = await import("pg");

    const opencodeDb = join(homedir(), ".local", "share", "opencode", "opencode.db");
    if (!existsSync(opencodeDb)) {
      console.error("OpenCode database not found at:", opencodeDb);
      return 1;
    }

    const sqlite = new Database(opencodeDb);
    const rows = sqlite.query("SELECT id, title FROM session").all() as { id: string; title?: string }[];
    console.log(`OpenCode sessions: ${rows.length}`);

    const pgPool = new Pool({
      host: process.env.PG_HOST || "localhost",
      port: parseInt(process.env.PG_PORT || "5432"),
      database: process.env.PG_DATABASE || "PGOMO",
      user: process.env.PG_USER || "opencode",
      password: process.env.PG_PASSWORD || "",
    });

    const existing = await pgPool.query("SELECT opencode_session_id FROM session_map");
    const existingIds = new Set(existing.rows.map((r: any) => r.opencode_session_id));
    console.log(`PG sessions: ${existingIds.size}`);

    let inserted = 0;
    for (const row of rows) {
      if (!existingIds.has(row.id)) {
        await pgPool.query(
          "INSERT INTO session_map (opencode_session_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [row.id]
        );
        inserted++;
        console.log(`  + ${row.id}  ${(row.title || "").substring(0, 50)}`);
      }
    }

    console.log(`\nInserted: ${inserted}, Total: ${existingIds.size + inserted}`);
    await pgPool.end();
    sqlite.close();
    return 0;
  } catch (err: any) {
    console.error("Sync failed:", err.message);
    return 1;
  }
}

console.error(`Unknown command: ${cmd}`);
printHelp();
process.exit(1);
