#!/usr/bin/env node
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { spawn, exec, execSync } = require("child_process");
const isWindows = process.platform === "win32";
let pty = null;
if (isWindows) {
  try {
    pty = require("node-pty");
  } catch (e) {
    console.error("[antigravity-mcp] node-pty failed to load; falling back to child_process.spawn on Windows.");
  }
}
// Headless terminal emulator used to correctly resolve agy's TTY repaint frames
// on Windows (it draws its answer by re-painting full-width rows with cursor
// moves, which naive ANSI-stripping concatenates into duplicated text). We
// replay the raw stream through a real VT and read the resulting screen.
let XTermTerminal = null;
try {
  XTermTerminal = require("@xterm/headless").Terminal;
} catch (e) {
  if (isWindows) console.error("[antigravity-mcp] @xterm/headless not available; falling back to stripAnsi (output may duplicate on repaint).");
}
const fs = require("fs");
const os = require("os");
const path = require("path");

const JOBS_DIR = path.join(os.tmpdir(), "agy_jobs");
try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (e) {}
const RUNNING = new Map();
const LAST_CONVERSATION_FILE = path.join(JOBS_DIR, "last_conversation.json");
const DEFAULT_PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || "10m";
const DEFAULT_WATCHDOG_MS = Number(process.env.AGY_WATCHDOG_MS || "660000");
const DEFAULT_MODEL = (process.env.AGY_MODEL || "").trim() || null;
const DEFAULT_AUTO_APPROVE = String(process.env.AGY_AUTO_APPROVE || "true").toLowerCase() !== "false";
const DEFAULT_SANDBOX = String(process.env.AGY_SANDBOX || "false").toLowerCase() === "true";
const HEARTBEAT_MS = Number(process.env.AGY_HEARTBEAT_MS || "15000");
const PARTIAL_LIMIT = 12000;
const PARTIAL_FLUSH_INTERVAL_MS = 500;
const AUTO_KEEP_LAST = 100;
const AUTO_CLEANUP_OLDER_HOURS = Number(process.env.AGY_CLEANUP_HOURS || "168");

let LAST_CONVERSATION_ID = null;
let MODEL_CACHE = null;
let MODEL_CACHE_AT = 0;
const MODEL_CACHE_TTL_MS = Number(process.env.AGY_MODEL_TTL_MS || "300000");

function parseDurationMs(input, fallbackMs) {
  const value = String(input || "").trim();
  if (!value) return fallbackMs;
  const m = value.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!m) return fallbackMs;
  const amount = Number(m[1]);
  const unit = (m[2] || "ms").toLowerCase();
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60000;
  if (unit === "h") return amount * 3600000;
  return fallbackMs;
}

function trimPartial(value) {
  if (!value) return "";
  return value.length > PARTIAL_LIMIT ? value.slice(value.length - PARTIAL_LIMIT) : value;
}

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (e) { return null; }
}

function jobFile(jobId) {
  return path.join(JOBS_DIR, jobId + ".json");
}

function writeJob(jobId, data) {
  try { fs.writeFileSync(jobFile(jobId), JSON.stringify(data)); } catch (e) {}
}

function loadLastConversationId() {
  const saved = safeReadJson(LAST_CONVERSATION_FILE);
  if (saved && typeof saved.conversationId === "string" && saved.conversationId.trim()) {
    LAST_CONVERSATION_ID = saved.conversationId.trim();
  }
}

function persistLastConversationId(conversationId) {
  if (!conversationId) return;
  LAST_CONVERSATION_ID = conversationId;
  try {
    fs.writeFileSync(LAST_CONVERSATION_FILE, JSON.stringify({ conversationId, updatedAt: new Date().toISOString() }));
  } catch (e) {}
}

