// Boot smoke test: starts the server with a dummy `agy` path (CI has no agy
// installed) and asserts it launches and stays up without throwing at load
// time. Cross-platform — no shell builtins, pure Node.
const { spawn } = require("child_process");
const path = require("path");

const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
  // Point AGY_PATH at node itself so findAgy() resolves to a real, existing
  // binary and the module can finish loading without a real agy install.
  env: { ...process.env, AGY_PATH: process.execPath },
  stdio: ["ignore", "ignore", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => { stderr += String(d); });

child.on("exit", (code) => {
  if (code && code !== 0) {
    console.error("FAIL: server exited early with code " + code + "\n" + stderr);
    process.exit(1);
  }
});

setTimeout(() => {
  child.kill();
  console.log("OK: server booted and stayed up.");
  process.exit(0);
}, 2500);
