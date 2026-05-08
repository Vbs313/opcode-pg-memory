# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 3.x     | ✅ |
| 2.x     | ❌ |

## Credential Management

opcode-pg-memory stores credentials in `~/.opencode-pg-memory/.env`.
This file is never committed to the repository.

**Do NOT**:
- Commit `.env` files to any repository
- Hardcode API keys or database passwords in source code
- Share `.env` contents in issue reports or pull requests

## Subprocess Isolation

The `buildIsolatedEnv()` function blocks the following environment variables
from leaking into child processes:

- `OPENAI_API_KEY`
- `DEEPSEEK_API_KEY`  
- `ANTHROPIC_API_KEY`
- `PG_PASSWORD`
- `PG_MEMORY_DATA_DIR`

## Reporting a Vulnerability

If you discover a security issue, **do not** open a public GitHub issue.
Instead, contact the maintainer via GitHub Security Advisories:
https://github.com/Vbs313/opcode-pg-memory/security/advisories

## Dependencies

Dependencies are kept up-to-date via `bun update`. 
Critical security patches are applied within 7 days of disclosure.