function extractConversationId(text) {
  if (!text) return null;
  const patterns = [
    /conversation\s*id\s*[:=]\s*([a-z0-9._:-]+)/i,
    /conversation\s*[:=]\s*([a-z0-9._:-]+)/i,
    /resumed\s+conversation\s*[:=]\s*([a-z0-9._:-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

function parseModelsText(text) {
  const rows = String(text || "").split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const models = new Set();
  for (const row of rows) {
    if (/:$/.test(row)) continue; // header lines like "Available models:"
    // Model names can contain spaces/parens, e.g. "Gemini 3.5 Flash (Medium)".
    const candidate = row.replace(/^[-*•]\s*/, "").trim();
    if (candidate && !/[|]/.test(candidate) && /[a-z0-9]/i.test(candidate)) {
      models.add(candidate);
    }
  }
  return Array.from(models);
}

function prewarmModels() {
  exec('"' + AGY_BIN + '" models', { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
    if (err) return;
    const parsed = parseModelsText(stripAnsi(stdout || stderr || ""));
    if (parsed.length) {
      MODEL_CACHE = parsed;
      MODEL_CACHE_AT = Date.now();
    }
  });
}

function resolveModel(requestedModel) {
  const model = (requestedModel || "").trim() || DEFAULT_MODEL;
  if (!model) return { model: null, warning: null };
  const fresh = MODEL_CACHE && MODEL_CACHE.length && (Date.now() - MODEL_CACHE_AT) < MODEL_CACHE_TTL_MS;
  if (!fresh) return { model, warning: null };
  const known = MODEL_CACHE.includes(model);
  return {
    model,
    warning: known ? null : "Model '" + model + "' was not found in `agy models` output. Run antigravity_models to refresh, or check the exact name (they contain spaces, e.g. 'Gemini 3.1 Pro (High)').",
  };
}

function autoPruneStartup() {
  let files = [];
  try {
    files = fs.readdirSync(JOBS_DIR)
      .filter((f) => f.endsWith(".json") && f !== path.basename(LAST_CONVERSATION_FILE))
      .map((f) => {
        const fp = path.join(JOBS_DIR, f);
        const st = fs.statSync(fp);
        return { file: f, path: fp, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (e) {
    return;
  }

  const now = Date.now();
  const olderThanMs = AUTO_CLEANUP_OLDER_HOURS > 0 ? AUTO_CLEANUP_OLDER_HOURS * 3600000 : 0;
  let kept = 0;
  for (const item of files) {
    const tooOld = olderThanMs > 0 ? now - item.mtimeMs > olderThanMs : false;
    const overLimit = kept >= AUTO_KEEP_LAST;
    if (tooOld || overLimit) {
      try { fs.unlinkSync(item.path); } catch (e) {}
      continue;
    }
    kept += 1;
  }
}

function cleanupJobs(olderThanHours) {
  const hours = Number(olderThanHours || 168);
  const cutoff = Date.now() - Math.max(0, hours) * 3600000;
  let scanned = 0;
  let deleted = 0;
  let kept = 0;
  let files = [];
  try { files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json") && f !== path.basename(LAST_CONVERSATION_FILE)); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
  for (const file of files) {
    scanned += 1;
    const fp = path.join(JOBS_DIR, file);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(fp).mtimeMs; } catch (e) { continue; }
    if (mtimeMs < cutoff) {
      try { fs.unlinkSync(fp); deleted += 1; } catch (e) { kept += 1; }
    } else {
      kept += 1;
    }
  }
  return { ok: true, olderThanHours: hours, scanned, deleted, kept };
}

function shortPathWin(p) {
  // Collapse a path to its 8.3 short form (ASCII-only) so a non-ASCII username
  // in the path can't get corrupted when it round-trips through spawn/console.
  try {
    const out = execSync('for %I in ("' + p + '") do @echo %~sI', { encoding: "utf8", windowsHide: true })
      .trim().split(/\r?\n/).filter(Boolean)[0];
    if (out && fs.existsSync(out)) return out;
  } catch (e) {}
  return p;
}

function findAgy() {
  const custom = process.env.AGY_PATH;
  if (custom) return isWindows ? shortPathWin(custom) : custom;
  if (isWindows) {
    // Resolve AND collapse to a short path entirely inside cmd, so `where`'s
    // OEM-encoded output (which mangles non-ASCII usernames when read as UTF-8)
    // never has to survive a decode: we only ever read back the ASCII 8.3 path.
    try {
      const out = execSync('for /f "delims=" %I in (\'where agy\') do @echo %~sI', { encoding: "utf8", windowsHide: true })
        .trim().split(/\r?\n/).filter(Boolean)[0];
      if (out && fs.existsSync(out)) return out;
    } catch (e) {}
  }
  const cmd = isWindows ? "where agy" : "which agy";
  try { return execSync(cmd, { encoding: "utf8" }).trim().split(/\r?\n/)[0]; }
  catch (e) { throw new Error("Antigravity CLI (agy) not found. Install it or set AGY_PATH env var."); }
}
const AGY_BIN = findAgy();

loadLastConversationId();
autoPruneStartup();
prewarmModels();

const server = new McpServer({ name: "antigravity", version: "3.0.0" }, { capabilities: { logging: {} } });

// Emit an MCP logging notification so the client can see what a background job
// is doing in real time (jobs return a jobId immediately, so this is the only
// live activity channel). Silently ignored if the client didn't enable logging.
function logActivity(level, message, extra) {
  try {
    const p = server.server.sendLoggingMessage({
      level,
      logger: "antigravity",
      data: Object.assign({ message }, extra || {}),
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {}
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\[[\?]?[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r/g, "")
    .trim();
}

// Width used for the pty (must match pty.spawn cols below). agy wraps its
// output to this width, so any row that fills it is a soft wrap to be rejoined;
// a shorter row is a genuine line break agy emitted.
const PTY_COLS = 220;
const PTY_ROWS = 50;

// Replay a raw pty stream (with cursor moves / carriage returns / repaint
// frames) through a headless VT emulator and read back the final screen as
// plain text. This is duplication-proof by construction: \r and cursor moves
// overwrite the same cells instead of being stripped into appended text.
// Falls back to stripAnsi if @xterm/headless is unavailable or errors.
function renderTerminal(raw) {
  return new Promise((resolve) => {
    if (!XTermTerminal) { resolve(stripAnsi(raw)); return; }
    let term;
    try {
      term = new XTermTerminal({ cols: PTY_COLS, rows: PTY_ROWS, scrollback: 100000, allowProposedApi: true });
    } catch (e) {
      resolve(stripAnsi(raw));
      return;
    }
    try {
      term.write(raw, () => {
        try {
          const buf = term.buffer.active;
          const logical = [];
          let cur = "";
          let prevFull = false;
          let open = false;
          for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (!line) continue;
            const isFull = lastCellOccupied(line, PTY_COLS);
            const seg = isFull ? line.translateToString(false) : line.translateToString(true);
            if (open && prevFull) {
              cur += seg; // continuation of a soft-wrapped logical line
            } else {
              if (open) logical.push(cur.replace(/\s+$/, ""));
              cur = seg;
              open = true;
            }
            prevFull = isFull;
          }
          if (open) logical.push(cur.replace(/\s+$/, ""));
          while (logical.length && logical[logical.length - 1] === "") logical.pop();
          resolve(logical.join("\n").replace(/\n{3,}/g, "\n\n").trim());
        } catch (e) {
          resolve(stripAnsi(raw));
        } finally {
          try { term.dispose(); } catch (e) {}
        }
      });
    } catch (e) {
      try { term.dispose(); } catch (_) {}
      resolve(stripAnsi(raw));
    }
  });
}

function lastCellOccupied(line, cols) {
  try {
    const cell = line.getCell(cols - 1);
    return !!(cell && cell.getChars() !== "");
  } catch (e) {
    return false;
  }
}

function runAgy(args, jobId, timeout = 660000, handlers = {}) {
  return new Promise((resolve, reject) => {
    let rawOut = "";
    let rawErr = "";
    let done = false;
    let viaPty = false;
    // On the Windows pty path agy repaints its answer, so the raw stream must be
    // resolved through a VT emulator; the piped path is already clean text.
    const cleanStream = (raw) => (viaPty ? renderTerminal(raw) : Promise.resolve(stripAnsi(raw)));
    const ctx = {
      onChunk: typeof handlers.onChunk === "function" ? handlers.onChunk : null,
      onErrorChunk: typeof handlers.onErrorChunk === "function" ? handlers.onErrorChunk : null,
    };
    const onChunk = (chunk) => {
      rawOut += chunk;
      if (typeof ctx.onChunk === "function") ctx.onChunk(chunk, rawOut);
    };
    const onErrorChunk = (chunk) => {
      rawErr += chunk;
      if (typeof ctx.onErrorChunk === "function") ctx.onErrorChunk(chunk, rawErr);
    };

    async function finishOk(exitCode) {
      if (done) return;
      done = true;
      if (jobId) RUNNING.delete(jobId);
      const cleanOutput = await cleanStream(rawOut);
      const cleanErr = stripAnsi(rawErr);
      if (exitCode !== 0) {
        const e = new Error("agy exited with code " + exitCode);
        e.partial = cleanOutput;
        e.stderr = cleanErr;
        e.exitCode = exitCode;
        reject(e);
        return;
      }
      resolve({
        output: cleanOutput || cleanErr || "(no response)",
        partial: trimPartial(cleanOutput || cleanErr),
        stderr: cleanErr,
        exitCode,
        conversationId: extractConversationId(cleanOutput + "\n" + cleanErr),
      });
    }

    async function finishErr(err) {
      if (done) return;
      done = true;
      if (jobId) RUNNING.delete(jobId);
      const cleanOutput = await cleanStream(rawOut);
      const cleanErr = stripAnsi(rawErr);
      const wrapped = err instanceof Error ? err : new Error(String(err));
      wrapped.partial = cleanOutput;
      wrapped.stderr = cleanErr;
      wrapped.conversationId = extractConversationId(cleanOutput + "\n" + cleanErr);
      reject(wrapped);
    }

    const timer = setTimeout(() => {
      try {
        if (jobId && RUNNING.get(jobId)) RUNNING.get(jobId).kill();
      } catch (e) {}
      const e = new Error("agy timed out after " + timeout + "ms");
      e.code = "TIMEOUT";
      finishErr(e);
    }, timeout);

    if (isWindows && pty) {
      viaPty = true;
      const proc = pty.spawn(AGY_BIN, args, { name: "xterm-color", cols: PTY_COLS, rows: PTY_ROWS, env: process.env });
      if (jobId) RUNNING.set(jobId, proc);
      proc.onExit(({ exitCode }) => {
        clearTimeout(timer);
        finishOk(exitCode);
      });
      proc.onData((d) => onChunk(d));
    } else {
      const proc = spawn(AGY_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      if (jobId) RUNNING.set(jobId, proc);
      proc.stdout.on("data", (d) => onChunk(String(d)));
      proc.stderr.on("data", (d) => onErrorChunk(String(d)));
      proc.on("error", (err) => {
        clearTimeout(timer);
        finishErr(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        finishOk(code == null ? 1 : code);
      });
    }
  });
}

const DEPTH_PREFIX = {
  low: "Answer briefly and directly. No need for deep reasoning.",
  high: "Think step by step very carefully before answering.",
};

function newJobId() { return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8); }

function startJob(argsBuilder, meta) {
  const jobId = newJobId();
  const now = new Date().toISOString();
  const build = argsBuilder();
  const record = {
    status: "running",
    startedAt: now,
    kind: meta.kind || "ask",
    prompt: (meta.promptSnippet || "").slice(0, 300),
    args: build.args,
    partial: "",
    warning: build.warning || null,
    conversationId: build.conversationId || null,
  };
  writeJob(jobId, record);
  logActivity("info", "job started", { jobId, kind: record.kind, prompt: record.prompt });

  let heartbeat = null;
  if (HEARTBEAT_MS > 0) {
    heartbeat = setInterval(() => {
      const partial = record.partial || "";
      logActivity("info", "job running", { jobId, chars: partial.length, tail: partial.slice(-160) });
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();
  }
  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };

  // On Windows the raw stream is repaint frames, so intermediate previews must
  // be resolved through the VT emulator too (else the live partial duplicates
  // like the old final output did). renderTerminal falls back to stripAnsi.
  const cleanForDisplay = (raw) => ((isWindows && pty) ? renderTerminal(raw) : Promise.resolve(stripAnsi(raw)));

  let flushTimer = null;
  let pendingRaw = null;
  // doFlush is async (VT render awaits a write callback). A drain loop plus the
  // `flushing` guard keeps overlapping flushes from racing: a flush requested
  // mid-render re-runs after the in-flight one instead of interleaving.
  let flushing = false;
  let flushQueued = false;
  let finalized = false; // set once the job resolves; stops a late intermediate render from clobbering the final partial
  const doFlush = async () => {
    if (flushing) { flushQueued = true; return; }
    flushing = true;
    try {
      do {
        flushQueued = false;
        if (pendingRaw != null) {
          const raw = pendingRaw;
          pendingRaw = null;
          const clean = await cleanForDisplay(raw);
          if (!finalized) {
            record.partial = trimPartial(clean);
            const conv = extractConversationId(clean);
            if (conv) {
              record.conversationId = conv;
              persistLastConversationId(conv);
            }
          }
        }
        writeJob(jobId, record);
      } while (flushQueued);
    } finally {
      flushing = false;
    }
  };
  const flushPartial = (force) => {
    if (force) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      doFlush();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      doFlush();
    }, PARTIAL_FLUSH_INTERVAL_MS);
  };

  runAgy(build.args, jobId, build.watchdogMs || DEFAULT_WATCHDOG_MS, {
    onChunk: (chunk, rawOut) => {
      // Defer the (potentially expensive) ANSI strip to the throttled flush
      // instead of re-stripping the whole accumulated buffer on every chunk.
      pendingRaw = rawOut;
      flushPartial(false);
    },
    onErrorChunk: (chunk, rawErr) => {
      const cleanErr = stripAnsi(rawErr);
      if (cleanErr) {
        record.stderr = trimPartial(cleanErr);
        flushPartial(false);
      }
    },
  })
    .then((result) => {
      stopHeartbeat();
      finalized = true;
      record.status = "done";
      record.finishedAt = new Date().toISOString();
      record.output = result.output;
      record.partial = result.partial || record.partial;
      if (result.stderr) record.stderr = result.stderr;
      if (result.conversationId) {
        record.conversationId = result.conversationId;
        persistLastConversationId(result.conversationId);
      }
      pendingRaw = null; // final partial already set from result; don't re-derive
      flushPartial(true);
      logActivity("info", "job done", { jobId, bytes: (record.output || "").length, conversationId: record.conversationId || null });

      if (build.writeToFile) {
        try {
          fs.mkdirSync(path.dirname(build.writeToFile), { recursive: true });
          fs.writeFileSync(build.writeToFile, result.output, "utf8");
          record.writtenTo = build.writeToFile;
          writeJob(jobId, record);
        } catch (e) {
          record.writeError = String(e.message || e);
          writeJob(jobId, record);
        }
      }
    })
    .catch((err) => {
      stopHeartbeat();
      finalized = true;
      record.status = "error";
      record.finishedAt = new Date().toISOString();
      record.error = String((err && err.message) || err);
      if (err && err.partial) record.partial = trimPartial(String(err.partial));
      if (err && err.stderr) record.stderr = trimPartial(String(err.stderr));
      if (err && err.conversationId) {
        record.conversationId = String(err.conversationId);
        persistLastConversationId(record.conversationId);
      }
      pendingRaw = null;
      flushPartial(true);
      logActivity("error", "job failed", { jobId, error: record.error });
    });

  return jobId;
}

server.tool(
  "use_antigravity",
  "Delegate a task to Antigravity (Gemini). Returns a jobId IMMEDIATELY; poll antigravity_result until done. Good for web search, large-codebase analysis, file/folder creation, viewing images/PDFs. add_dirs grants agy access to specific folders; auto_approve (default true) lets it create/edit files without prompts.",
  {
    prompt: z.string().describe("The question or task to send to Antigravity"),
    thinking_depth: z.enum(["low", "high"]).optional().describe("low = quick, high = deep reasoning"),
    add_dirs: z.array(z.string()).optional().describe("Absolute folder paths to add to agy's workspace so it can read/write them"),
    auto_approve: z.boolean().optional().describe("Auto-approve all tool/file permissions (default true). Set false for cautious/read-only runs."),
    new_project: z.boolean().optional().describe("Create a new Antigravity project for this session"),
    model: z.string().optional().describe("Model id (see antigravity_models)"),
    mode: z.enum(["plan", "accept-edits"]).optional().describe("agy execution mode: plan (read-only planning) or accept-edits (auto-apply edits)"),
    agent: z.string().optional().describe("agy agent profile to use for this session (see antigravity_agents)"),
    project: z.string().optional().describe("agy project ID to run this session under"),
    sandbox: z.boolean().optional().describe("Run agy in a sandbox with terminal restrictions enabled. Safer than auto_approve for untrusted prompts."),
    print_timeout: z.string().optional().describe("agy print timeout, e.g. 10m (default 10m)"),
    write_to_file: z.string().optional().describe("Absolute output file path for final answer mirroring"),
  },
  async ({ prompt, thinking_depth, add_dirs, auto_approve, new_project, model, mode, agent, project, sandbox, print_timeout, write_to_file }) => {
    const prefix = thinking_depth ? DEPTH_PREFIX[thinking_depth] + "\n\n" : "";
    const effectiveAutoApprove = auto_approve == null ? DEFAULT_AUTO_APPROVE : !!auto_approve;
    const effectiveSandbox = sandbox == null ? DEFAULT_SANDBOX : !!sandbox;
    const modelResolved = resolveModel(model);
    const fullPrompt = prefix + prompt;
    const jobId = startJob(() => {
      const args = [];
      if (effectiveAutoApprove) args.push("--dangerously-skip-permissions");
      if (effectiveSandbox) args.push("--sandbox");
      if (new_project) args.push("--new-project");
      if (project) args.push("--project", project);
      if (agent) args.push("--agent", agent);
      if (modelResolved.model) args.push("--model", modelResolved.model);
      if (mode) args.push("--mode", mode);
      args.push("--print-timeout", print_timeout || DEFAULT_PRINT_TIMEOUT);
      (add_dirs || []).forEach((d) => { if (d) args.push("--add-dir", d); });
      args.push("--print", fullPrompt);
      return {
        args,
        warning: modelResolved.warning,
        writeToFile: write_to_file,
        watchdogMs: parseDurationMs(print_timeout || DEFAULT_PRINT_TIMEOUT, DEFAULT_WATCHDOG_MS) + 60000,
      };
    }, { kind: "use", promptSnippet: prompt });
    return { content: [{ type: "text", text: JSON.stringify({ jobId, status: "running", hint: "Poll antigravity_result with this jobId until status is done." }) }] };
  }
);

server.tool(
  "antigravity_continue",
  "Continue the latest agy conversation, or a specific conversation ID.",
  {
    prompt: z.string().describe("Follow-up prompt for the same conversation"),
    conversation_id: z.string().optional().describe("Specific conversation ID. If omitted, uses the last captured one."),
    add_dirs: z.array(z.string()).optional(),
    auto_approve: z.boolean().optional(),
    model: z.string().optional(),
    agent: z.string().optional(),
    sandbox: z.boolean().optional(),
    print_timeout: z.string().optional(),
  },
  async ({ prompt, conversation_id, add_dirs, auto_approve, model, agent, sandbox, print_timeout }) => {
    const effectiveAutoApprove = auto_approve == null ? DEFAULT_AUTO_APPROVE : !!auto_approve;
    const effectiveSandbox = sandbox == null ? DEFAULT_SANDBOX : !!sandbox;
    const selectedConversation = (conversation_id || LAST_CONVERSATION_ID || "").trim();
    const modelResolved = resolveModel(model);

    const jobId = startJob(() => {
      const args = [];
      if (effectiveAutoApprove) args.push("--dangerously-skip-permissions");
      if (effectiveSandbox) args.push("--sandbox");
      if (agent) args.push("--agent", agent);
      if (modelResolved.model) args.push("--model", modelResolved.model);
      args.push("--print-timeout", print_timeout || DEFAULT_PRINT_TIMEOUT);
      (add_dirs || []).forEach((d) => { if (d) args.push("--add-dir", d); });
      if (selectedConversation) args.push("--conversation", selectedConversation);
      else args.push("--continue");
      args.push("--print", prompt);
      return {
        args,
        warning: modelResolved.warning,
        conversationId: selectedConversation || null,
        watchdogMs: parseDurationMs(print_timeout || DEFAULT_PRINT_TIMEOUT, DEFAULT_WATCHDOG_MS) + 60000,
      };
    }, { kind: "continue", promptSnippet: prompt });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          jobId,
          status: "running",
          conversationId: selectedConversation || null,
          hint: "Poll antigravity_result with this jobId until status is done.",
        }),
      }],
    };
  }
);

server.tool(
  "antigravity_result",
  "Get the result of an Antigravity job by jobId. status is running | done | error | not_found. When done, the 'output' field holds agy's full response.",
  { jobId: z.string().describe("jobId returned by a start tool") },
  async ({ jobId }) => {
    const outFile = jobFile(jobId);
    if (!fs.existsSync(outFile)) return { content: [{ type: "text", text: JSON.stringify({ status: "not_found", jobId }) }] };
    return { content: [{ type: "text", text: fs.readFileSync(outFile, "utf8") }] };
  }
);

server.tool(
  "antigravity_jobs",
  "List recent Antigravity jobs and their statuses (most recent first).",
  {},
  async () => {
    let files = [];
    try {
      files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json") && f !== path.basename(LAST_CONVERSATION_FILE));
    } catch (e) {}
    const jobs = files.map((f) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"));
        return { jobId: f.replace(/\.json$/, ""), status: d.status, kind: d.kind, startedAt: d.startedAt, prompt: d.prompt };
      } catch (e) { return { jobId: f.replace(/\.json$/, ""), status: "unreadable" }; }
    }).sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
    return { content: [{ type: "text", text: JSON.stringify(jobs.slice(0, 40), null, 2) }] };
  }
);

server.tool(
  "antigravity_cancel",
  "Cancel a running Antigravity job (kills the agy process) by jobId.",
  { jobId: z.string() },
  async ({ jobId }) => {
    const proc = RUNNING.get(jobId);
    if (!proc) return { content: [{ type: "text", text: JSON.stringify({ status: "not_running", jobId }) }] };
    try { proc.kill(); } catch (e) {}
    RUNNING.delete(jobId);
    const outFile = jobFile(jobId);
    let record = {};
    try { record = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch (e) {}
    fs.writeFileSync(outFile, JSON.stringify(Object.assign(record, { status: "cancelled", finishedAt: new Date().toISOString() })));
    return { content: [{ type: "text", text: JSON.stringify({ status: "cancelled", jobId }) }] };
  }
);

server.tool(
  "antigravity_cleanup",
  "Delete old job JSON files from agy_jobs directory.",
  { older_than_hours: z.number().optional().describe("Delete jobs older than this many hours (default 168)") },
  async ({ older_than_hours }) => {
    const result = cleanupJobs(older_than_hours);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "antigravity_create_folder",
  "Create a folder (recursively) on disk. Instant, done by the server directly (no agy, no permission prompt).",
  { path: z.string().describe("Absolute folder path to create") },
  async ({ path: p }) => {
    try { fs.mkdirSync(p, { recursive: true }); return { content: [{ type: "text", text: JSON.stringify({ ok: true, created: p }) }] }; }
    catch (e) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e.message || e) }) }] }; }
  }
);

