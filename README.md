```text
   ____ _                 _
  / ___| | __ _ _   _  __| | ___
 | |   | |/ _` | | | |/ _` |/ _ \
 | |___| | (_| | |_| | (_| |  __/
  \____|_|\__,_|\__,_|\__,_|\___|

               |
          +----+----+
          |   MCP   | (- you are here
          +----+----+
               |

     _          _   _                       _ _
    / \   _ __ | |_(_) __ _ _ __ __ ___   _(_) |_ _   _
   / _ \ | '_ \| __| |/ _` | '__/ _` \ \ / / | __| | | |
  / ___ \| | | | |_| | (_| | | | (_| |\ V /| | |_| |_| |
 /_/   \_\_| |_|\__|_|\__, |_|  \__,_| \_/ |_|\__|\__, |
                      |___/                       |___/
```

<div align="center">

**Let Claude (or any MCP client) hand its heavy work to Google Antigravity's `agy` agent.**

![npm](https://img.shields.io/npm/v/%40turkeryakup%2Fantigravity-mcp?logo=npm&color=cb3837)
![MCP](https://img.shields.io/badge/MCP-server-8A63D2)
![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Platforms](https://img.shields.io/badge/Runs%20on-macOS%20·%20Windows%20·%20Linux-2b90d9)
![Agent](https://img.shields.io/badge/agent-Gemini%20(agy)-4285F4?logo=google&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-3da639)

</div>

---

## What is this?

**@turkeryakup/antigravity-mcp** is a small [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server. It exposes **Google Antigravity** — Google's terminal coding agent, driven by the `agy` CLI (Gemini under the hood) — as a set of tools any MCP client can call.

The idea: your primary model (Claude Desktop, Claude Code, Codex, …) stays lean and delegates the **grunt work** — web search, whole-repo analysis, scaffolding files, long-running edits — to a second agent running in the background. Jobs are **async and unlimited**: you fire a task, get a `jobId` instantly, and poll for the result while the caller keeps working.

```
   Claude / Codex          this MCP server            Antigravity
  +---------------+  tool  +----------------+ spawns  +--------------+
  |  "analyze the | -----> | use_antigravity| ------> | agy  --print |
  |   whole repo" |        | -> jobId(async)|         | (Gemini)     |
  +---------------+ <----- +----------------+ <------ +--------------+
        keeps working        polls result / logs        does the work
```

---

## Requirements

| Need | Why |
|------|-----|
| **Node.js 18+** | Runs this server (ships with `npx`/`npm`). Check: `node --version` |
| **Antigravity CLI (`agy`)** | The agent this server drives. Install below. |
| An **MCP client** | Claude Desktop, Claude Code, or anything that speaks MCP |

---

## Step 1 — Install the Antigravity CLI (`agy`)

> Never used `agy` before? Start here. It's one command. First launch signs you in with Google.

**macOS / Linux**
```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

**Windows (PowerShell)**
```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

**Windows (CMD)**
```cmd
curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd
```

**Where it lands** (remember this — you may need it for `AGY_PATH` below):

| OS | Default `agy` location |
|----|------------------------|
| macOS / Linux | `~/.local/bin/agy` |
| Windows | `C:\Users\<you>\AppData\Local\agy\bin\agy.exe` |

**Sign in and verify:**
```bash
agy            # first run opens a Google Sign-In in your browser (creds cached in your OS keyring)
agy --version  # should print a version, e.g. 1.1.1
agy models     # lists the models you can use (Gemini 3.5 Flash, Gemini 3.1 Pro, ...)
```

If `agy` isn't found afterwards, open a new terminal (so `PATH` reloads) or run `agy install` to fix shell paths.

---

## Step 2 — Get this MCP server

**Option A — npx (recommended, nothing to install):** skip straight to Step 3 and use the `npx` config. npm downloads and runs it on demand.

If you are using GitHub Packages directly, make sure npm is authenticated for the `@turkeryakup` scope and pointed at `https://npm.pkg.github.com/`.

**Option B — from source** (for hacking on it):
```bash
git clone https://github.com/TurkerYakup/mcp-server-google-antigravity.git
cd mcp-server-google-antigravity
npm install
npm run check   # quick syntax check
```

> `node-pty` (used only for clean output on Windows) is an **optional** dependency — if it can't build on macOS/Linux the install still succeeds and the server falls back automatically. No compiler needed.

---

## Step 3 — Register it with your MCP client

<details open>
<summary><b>Claude Desktop</b></summary>

Edit your `claude_desktop_config.json`:

| OS | Config file |
|----|-------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

**Using npx (Option A) — recommended:**
```json
{
  "mcpServers": {
    "antigravity": {
      "command": "npx",
      "args": ["-y", "@turkeryakup/antigravity-mcp"],
      "env": {
        "AGY_MODEL": "Gemini 3.5 Flash (Medium)",
        "AGY_AUTO_APPROVE": "true"
      },
      "timeout": 900000
    }
  }
}
```

**From source (Option B):** set `"command": "node"` and `"args": ["/absolute/path/to/mcp-server-google-antigravity/index.js"]` instead. On **Windows** use forward slashes, e.g. `"C:/Dev/Repos/mcp/index.js"`.

Restart the app fully after editing (quit from the tray/menu bar, not just close the window).
</details>

<details>
<summary><b>Claude Code (CLI)</b> — works on macOS, Windows, Linux</summary>

```bash
# npx (Option A)
claude mcp add antigravity -- npx -y @turkeryakup/antigravity-mcp

# from source (Option B)
claude mcp add antigravity -- node /absolute/path/to/mcp-server-google-antigravity/index.js
```
</details>

That's it. Your client now has tools like `use_antigravity`, `antigravity_continue`, and the filesystem helpers.

---

## Quick example

Ask your MCP client something like *"use antigravity to analyze the repo at C:/Dev/Repos/foo and summarize its architecture"*. Under the hood the client calls:

1. `use_antigravity({ prompt: "...", add_dirs: ["C:/Dev/Repos/foo"] })` → returns `{ "jobId": "mrib1q20_wa5ma1", "status": "running" }` **instantly**.
2. `antigravity_result({ jobId })` — polled until `{ "status": "done", "output": "..." }`.

Follow up in the same session with `antigravity_continue({ prompt: "now list the top 3 risks" })`. Need agy to write files? Pass `add_dirs` so it has a workspace; `auto_approve` (default) lets it create/edit without prompts.

---

## Configuration (environment variables)

Everything is optional — sane defaults out of the box.

| Var | Default | What it does |
|-----|---------|--------------|
| `AGY_PATH` | auto-detected | Full path to the `agy` binary. Only needed if it's not on `PATH`. On Windows the path is auto-collapsed to an 8.3 short path, so a non-ASCII username no longer breaks anything. |
| `AGY_MODEL` | agy's default | Default model when a call omits `model`. Use the exact name from `agy models`, e.g. `Gemini 3.5 Flash (Medium)`. |
| `AGY_AUTO_APPROVE` | `true` | Pass `--dangerously-skip-permissions` so headless jobs don't hang on a prompt. Set `false` for read-only. |
| `AGY_SANDBOX` | `false` | Run every job with `--sandbox` (terminal-restricted). Cheap; safer for untrusted prompts. Per-call `sandbox` overrides. |
| `AGY_PRINT_TIMEOUT` | `10m` | agy's `--print-timeout`. |
| `AGY_HEARTBEAT_MS` | `15000` | Interval for the "job running" progress notification. `0` disables. |
| `AGY_MODEL_TTL_MS` | `300000` | How long the cached `agy models` list is trusted. |

---

## Tools

| Tool | What it does |
|------|--------------|
| `use_antigravity` | Delegate a task (async). Returns a `jobId` immediately. Params: `prompt`, `thinking_depth` (low/high), `add_dirs` (folders agy may read/write), `auto_approve`, `new_project`, `model`, `mode` (plan/accept-edits), `agent`, `project`, `sandbox`, `write_to_file`. |
| `antigravity_continue` | Continue the previous conversation (or a specific `conversation_id`) with a new prompt. |
| `antigravity_result` | Get a job's result by `jobId` — status `running` / `done` / `error` / `not_found`. |
| `antigravity_jobs` | List recent jobs and statuses. |
| `antigravity_cancel` | Kill a running job by `jobId`. |
| `antigravity_cleanup` | Delete old job files by age (`older_than_hours`). |
| `antigravity_create_folder` | Create a folder (recursive), done directly by the server. |
| `antigravity_create_file` | Create/write a text file (creates parent dirs); `overwrite:false` to protect existing. |
| `antigravity_create_tree` | Build a whole folder/file tree from a JSON spec. |
| `antigravity_read_file` | Read a UTF-8 text file (instant); optional `max_bytes` cap. |
| `antigravity_list_dir` | List a folder's entries. |
| `antigravity_models` | List available models (`agy models`). |
| `antigravity_agents` | List available agent profiles (`agy agents`). |
| `antigravity_health` | Check that `agy` is reachable + report effective defaults. **Run this first when something's off.** |

The server-side filesystem tools use Node's `fs` directly — instant, and never gated by a permission prompt.

---

## Live progress notifications

Because jobs return a `jobId` immediately, the server pushes MCP **logging notifications** (`notifications/message`, logger `antigravity`) so the client can see activity without polling:

- `job started` — jobId, kind, prompt snippet
- `job running` — heartbeat every `AGY_HEARTBEAT_MS` (default 15s) with a tail of the current partial output
- `job done` / `job failed` — final status, byte count / error

Best-effort: if the client didn't negotiate the `logging` capability they're silently dropped. Polling `antigravity_result` works either way.

---

## How it works (design notes)

The `agy` CLI runs a single prompt with `agy --print "<prompt>"` and returns when done. Three problems and their fixes:

1. **MCP client request timeout (~60s).** Long tasks made the client give up even though `agy` kept running. → **Async job pattern:** `use_antigravity` spawns `agy` in the background, returns a `jobId` instantly, writes the result to a JSON file in the OS temp dir (`agy_jobs/`), and the client polls `antigravity_result`. No request ever blocks.
2. **agy's own print timeout (default 5m).** Heavy prompts hit `timeout waiting for response`. → every job passes `--print-timeout 10m`.
3. **Headless file-permission gate.** In `--print` mode agy's file-writes get denied by the "ask" policy and the job hangs. → `auto_approve` (default true) passes `--dangerously-skip-permissions`; `add_dirs` passes `--add-dir <path>` for the workspace it needs.

---

## Security note

`auto_approve` defaults to **true** (`--dangerously-skip-permissions`) — agy will create/edit files and run terminal commands without prompting. This is intentional: in headless `--print` mode agy otherwise blocks on a permission prompt and the job hangs. For untrusted prompts, prefer `sandbox: true` (terminal-restricted, cheap — a permission layer, not a VM) over turning auto-approve off. Use `auto_approve: false` only for genuinely read-only asks.

---

## Platform support

Fully cross-platform — **macOS, Windows, and Linux**. Windows gets a `node-pty` path for clean streaming (with an automatic fallback if it's unavailable) and auto 8.3 short-path resolution for non-ASCII usernames; macOS/Linux use plain `child_process`. The only per-OS difference is where `agy` lives and where your client's config file is (both covered above).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `agy not found` / server won't start | Open a **new** terminal so `PATH` reloads, or run `agy install`. Still stuck? Set `AGY_PATH` to the full binary path (Step 1 table). The `antigravity_health` tool confirms whether the server sees `agy`. |
| Job stays `running` forever | agy is probably waiting on a permission prompt. Keep `auto_approve` at its default `true` (headless mode hangs otherwise). Watch progress via `antigravity_jobs` or the job's `partial` field. |
| `Model '...' was not found` warning | Advisory only — the job still runs. Use the **exact** name from `antigravity_models` (they contain spaces, e.g. `Gemini 3.5 Flash (Medium)`). |
| Windows: path breaks on a non-ASCII username | Handled automatically — the server resolves `agy` to its 8.3 short path. No action needed. |
| First run wants you to sign in | Run `agy` once in a terminal to finish the Google Sign-In; credentials are then cached in your OS keyring. |
| Client reports "tool timed out" | Raise the client's own `timeout` (e.g. `900000` ms in Claude Desktop). Jobs are async so the call returns instantly, but some clients still enforce a ceiling. |

---

## License

MIT © Türker Yakup Altınsoy.
