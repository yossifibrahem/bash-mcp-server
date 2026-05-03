#!/usr/bin/env node
/**
 * bash-mcp-server
 *
 * Exposes a single MCP tool — `bash_tool` — that is an exact replica of
 * the built-in bash_tool available inside Claude:
 *
 *   Parameters : command (string, required)
 *                description (string, required)
 *
 *   Output     : { "returncode": number, "stdout": string, "stderr": string }
 *
 * Works on Linux and macOS.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { z } from "zod";

// ─── Working directory ────────────────────────────────────────────────────────

/**
 * Resolve the CWD for every spawned command.
 *
 * Priority (first match wins):
 *   1. WORKING_DIR env var  — set this in mcp.json / claude_desktop_config.json
 *   2. ~/.wd fallback       — a predictable, user-owned directory
 *
 * Supports ~ expansion.
 */
function resolveWorkingDir(): string | undefined {
  const raw = process.env.WORKING_DIR;
  if (!raw) return undefined;

  const resolved =
    raw === "~" || raw.startsWith("~/")
      ? path.join(os.homedir(), raw.slice(1))
      : path.resolve(raw);

  if (!fs.existsSync(resolved)) {
    process.stderr.write(
      `bash-mcp-server: WORKING_DIR does not exist: ${resolved}\n` +
      `  (original value: ${raw})\n` +
      `  Create the directory first, or unset WORKING_DIR to leave cwd unset.\n`
    );
    process.exit(1);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    process.stderr.write(
      `bash-mcp-server: WORKING_DIR is not a directory: ${resolved}\n`
    );
    process.exit(1);
  }

  return resolved;
}

const DEFAULT_CWD = resolveWorkingDir();

// ─── Shell resolver ───────────────────────────────────────────────────────────

/** Locate a binary by searching PATH — avoids a shell round-trip. */
function findOnPath(candidates: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const name of candidates) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Resolve the shell binary and the argument prefix needed to pass a command
 * string to it (i.e. -c for POSIX shells).
 */
function resolveShell(): { bin: string; prefix: string[] } {
  const bash = findOnPath(["bash"]);
  if (bash) return { bin: bash, prefix: ["-c"] };
  return { bin: "/bin/sh", prefix: ["-c"] };
}

// ─── Execution ────────────────────────────────────────────────────────────────

interface BashResult {
  returncode: number;
  stdout:     string;
  stderr:     string;
  [key: string]: unknown; // index signature required by MCP structuredContent
}

const TIMEOUT_MS    = 30_000;   // 30 s — same as Claude's built-in limit
const MAX_OUT_CHARS = 100_000;  // truncate runaway output

function trimOutput(text: string, label: string): string {
  if (text.length <= MAX_OUT_CHARS) return text;
  const kept    = text.slice(0, MAX_OUT_CHARS);
  const dropped = text.length - MAX_OUT_CHARS;
  return `${kept}\n\n[${label} truncated — ${dropped} characters omitted]`;
}

function runCommand(command: string): Promise<BashResult> {
  return new Promise((resolve) => {
    const { bin, prefix } = resolveShell();

    const child = spawn(bin, [...prefix, command], {
      cwd:   DEFAULT_CWD,
      env:   process.env as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        returncode: timedOut ? -1 : (code ?? -1),
        stdout:     trimOutput(stdout, "stdout"),
        stderr:     trimOutput(stderr, "stderr"),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ returncode: -1, stdout: "", stderr: `Spawn failed: ${err.message}` });
    });
  });
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "bash-mcp-server", version: "1.0.0" });

// ─── Tool: bash_tool ─────────────────────────────────────────────────────────
// Exact replica of Claude's built-in bash_tool.

const BashToolInput = z.object({
  command: z
    .string()
    .min(1, "command must not be empty")
    .describe("Bash command to run"),

  description: z
    .string()
    .min(1, "description must not be empty")
    .describe("Why I'm running this command"),
}).strict();

type BashToolInput = z.infer<typeof BashToolInput>;

server.registerTool(
  "bash_tool",
  {
    title: "Run Bash Command",
    description:
      `Execute a shell command and return its output.

Exact replica of the bash_tool built into Claude.

Parameters:
  - command     (string, required) : The shell command to run.
                                     Uses bash if available, otherwise falls back to /bin/sh.
  - description (string, required) : Plain-English reason for running the command
                                     (used for logging/auditing, not executed).

Returns JSON:
  {
    "returncode": number,   // exit code of the process (-1 on timeout/failure)
    "stdout":     string,   // standard output captured from the command
    "stderr":     string    // standard error captured from the command
  }

Notes:
  - Timeout: ${TIMEOUT_MS / 1000} seconds (matching Claude's built-in limit)
  - Output is truncated at ${MAX_OUT_CHARS.toLocaleString()} chars per stream
  - All environment variables of the MCP server process are inherited
  - Commands run in WORKING_DIR if set, otherwise the MCP client's cwd
  - Linux and macOS only`,

    inputSchema: BashToolInput,

    annotations: {
      readOnlyHint:    false,
      destructiveHint: true,
      idempotentHint:  false,
      openWorldHint:   true,
    },
  },
  async (params: BashToolInput) => {
    const result = await runCommand(params.command);
    const text   = JSON.stringify(result);

    return {
      content:          [{ type: "text", text }],
      structuredContent: result,
    };
  }
);

// ─── Start (stdio transport) ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`bash-mcp-server ready (stdio${DEFAULT_CWD ? `, cwd: ${DEFAULT_CWD}` : ""})\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});