server.tool(
  "antigravity_create_file",
  "Create/write a text file on disk (creates parent folders). Set overwrite=false to avoid replacing an existing file.",
  { path: z.string(), content: z.string().optional(), overwrite: z.boolean().optional() },
  async ({ path: p, content, overwrite }) => {
    try {
      if (fs.existsSync(p) && overwrite === false) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "exists" }) }] };
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content == null ? "" : content, "utf8");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, wrote: p, bytes: Buffer.byteLength(content || "") }) }] };
    } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e.message || e) }) }] }; }
  }
);

function buildTree(base, spec, created) {
  fs.mkdirSync(base, { recursive: true });
  for (const name of Object.keys(spec)) {
    const val = spec[name];
    const full = path.join(base, name);
    if (val === null) { fs.mkdirSync(full, { recursive: true }); created.push(full + path.sep); }
    else if (typeof val === "string") { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, val, "utf8"); created.push(full); }
    else if (typeof val === "object") { buildTree(full, val, created); }
  }
}

server.tool(
  "antigravity_create_tree",
  "Create a whole folder/file structure from a JSON spec. In spec: a string value = file with that content, null = empty folder, a nested object = subfolder.",
  { base_path: z.string().describe("Absolute base folder"), spec: z.record(z.any()).describe("Nested structure spec") },
  async ({ base_path, spec }) => {
    const created = [];
    try { buildTree(base_path, spec, created); return { content: [{ type: "text", text: JSON.stringify({ ok: true, base: base_path, created }) }] }; }
    catch (e) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e.message || e) }) }] }; }
  }
);

