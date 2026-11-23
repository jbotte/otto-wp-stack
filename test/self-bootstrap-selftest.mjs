#!/usr/bin/env node
/**
 * otto-wp-stack — self-bootstrap field test.
 *
 * Simulates a FRESH Otto without touching the real stack: runs the plugin's
 * OWN bootstrap op (startBootstrap) against a throwaway stackRoot and a
 * private dbPort, with nothing preinstalled. Proves the "someone with a fresh
 * Otto just presses Install runtime" claim end-to-end:
 *   empty folder → bootstrapRun → php/wp-cli/mariadb downloads → datadir init
 *   → db up → prefix-scoped user → create a real WP site → 200 → delete → stop.
 *
 * Run:  node test/self-bootstrap-selftest.mjs   [stackRoot] [dbPort]
 * Takes ~10 minutes (downloads ~360 MB). Cleans up its own folder at the end.
 */
import { rmSync } from "node:fs";

import { resolveConfig, startBootstrap, opBootstrap, opCreate, opDeleteSite, opDbAction, portOpen } from "../dist/stack.js";

const stackRoot = process.argv[2] ?? "/tmp/wpstack-selftest";
const dbPort = Number(process.argv[3] ?? 3399);
if (!Number.isInteger(dbPort) || dbPort < 1024 || dbPort > 65535) {
  console.log("bad dbPort");
  process.exit(1);
}
if (await portOpen("127.0.0.1", dbPort, 400)) {
  console.log(`port ${dbPort} is already in use — pick another`);
  process.exit(1);
}

const cfg = resolveConfig({ stackRoot, dbPort });
let failed = false;

console.log(`fresh stackRoot: ${stackRoot}  dbPort: ${dbPort}`);
const started = await startBootstrap(cfg);
console.log("start:", JSON.stringify(started));
if (!started.ok) {
  console.log("SELFTEST-FAILED — startBootstrap refused:", started.error);
  rmSync(stackRoot, { recursive: true, force: true });
  process.exit(1);
}

const deadline = Date.now() + 25 * 60_000;
for (;;) {
  let b;
  try {
    b = await opBootstrap(cfg);
  } catch (e) {
    console.log("  poll error (retrying):", String(e?.message ?? e).slice(0, 160));
    if (Date.now() > deadline) {
      console.log("TIMEOUT with poll errors");
      failed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  const p = b.progress ?? {};
  console.log(`  ${new Date().toISOString().slice(11, 19)} phase=${p.phase} running=${p.running}${p.error ? " error=" + p.error : ""}`);
  if (!p.running) break;
  if (Date.now() > deadline) {
    console.log("TIMEOUT waiting for bootstrap");
    failed = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

const b = await opBootstrap(cfg);
if (!failed && (b.progress?.phase !== "ready" || !b.runtime?.bootstrapped)) {
  console.log("BOOTSTRAP FAILED:", JSON.stringify(b.progress?.log?.slice(-10) ?? b.runtime, null, 1));
  failed = true;
}

if (!failed) {
  const created = await opCreate(cfg, "selftest", "Self Test", "selftest", "self@example.com");
  console.log("create:", created.ok, created.site?.port ?? "", String(created.error ?? ""));
  if (!created.ok) failed = true;
  if (created.ok && created.site) {
    const http = await fetch(`http://127.0.0.1:${created.site.port}/`, { signal: AbortSignal.timeout(20_000) })
      .then((r) => r.status)
      .catch((e) => String(e?.name ?? e));
    console.log("homepage:", http);
    if (http !== 200) failed = true;
    const del = await opDeleteSite(cfg, "selftest", "selftest");
    console.log("delete:", del.ok, String(del.error ?? ""));
    if (!del.ok) failed = true;
  }
  const stop = await opDbAction(cfg, "stop");
  console.log("db stop:", stop.ok, String(stop.error ?? ""));
}

if (!failed) {
  rmSync(stackRoot, { recursive: true, force: true });
  console.log("SELFTEST-DONE — fresh-Otto install path works");
} else {
  console.log(`SELFTEST-FAILED — kept ${stackRoot} for post-mortem (logs/mariadb.log, .bootstrap-state.json)`);
}
process.exit(failed ? 1 : 0);
