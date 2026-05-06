#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_COMMAND_DIR = join(OPENCODE_CONFIG_DIR, "command");
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

function printHelp(): void {
  console.log(`
pg-memory - PostgreSQL-backed long-term memory for OpenCode

Commands:
  install    Register plugin and create /pg-memory-init command

Examples:
  bunx opcode-pg-memory install
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
  console.log("\nSetup complete!");
  console.log("\nNext steps:");
  console.log(`  1. cd ${process.cwd()}`);
  console.log("  2. cp .env.example .env && edit .env");
  console.log("  3. bun install && bun run build");
  console.log("  4. Restart OpenCode\n");
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
printHelp();
process.exit(1);