server.tool(
  "antigravity_list_dir",
  "List entries in a folder on disk.",
  { path: z.string() },
  async ({ path: p }) => {
    try {
      const items = fs.readdirSync(p, { withFileTypes: true }).map((d) => (d.isDirectory() ? "[DIR] " : "[FILE] ") + d.name);
      return { content: [{ type: "text", text: items.join("\n") || "(empty)" }] };
    } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e.message || e) }) }] }; }
  }
);

server.tool(
  "antigravity_models",
  "List available Antigravity/Gemini models (runs `agy models`).",
  {},
  async () => {
    try {
      const out = execSync('"' + AGY_BIN + '" models', { encoding: "utf8", timeout: 30000 });
      const clean = stripAnsi(out);
      const parsed = parseModelsText(clean);
      if (parsed.length) {
        MODEL_CACHE = parsed;
        MODEL_CACHE_AT = Date.now();
      }
      return { content: [{ type: "text", text: clean }] };
    }
    catch (e) { return { content: [{ type: "text", text: String((e && e.message) || e) }] }; }
  }
);

server.tool(
  "antigravity_read_file",
  "Read a UTF-8 text file from disk (server-side, instant, no agy). Optionally cap bytes returned.",
  { path: z.string().describe("Absolute file path to read"), max_bytes: z.number().optional().describe("Return at most this many bytes (from the start).") },
  async ({ path: p, max_bytes }) => {
    try {
      if (!fs.existsSync(p)) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "not_found", path: p }) }] };
      const st = fs.statSync(p);
      if (st.isDirectory()) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "is_directory", path: p }) }] };
      let text = fs.readFileSync(p, "utf8");
      const total = Buffer.byteLength(text);
      let truncated = false;
      if (max_bytes && total > max_bytes) { text = text.slice(0, max_bytes); truncated = true; }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, path: p, bytes: total, truncated, content: text }) }] };
    } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e.message || e) }) }] }; }
  }
);

