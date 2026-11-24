#!/usr/bin/env node
/**
 * otto-wp-stack — standalone check.
 *
 * Proves the stack is (a) isolated and (b) actually works end-to-end:
 *  A. Isolation gate: no plugin/app code may reference any other stack's
 *     files, panels, workers or units.
 *  B. Live e2e through the ops layer against THIS Otto, using only the
 *     stack's own runtime/database: bootstrap status → db up → create a real
 *     WordPress site → list/details/stop/start → guarded delete.
 *  C. Old-stack files untouched (recorded mtimes reported).
 *
 * Run:  node test/standalone-check.mjs   (from the plugin folder)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveConfig,
  opFull,
  opSites,
  opBootstrap,
  opDetails,
  opSiteAction,
  opCreate,
  opDeleteSite,
  opDbAction,
  opBootstrapRun,
  opServe,
  opUnserve,
  opExpose,
  opUnexpose,
  portOpen,
} from "../dist/stack.js";
import { resolveBindHost } from "../dist/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}

const cfg = resolveConfig({});

// ---------------------------------------------------------------------------
// A. Isolation gate
// ---------------------------------------------------------------------------
const FORBIDDEN = [
  "devenv",
  "wp-worker",
  "wp-stack-status",
  "100.88.223.108",
  "otto-serve-admin",
  "otto-wp-web",
  "otto-wp-db",
  "provision.json",
  "provision-api",
  "8091",
];
const codeFiles = [
  "src/engine.ts",
  "src/stack.ts",
  "src/index.ts",
  "dist/engine.js",
  "dist/stack.js",
  "dist/index.js",
  "openclaw.plugin.json",
  "bin/wp-stack-bootstrap.sh",
  "app/index.tsx",
  "app/scripts/stack.mjs",
  "console-app/index.tsx",
  "SETUP.md",
  "../apps/wp-stack-next/scripts/stack.mjs",
  "../apps/wp-stack-next/index.tsx",
];
let isolationOk = true;
const hits = [];
for (const f of codeFiles) {
  const p = path.join(root, f);
  if (!existsSync(p)) {
    if (f.startsWith("dist/")) continue; // checked after build separately
    continue;
  }
  const text = readFileSync(p, "utf8");
  for (const tok of FORBIDDEN) {
    if (text.includes(tok)) {
      isolationOk = false;
      hits.push(`${f}: "${tok}"`);
    }
  }
}
check("isolation: no old-stack references in plugin/app code", isolationOk, hits.join("; ").slice(0, 200));

// ---------------------------------------------------------------------------
// B. Live e2e (our own runtime + database only)
// ---------------------------------------------------------------------------
const boot = await opBootstrap(cfg);
check("bootstrap: runtime installed", Boolean(boot.ok && boot.runtime?.bootstrapped), JSON.stringify(boot.runtime?.php ?? "") + " " + JSON.stringify(boot.runtime?.mariadb?.version ?? ""));
const bootRun = await opBootstrapRun(cfg);
check("bootstrap: install op is idempotent when already installed", bootRun.ok === true && /already (installed|running)/.test(String(bootRun.result)), String(bootRun.result ?? bootRun.error ?? ""));

if (!boot.runtime?.bootstrapped) {
  console.log("\nRuntime missing — run bin/wp-stack-bootstrap.sh first, then re-run this check.");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const dbUp = await opDbAction(cfg, "start");
check("db: stack database starts", Boolean(dbUp.ok), String(dbUp.message ?? dbUp.error ?? ""));

const full = await opFull(cfg);
check("full: status reports db up on stack port", Boolean(full.ok && full.status?.db?.up === true && full.status?.db?.port === cfg.dbPort), JSON.stringify(full.status?.db));
check("full: runtime user is agent (not root)", full.status?.host?.user === "agent", String(full.status?.host?.user));

// create a real WordPress site through the engine only
const TEST_ID = "stackcheck";
await opDeleteSite(cfg, TEST_ID, TEST_ID); // clean any leftover
const created = await opCreate(cfg, TEST_ID, "Standalone Check", "stackcheck", "check@example.com");
check("create: WordPress site created (own db + own php server)", Boolean(created.ok && created.site), String(created.error ?? created.site?.port ?? ""));

if (created.ok && created.site) {
  const port = created.site.port;
  check("create: db name is stack-prefixed", String(created.site.db).startsWith("wps_" + TEST_ID.replace(/-/g, "_")), created.site.db);
  check("create: one-time admin password surfaced once", /wp-admin/.test(String(created.message)), "");
  const open = await portOpen("127.0.0.1", port, 1500);
  check("create: site port serving", open, `port ${port}`);
  const http = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", `http://127.0.0.1:${port}/`], { encoding: "utf8" });
  check("create: homepage answers 200", http === "200", `http ${http}`);

  const sites = await opSites(cfg);
  const row = (sites.sites ?? []).find((s) => s.id === TEST_ID);
  check("sites: registry lists it running", Boolean(row?.running), JSON.stringify(row ?? null));

  const det = await opDetails(cfg, TEST_ID);
  const ver = String(det.details?.version ?? "");
  check("details: wp-cli reports WordPress version against own db", /^\d+\.\d+/.test(ver), `wp ${ver}`);

  const stopped = await opSiteAction(cfg, TEST_ID, "stop");
  const portDown = !(await portOpen("127.0.0.1", port, 600));
  check("site-action: stop shuts down OUR process", Boolean(stopped.ok) && portDown, "");

  const started = await opSiteAction(cfg, TEST_ID, "start");
  const portUp = await portOpen("127.0.0.1", port, 1500);
  check("site-action: start brings it back", Boolean(started.ok) && portUp, "");

  const badAction = await opSiteAction(cfg, TEST_ID, "explode");
  check("guards: invalid action refused", badAction.ok === false && /start\|stop\|restart/.test(String(badAction.error)));
  const unknown = await opSiteAction(cfg, "no-such-site-xyz", "start");
  check("guards: unknown site refused", unknown.ok === false, "");
  const badPort = await opServe(cfg, TEST_ID, 99);
  check("guards: serve refuses httpsPort outside the whitelist", badPort.ok === false && /integer in/.test(String(badPort.error)), String(badPort.error ?? "").slice(0, 90));
  const exposeUnknown = await opExpose(cfg, "no-such-site-xyz");
  check("guards: expose refuses unknown site", exposeUnknown.ok === false, String(exposeUnknown.error ?? ""));

  // bindHost is whitelisted: loopback / tailnet / IPv4 only — never hostnames,
  // since the value flows into the `php -S <addr>:<port>` argv.
  const bhLoop = await resolveBindHost("127.0.0.1");
  check("bindHost: loopback resolves", bhLoop.ok === true && bhLoop.host === "127.0.0.1", JSON.stringify(bhLoop));
  const bhName = await resolveBindHost("evil.example.com");
  check("bindHost: hostnames refused", bhName.ok === false && /bindHost/.test(String(bhName.error ?? "")), String(bhName.error ?? "").slice(0, 80));
  const bhOctet = await resolveBindHost("100.1024.1.1");
  check("bindHost: octet-overflow IPv4 refused", bhOctet.ok === false, String(bhOctet.error ?? "").slice(0, 80));

  const noConfirm = await opDeleteSite(cfg, TEST_ID, "wrong");
  check("guards: delete requires exact confirm", noConfirm.ok === false, "");

  // serve/unserve: when the agent user is the tailscale operator this exercises
  // the full round-trip; when tailscaled denies mutations (the default on Otto)
  // it verifies the denial carries the actionable operator fix. Both are passes.
  const served = await opServe(cfg, TEST_ID);
  if (served.ok) {
    check("serve: https url minted for the site", /^https:\/\/.+:\d+$/.test(String(served.url)), String(served.url));
    const again = await opServe(cfg, TEST_ID);
    check("serve: idempotent when already served", again.ok === true && /already served/.test(String(again.result)), String(again.result ?? again.error));
    const unserved = await opUnserve(cfg, TEST_ID);
    check("unserve: rule removed + local url restored", Boolean(unserved.ok) && String(unserved.url ?? "").startsWith("http://127.0.0.1:"), String(unserved.url ?? unserved.error));
  } else {
    check("serve: denial returns an actionable tailscale error", /tailscale/i.test(String(served.error ?? "")) && /(operator|sudo|yourself)/i.test(String(served.error ?? "")), String(served.error ?? "").slice(0, 140));
  }

  // expose/unexpose: plain-HTTP tailnet exposure. When tailscale is up this
  // exercises the full round-trip (php -S re-bound to the tailscale IP, URL
  // rewrite, reachability, rollback-safe unexpose); when tailscale is down or
  // unreachable it must answer with an actionable error and leave the site
  // serving on loopback. Both branches are passes.
  const exposed = await opExpose(cfg, TEST_ID);
  if (exposed.ok) {
    const eUrl = String(exposed.url ?? "");
    check("expose: tailnet url minted for the site", /^http:\/\/[a-z0-9.-]+:\d+$/.test(eUrl) && eUrl.endsWith(":" + port), eUrl);
    const rowE = (await opSites(cfg)).sites?.find((s) => s.id === TEST_ID);
    check("expose: registry marks it exposed", rowE?.exposed === true && Boolean(rowE?.exposeUrl), JSON.stringify({ exposed: rowE?.exposed, exposeUrl: rowE?.exposeUrl }));
    const ts = await resolveBindHost("tailnet");
    if (ts.ok) {
      check("expose: site reachable on the tailscale address", await portOpen(ts.host, port, 1500), ts.host + ":" + port);
      const thttp = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", `http://${ts.host}:${port}/`], { encoding: "utf8" });
      check("expose: homepage answers on the tailscale address", thttp === "200" || thttp === "301", `http ${thttp}`);
    } else {
      check("expose: tailscale IP resolvable after successful expose", false, String(ts.error));
    }
    const againE = await opExpose(cfg, TEST_ID);
    check("expose: idempotent when already exposed", againE.ok === true && /already exposed/.test(String(againE.result)), String(againE.result ?? againE.error));
    const serveWhileExposed = await opServe(cfg, TEST_ID);
    check("guards: serve refuses an exposed site", serveWhileExposed.ok === false && /unexpose/i.test(String(serveWhileExposed.error)), String(serveWhileExposed.error ?? "").slice(0, 90));
    const unex = await opUnexpose(cfg, TEST_ID);
    check("unexpose: local url restored", Boolean(unex.ok) && String(unex.url ?? "").startsWith("http://127.0.0.1:"), String(unex.url ?? unex.error));
    const rowU = (await opSites(cfg)).sites?.find((s) => s.id === TEST_ID);
    check("unexpose: registry flag cleared", !rowU?.exposed && !rowU?.exposeUrl, JSON.stringify({ exposed: rowU?.exposed, exposeUrl: rowU?.exposeUrl }));
    const backUp = await portOpen("127.0.0.1", port, 1500);
    check("unexpose: site back on loopback", backUp, `port ${port}`);
    const againU = await opUnexpose(cfg, TEST_ID);
    check("unexpose: idempotent when not exposed", againU.ok === true && /not exposed/.test(String(againU.result)), String(againU.result ?? againU.error));
  } else {
    check("expose: failure is actionable (tailscale down?)", /tailscale|unserve/i.test(String(exposed.error ?? "")), String(exposed.error ?? "").slice(0, 140));
    const rtRow = (await opSites(cfg)).sites?.find((s) => s.id === TEST_ID);
    check("expose: rollback left no exposed flag", !rtRow?.exposed, JSON.stringify({ exposed: rtRow?.exposed }));
    check("expose: rollback left the site on loopback", await portOpen("127.0.0.1", port, 1500), "");
  }

  const del = await opDeleteSite(cfg, TEST_ID, TEST_ID);
  check("delete: site removed (dir + db + registry)", Boolean(del.ok) && !(await portOpen("127.0.0.1", port, 600)), String(del.message ?? del.error));
  const after = await opSites(cfg);
  check("delete: registry clean", !(after.sites ?? []).some((s) => s.id === TEST_ID), "");
}

// ---------------------------------------------------------------------------
// C. Old stack untouched — old-stack files must not have been modified after
// this plugin was built, and must not change between runs of this check
// (baseline recorded next to this file).
// ---------------------------------------------------------------------------
const oldFiles = [
  "/var/lib/otto/owner/agent/workspace/devenv/bin/wp-stack-status.py",
  "/var/lib/otto/owner/agent/workspace/devenv/serve/wp-worker.js",
  "/var/lib/otto/owner/agent/workspace/devenv/serve/otto-serve-admin.js",
];
const pluginBuiltAt = statSync(path.join(root, "dist", "engine.js")).mtimeMs;
const baselinePath = path.join(here, ".mtimes-baseline.json");
let baseline = {};
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch {
  /* first run */
}
const currentMt = {};
for (const f of oldFiles) {
  try {
    const ms = statSync(f).mtimeMs;
    currentMt[f] = ms;
    const touchedAfterBuild = ms > pluginBuiltAt;
    const changedSinceLastRun = baseline[f] !== undefined && baseline[f] !== ms;
    check(
      "untouched: " + path.basename(f),
      !touchedAfterBuild && !changedSinceLastRun,
      statSync(f).mtime.toISOString() + (changedSinceLastRun ? " (changed since last run)" : "") + (touchedAfterBuild ? " (modified after plugin build)" : ""),
    );
  } catch {
    check("untouched: " + path.basename(f), false, "not readable");
  }
}
try {
  writeFileSync(baselinePath, JSON.stringify(currentMt, null, 2));
} catch {
  /* informational */
}

import { spawnSync } from "node:child_process";
const guard = spawnSync(process.execPath, [new URL("./contract-ops-check.mjs", import.meta.url).pathname], { encoding: "utf8" });
check("contract: op ids + app ops valid", guard.status === 0, (guard.stderr || guard.stdout || "").trim().slice(0, 160));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
