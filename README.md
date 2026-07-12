# antigravity-mcp

An MCP (Model Context Protocol) server that lets Claude — or any MCP client — delegate heavy work to **Google Antigravity** via the `agy` CLI (Gemini-based agent). Use it to offload web search, large-codebase analysis, file/folder creation and long-running tasks, so the primary model keeps its context small.

## Prerequisites

- **Node.js** 18+ (ships with `npx`).
- **Antigravity CLI (`agy`)** installed and authenticated. Verify with `agy --version`.
  - Get it from https://antigravity.google/docs/cli-getting-started
- If `agy` is not on your `PATH`, set the `AGY_PATH` env var to the binary (see config below).

## Install / configure

Add to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "node",
      "args": ["C:/Dev/Repos/mcp/index.js"],
      "env": {
        "AGY_PATH": "C:/Users/<you>/AppData/Local/agy/bin/agy.exe",
        "AGY_MODEL": "Gemini 3.5 Flash (Medium)",
        "AGY_AUTO_APPROVE": "true"
      },
      "timeout": 900000
    }
  }
}
```

On Windows, the server auto-resolves `agy` to its 8.3 short path (via `cmd`), so a non-ASCII username in the path no longer breaks spawning — setting `AGY_PATH` is optional. If you do set it, any form works; it's collapsed to the short path internally.

Restart the client after editing the config.

## Tools

| Tool | What it does |
|------|--------------|
| `use_antigravity` | Delegate a task (async). Returns a `jobId` immediately. Params: `prompt`, `thinking_depth` (low/high), `add_dirs` (folders agy may read/write), `auto_approve` (skip permission prompts, default true), `new_project`, `model`, `mode` (plan/accept-edits), `agent` (agent profile), `project` (project ID), `sandbox` (terminal-restricted safe run). |
| `antigravity_continue` | Continue the previous conversation (or a specific `conversation_id`) with a new prompt, async via `jobId`. Also accepts `agent` and `sandbox`. |
| `antigravity_result` | Get a job's result by `jobId` — status `running` / `done` / `error` / `not_found`. |
| `antigravity_jobs` | List recent jobs and statuses. |
| `antigravity_cancel` | Kill a running job by `jobId`. |
| `antigravity_cleanup` | Delete old files from `agy_jobs` by age (`older_than_hours`). |
| `antigravity_create_folder` | Create a folder (recursive), done directly by the server. |
| `antigravity_create_file` | Create/write a text file (creates parent dirs). |
| `antigravity_create_tree` | Build a whole folder/file tree from a JSON spec. |
| `antigravity_read_file` | Read a UTF-8 text file (server-side, instant); optional `max_bytes` cap. |
| `antigravity_list_dir` | List a folder's entries. |
| `antigravity_models` | List available models (`agy models`). |
| `antigravity_agents` | List available agent profiles (`agy agents`). |
| `antigravity_health` | Check that `agy` is reachable (version) and report effective defaults + live job count. Run first when something's off. |

## Live progress notifications

Because jobs return a `jobId` immediately, the server pushes MCP **logging notifications** (`notifications/message`, logger `antigravity`) so the client can see activity without polling:

- `job started` — jobId, kind, prompt snippet
- `job running` — heartbeat every `AGY_HEARTBEAT_MS` (default 15s) with a tail of the current partial output
- `job done` / `job failed` — final status, byte count / error

Notifications are best-effort: if the client didn't negotiate the `logging` capability they're silently dropped. `antigravity_result` polling still works either way.

`antigravity_result` includes a live `partial` field while a job is running, so polling clients can see incremental progress before completion.

## How it works (design notes)

The `agy` CLI runs a single prompt with `agy --print "<prompt>"` and returns when done. Three problems and their fixes:

1. **MCP client request timeout (~60s).** Long tasks made the client give up even though `agy` kept running. **Fix:** async job pattern — `use_antigravity` spawns `agy` in the background, returns a `jobId` instantly, and the server writes the result to a JSON file in the OS temp dir (`agy_jobs/`). Clients poll `antigravity_result`. No request ever blocks.
2. **agy's own print timeout (default 5m).** Heavy prompts hit `Error: timeout waiting for response`. **Fix:** every job passes `--print-timeout 10m`.
3. **Headless file-permission gate.** In `--print` mode, agy's file-writes get denied by the "ask" permission policy. **Fix:** `auto_approve` (default true) passes `--dangerously-skip-permissions`; `add_dirs` passes `--add-dir <path>` so agy has the workspace it needs.

Global switches:
- `AGY_MODEL` sets a default model when a tool call omits `model`.
- `AGY_AUTO_APPROVE=false` flips the global default to safe mode.
- `AGY_SANDBOX=true` runs every job with `--sandbox` (terminal-restricted) by default; per-call `sandbox` overrides it.
- `AGY_PRINT_TIMEOUT` overrides the default `--print-timeout` value (`10m` by default).
- `AGY_HEARTBEAT_MS` controls the running-job heartbeat interval (default `15000`; set `0` to disable).
- `AGY_MODEL_TTL_MS` how long the cached `agy models` list is trusted (default `300000`).

Server-side filesystem tools (`create_folder/file/tree`, `list_dir`) use Node's `fs` directly — instant and never gated.

## Security note

`auto_approve` defaults to **true**, which passes `--dangerously-skip-permissions` to `agy` — it will create/edit files and run terminal commands without prompting. This is intentional: in `--print` (headless) mode agy otherwise blocks on a permission prompt and the job hangs. For untrusted prompts, prefer `sandbox: true` (terminal-restricted, cheap — it's a permission layer, not a VM) over turning auto-approve off, since the latter re-introduces the hang. Use `auto_approve: false` only for genuinely read-only asks.

## License

MIT © Türker Yakup.
