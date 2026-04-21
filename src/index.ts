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
 * Works on Linux, macOS, and Windows.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { z } from "zod";

// ─── Platform helpers ─────────────────────────────────────────────────────────

const IS_WINDOWS = os.platform() === "win32";

/** Locate a binary by searching PATH — avoids a shell round-trip. */
function findOnPath(candidates: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const exts  = IS_WINDOWS ? [".exe", ".cmd", ""] : [""];
  for (const name of candidates) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext);
        try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* keep looking */ }
      }
    }
  }
  return null;
}

/**
 * Resolve the shell binary and the argument prefix needed to pass a command
 * string to it (i.e. -c for POSIX shells, /C for cmd, -Command for pwsh).
 */
function resolveShell(): { bin: string; prefix: string[] } {
  if (IS_WINDOWS) {
    const pwsh = findOnPath(["pwsh", "pwsh.exe"]);
    if (pwsh) return { bin: pwsh, prefix: ["-NoProfile", "-Command"] };
    return { bin: "cmd.exe", prefix: ["/C"] };
  }
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
      cwd:         process.cwd(),
      env:         process.env as Record<string, string>,
      stdio:       ["ignore", "pipe", "pipe"],
      shell:       false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill(IS_WINDOWS ? undefined : "SIGKILL");
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
    .describe("Bash command to run in container"),

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
                                     Uses bash on Linux/macOS; PowerShell Core
                                     (pwsh) or cmd.exe on Windows.
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
  - Commands run in the server process's working directory`,

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
  process.stderr.write("bash-mcp-server ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
