#!/usr/bin/env node
/**
 * wp-stack-next / scripts/stack.mjs
 *
 * The dashboard artifact's ONLY way to the backend: translates the dashboard's
 * command-line vocabulary into ONE HTTP call to the otto-wp-stack plugin
 * (/otto-wp-stack/api), and prints exactly ONE JSON object on stdout.
 *
 * - Reads { apiBase, token } from config.json next to the app folder
 *   (same folder as index.tsx). Env vars OTTO_WP_STACK_API / OTTO_WP_STACK_TOKEN
 *   override, for manual testing.
 * - Defensive: never throws to the page, never prints the token.
 *
 * Commands (vocabulary of the standalone stack):
 *   full | sites | rules | bootstrap | probe
 *   details <site-id>
 *   site-action <id> <start|stop|restart>
 *   create <id> <name> <adminUser> <email>
 *   delete-site <id> <id>
 *   db-action <start|stop>       token-check
 *   serve <site-id> [https-port]
 *   unserve <site-id>
 *   expose <site-id>            plain-HTTP tailnet exposure (binds to the Tailscale IP)
 *   unexpose <site-id>
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const env = {};
  if (process.env.OTTO_WP_STACK_API) env.apiBase = process.env.OTTO_WP_STACK_API;
  if (process.env.OTTO_WP_STACK_TOKEN) env.token = process.env.OTTO_WP_STACK_TOKEN;
  for (const p of [path.join(here, "..", "config.json"), path.join(here, "config.json")]) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      return { apiBase: "http://127.0.0.1:18789", token: "", ...j, ...env };
    } catch {
      /* try next */
    }
  }
  return { apiBase: "http://127.0.0.1:18789", token: "", ...env };
}

// Dashboard argv vocabulary -> plugin operation + named args.
function translate(argv) {
  const [cmd, ...a] = argv;
  switch (cmd) {
    case "full": return ["full", {}];
    case "sites": return ["sites", {}];
    case "rules": return ["rules", {}];
    case "bootstrap": return ["bootstrap", {}];
    case "bootstrap-run": return ["bootstrap-run", {}];
    case "probe": return ["probe", {}];
    case "details": return ["details", { siteId: a[0] ?? "" }];
    case "site-action": return ["site-action", { siteId: a[0] ?? "", action: a[1] ?? "" }];
    case "create": return ["create-site", { id: a[0] ?? "", name: a[1] ?? "", adminUser: a[2] ?? "", email: a[3] ?? "" }];
    case "delete-site": return ["delete-site", { id: a[0] ?? "", confirm: a[1] ?? "" }];
    case "db-action": return ["db-action", { action: a[0] ?? "" }];
    case "serve": return ["serve", a[1] ? { siteId: a[0] ?? "", httpsPort: Number(a[1]) } : { siteId: a[0] ?? "" }];
    case "unserve": return ["unserve", { siteId: a[0] ?? "" }];
    case "expose": return ["expose", { siteId: a[0] ?? "" }];
    case "unexpose": return ["unexpose", { siteId: a[0] ?? "" }];
    case "token-check": return ["full", {}]; // cheap authenticated round-trip
    default: return [null, null];
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) { console.log(JSON.stringify({ error: "usage: stack.mjs <command> [args…]" })); return; }
  const [op, args] = translate(argv);
  if (!op) { console.log(JSON.stringify({ error: "unknown command: " + argv[0] })); return; }

  const cfg = loadConfig();
  const token = String(cfg.token ?? "").trim();
  if (!token || token.startsWith("<")) {
    console.log(JSON.stringify({ error: "no API token set — open the app's Settings and paste the token from the otto-wp-stack plugin (.api-token file)." }));
    return;
  }
  const url = String(cfg.apiBase ?? "").replace(/\/+$/, "") + "/otto-wp-stack/api";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 200_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ op, args }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (res.status === 401) { console.log(JSON.stringify({ error: "plugin rejected the token — check Settings (or rotate it)." })); return; }
    try {
      const j = JSON.parse(text);
      j.via = "plugin";
      console.log(JSON.stringify(j));
    } catch {
      console.log(JSON.stringify({ error: `plugin answered ${res.status}: ${text.slice(0, 200)}` }));
    }
  } catch (e) {
    const name = e?.name === "AbortError" ? "timeout" : `${e?.name ?? "Error"}: ${e?.message ?? e}`;
    console.log(JSON.stringify({ error: `plugin unreachable at ${url} — ${name}. Is the otto-wp-stack plugin enabled and the Gateway port right in config.json?`, via: "plugin" }));
  } finally {
    clearTimeout(timer);
  }
}

main();