server.tool(
  "antigravity_agents",
  "List available agy agent profiles (runs `agy agents`). Use the name with the `agent` param of use_antigravity.",
  {},
  async () => {
    try {
      const out = execSync('"' + AGY_BIN + '" agents', { encoding: "utf8", timeout: 30000, windowsHide: true });
      return { content: [{ type: "text", text: stripAnsi(out) || "(no agents)" }] };
    } catch (e) { return { content: [{ type: "text", text: String((e && e.message) || e) }] }; }
  }
);

server.tool(
  "antigravity_health",
  "Check that the agy CLI is reachable (version) and report the server's effective defaults and live job count. Run this first when something isn't working.",
  {},
  async () => {
    const info = {
      agyBin: AGY_BIN,
      defaults: {
        model: DEFAULT_MODEL,
        autoApprove: DEFAULT_AUTO_APPROVE,
        sandbox: DEFAULT_SANDBOX,
        printTimeout: DEFAULT_PRINT_TIMEOUT,
        heartbeatMs: HEARTBEAT_MS,
      },
      modelsCached: (MODEL_CACHE || []).length,
      runningJobs: RUNNING.size,
    };
    try {
      info.version = stripAnsi(execSync('"' + AGY_BIN + '" --version', { encoding: "utf8", timeout: 15000, windowsHide: true }));
      info.ok = true;
    } catch (e) {
      info.ok = false;
      info.error = String((e && e.message) || e);
    }
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
server.connect(transport);
