# bash-mcp-server

An MCP (Model Context Protocol) server that exposes bash shell command execution to any MCP-compatible AI client (Claude Desktop, Claude Code, Cursor, etc.).

An exact replica of the `bash_tool` built into Claude — same tool name, same parameters, same output format.

Supports **Linux** and **macOS** only.
The Windows equivalent is [powershell-mcp-server](https://github.com/yossifibrahem/powershell-mcp-server) — same tool contract, same parameters, same output format.
---

## Tools

### `bash_tool`

Run a shell command and get back its stdout, stderr, and exit code.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✅ | The shell command to execute |
| `description` | string | ✅ | Plain-English reason for running the command (logged only, not executed) |

**Returns:**
```json
{
  "returncode": 0,
  "stdout": "...",
  "stderr": "..."
}
```

**Shell resolution:**

| OS | Default shell | Fallback |
|---|---|---|
| Linux | `bash` (from PATH) | `/bin/sh` |
| macOS | `bash` (from PATH) | `/bin/sh` |

---

## Requirements

- **Node.js 18+**
- **Linux or macOS** — the server will exit immediately if run on Windows

---

## Installation

```bash
unzip bash-mcp-server.zip
cd bash-mcp-server
npm install
# dist/ is already compiled — no build step needed
# (or rebuild anytime with: npm run build)
```

---

## Configuration

Add to your MCP client config. The path to `node` and the server's `dist/index.js` must be absolute.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "bash": {
      "command": "node",
      "args": ["/absolute/path/to/bash-mcp-server/dist/index.js"]
    }
  }
}
```

Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

### Claude Code (`~/.claude.json`)
```json
{
  "mcpServers": {
    "bash": {
      "command": "node",
      "args": ["/absolute/path/to/bash-mcp-server/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

---

## Security

This server executes arbitrary commands with the **same OS permissions as the process that runs it**. Keep that in mind:

- Run it as a dedicated low-privilege user in production environments.
- Do not expose the MCP server to untrusted networks.
- Commands time out after **30 seconds** to prevent runaway processes.

---

## Development

```bash
npm run build   # compile TypeScript → dist/
npm start       # run the compiled server
```

Test with the MCP Inspector:
```bash
npx @modelcontextprotocol/inspector node dist/index.js
```
