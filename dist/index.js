/**
 * otto-wp-stack — standalone headless WordPress stack backend for Otto.
 *
 * One implementation, three entrances:
 *  1. Typed agent tools (wp_stack_*) — the agent can drive the stack directly.
 *  2. Session actions (feature contract) — typed, scope-checked operations.
 *  3. Token-authed local HTTP API (/otto-wp-stack/api) — what the dashboard
 *     artifact's script talks to. No Control UI involvement.
 *
 * Standalone by design: this plugin only ever touches its own stackRoot
 * (runtime, registry, database, child processes). It has no dependencies on
 * any other WordPress stack, panel, worker, or systemd unit. Installs to a
 * fresh Otto by copying the folder + running bin/wp-stack-bootstrap.sh
 * (no sudo).
 *
 * Security posture:
 *  - HTTP routes use auth:"plugin" (no operator scopes implied). The only
 *    credential is the plugin-minted api token, compared with timingSafeEqual.
 *  - All validation/whitelisting lives in engine.ts/stack.ts and applies on
 *    every entrance. Site processes are only ever signalled when they are
 *    verifiably ours (exe path + port + docroot match).
 *  - The api token and database credential are never returned by read
 *    operations and never logged.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { DEFAULTS, opBootstrap, opBootstrapRun, opCreate, opDbAction, opDeleteSite, opDetails, opExpose, opFull, opProbe, opServe, opSiteAction, opSites, opUnserve, opUnexpose, resolveConfig, serveRules, } from "./stack.js";
// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
const OUT = Type.Object({
    ok: Type.Optional(Type.Boolean()),
    error: Type.Optional(Type.String()),
    ts: Type.Optional(Type.String()),
});
const contract = defineFeatureContract({
    pluginId: "otto-wp-stack",
    operations: {
        full: {
            kind: "query",
            description: "Full stack snapshot: runtime status, database, sites (what the dashboard stores).",
            input: Type.Object({}),
            output: OUT,
            tool: { name: "wp_stack_status" },
        },
        sites: {
            kind: "query",
            description: "Registered sites with running state and URLs.",
            input: Type.Object({}),
            output: OUT,
            tool: { name: "wp_stack_sites" },
        },
        details: {
            kind: "query",
            description: "WP version, plugins and themes for one site.",
            input: Type.Object({ siteId: Type.String({ minLength: 1, maxLength: 64 }) }),
            output: OUT,
            tool: { name: "wp_stack_details" },
        },
        bootstrap: {
            kind: "query",
            description: "Runtime install status (php, wp-cli, mariadb, db credential) plus in-flight bootstrap progress.",
            input: Type.Object({}),
            output: OUT,
        },
        "bootstrap-run": {
            kind: "action",
            description: "Install the stack's own runtime (static PHP with mysqli, WP-CLI, MariaDB bintar; then db init + stack user). First run downloads ~360 MB and takes several minutes; returns immediately, poll 'bootstrap' for progress. Idempotent.",
            input: Type.Object({}),
            output: OUT,
            tool: { name: "wp_stack_bootstrap" },
        },
        rules: {
            kind: "query",
            description: "Tailscale Serve HTTPS rules (read-only).",
            input: Type.Object({}),
            output: OUT,
        },
        probe: {
            kind: "query",
            description: "Cheap liveness probe (plugin alive, database up).",
            input: Type.Object({}),
            output: OUT,
        },
        "site-action": {
            kind: "action",
            description: "start|stop|restart a site this stack owns.",
            input: Type.Object({
                siteId: Type.String({ minLength: 1, maxLength: 64 }),
                action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("restart")]),
            }),
            output: OUT,
            tool: { name: "wp_stack_site_action" },
        },
        "create-site": {
            kind: "action",
            description: "Create a new WordPress site (own database + own php server). One-time admin password returned once.",
            input: Type.Object({
                id: Type.String({ minLength: 1, maxLength: 64 }),
                name: Type.String({ minLength: 1, maxLength: 120 }),
                adminUser: Type.String({ minLength: 1, maxLength: 60 }),
                email: Type.String({ minLength: 3, maxLength: 254 }),
            }),
            output: OUT,
            tool: { name: "wp_stack_create" },
        },
        "delete-site": {
            kind: "action",
            description: "Delete a site. Requires passing the site id twice (id === confirm).",
            input: Type.Object({
                id: Type.String({ minLength: 1, maxLength: 64 }),
                confirm: Type.String({ minLength: 1, maxLength: 64 }),
            }),
            output: OUT,
            tool: { name: "wp_stack_delete_site" },
        },
        "db-action": {
            kind: "action",
            description: "start|stop this stack's own MariaDB (port is stack-owned, never 3306).",
            input: Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("stop")]) }),
            output: OUT,
            tool: { name: "wp_stack_db" },
        },
        serve: {
            kind: "action",
            description: "Expose a site over HTTPS via Tailscale Serve (tailscale serve --bg --https <port> http://127.0.0.1:<sitePort>) and point WordPress siteurl/home at the served URL. httpsPort is optional — free ports in servePortMin..servePortMax are auto-picked. If tailscale denies the change (agent is not the tailscale operator), the error carries the one-time fix.",
            input: Type.Object({
                siteId: Type.String({ minLength: 1, maxLength: 64 }),
                httpsPort: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
            }),
            output: OUT,
            tool: { name: "wp_stack_serve" },
        },
        unserve: {
            kind: "action",
            description: "Remove a site's Tailscale Serve rule and restore its local http://127.0.0.1:<port> siteurl/home.",
            input: Type.Object({ siteId: Type.String({ minLength: 1, maxLength: 64 }) }),
            output: OUT,
            tool: { name: "wp_stack_unserve" },
        },
        expose: {
            kind: "action",
            description: "Expose a site on the tailnet without Tailscale Serve: binds its own php -S to the live tailscale IPv4 and points WordPress siteurl/home at http://<magicdns>:<sitePort>, so any tailnet device can open the site on its own registry port. No tailscaled mutation, no operator grant, no terminal. Plain HTTP — HTTPS stays the wp_stack_serve path; a site is either served or exposed, never both.",
            input: Type.Object({ siteId: Type.String({ minLength: 1, maxLength: 64 }) }),
            output: OUT,
            tool: { name: "wp_stack_expose" },
        },
        unexpose: {
            kind: "action",
            description: "Undo wp_stack_expose: rebind the site's server to 127.0.0.1 and restore its local siteurl/home.",
            input: Type.Object({ siteId: Type.String({ minLength: 1, maxLength: 64 }) }),
            output: OUT,
            tool: { name: "wp_stack_unexpose" },
        },
        "reveal-token": {
            kind: "action",
            description: "Print the HTTP API token so the owner can paste it into the dashboard app settings.",
            input: Type.Object({}),
            output: Type.Object({ ok: Type.Optional(Type.Boolean()), token: Type.Optional(Type.String()) }),
        },
        "rotate-token": {
            kind: "action",
            description: "Generate a fresh HTTP API token (invalidates the old one).",
            input: Type.Object({}),
            output: Type.Object({ ok: Type.Optional(Type.Boolean()), rotated: Type.Optional(Type.Boolean()) }),
        },
    },
    events: {
        "stack-changed": Type.Object({ op: Type.String() }),
    },
});
// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
const CONFIG_SCHEMA = Type.Object({
    stackRoot: Type.Optional(Type.String({ description: DEFAULTS.stackRoot })),
    dbPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535, description: "Stack-owned MariaDB port (default 3307)." })),
    dbUser: Type.Optional(Type.String({ description: "Stack-owned MariaDB user (default wp_stack)." })),
    portMin: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535, description: "First site port (default 8100)." })),
    portMax: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535, description: "Last site port (default 8199)." })),
    servePortMin: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535, description: "First HTTPS port wp_stack_serve may allocate (default 8443)." })),
    servePortMax: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535, description: "Last HTTPS port wp_stack_serve may allocate (default 8499)." })),
    apiToken: Type.Optional(Type.String({ minLength: 16, description: "Bearer token for /otto-wp-stack/api. If unset, one is generated and written to .api-token in the plugin directory." })),
});
const MUTATIONS = new Set(["site-action", "create-site", "delete-site", "db-action", "bootstrap-run", "serve", "unserve", "expose", "unexpose"]);
/** HTTP alias table so curl/scripts can use short op names. */
const HTTP_ALIASES = {
    full: "full",
    sites: "sites",
    details: "details",
    bootstrap: "bootstrap",
    "bootstrap-run": "bootstrap-run",
    rules: "rules",
    probe: "probe",
    "site-action": "site-action",
    create: "create-site",
    "delete-site": "delete-site",
    "db-action": "db-action",
    serve: "serve",
    unserve: "unserve",
    expose: "expose",
    unexpose: "unexpose",
};
const PLUGIN_VERSION = "0.3.9";
export default (() => {
    const feature = defineFeaturePlugin({
        contract,
        name: "Otto WP Stack",
        description: "Standalone headless WordPress stack: own runtime, database, sites and registry — as agent tools and a token-authed local HTTP API for the Otto dashboard app.",
        setup(api, events) {
            const cfg = resolveConfig(api.pluginConfig);
            const log = api.logger;
            // ---- API token -----------------------------------------------------
            const tokenFile = path.join(api.rootDir ?? process.cwd(), ".api-token");
            let apiToken = typeof api.pluginConfig?.apiToken === "string" && api.pluginConfig.apiToken.length >= 16
                ? api.pluginConfig.apiToken
                : null;
            function loadOrMintToken() {
                if (apiToken)
                    return apiToken;
                try {
                    const existing = fs.readFileSync(tokenFile, "utf8").trim();
                    if (existing.length >= 16) {
                        apiToken = existing;
                        return apiToken;
                    }
                }
                catch {
                    /* no file yet */
                }
                apiToken = crypto.randomBytes(32).toString("hex");
                try {
                    fs.writeFileSync(tokenFile, apiToken + "\n", { mode: 0o600 });
                    log.info(`otto-wp-stack: minted HTTP API token at ${tokenFile} (owner-only file)`);
                }
                catch (e) {
                    log.warn(`otto-wp-stack: could not persist api token file: ${e.message}`);
                }
                return apiToken;
            }
            function tokenOk(provided) {
                const expected = loadOrMintToken();
                const enc = new TextEncoder();
                const a = enc.encode(provided.slice(0, 128));
                const b = enc.encode(expected);
                return a.length === b.length && crypto.timingSafeEqual(a, b);
            }
            // Eagerly mint at load time so `.api-token` exists the moment the plugin is
            // enabled. The handoff flow (fresh Otto installs from ClawHub) reads the file
            // right after enabling; lazy mint would leave it missing until the first
            // authenticated call, which is the chicken-and-egg the setup agent trips on.
            loadOrMintToken();
            // ---- Shared dispatcher (tools + actions + HTTP all land here) ------
            async function invoke(op, a) {
                switch (op) {
                    case "full":
                        return opFull(cfg);
                    case "sites":
                        return opSites(cfg);
                    case "details":
                        return opDetails(cfg, String(a.siteId ?? ""));
                    case "bootstrap":
                        return opBootstrap(cfg);
                    case "bootstrap-run":
                        return opBootstrapRun(cfg);
                    case "rules":
                        return serveRules(cfg);
                    case "probe":
                        return opProbe(cfg);
                    case "site-action":
                        return opSiteAction(cfg, String(a.siteId ?? ""), String(a.action ?? ""));
                    case "create-site":
                        return opCreate(cfg, String(a.id ?? ""), String(a.name ?? ""), String(a.adminUser ?? ""), String(a.email ?? ""));
                    case "delete-site":
                        return opDeleteSite(cfg, String(a.id ?? ""), String(a.confirm ?? ""));
                    case "db-action":
                        return opDbAction(cfg, String(a.action ?? ""));
                    case "serve": {
                        const raw = a.httpsPort;
                        const port = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : undefined;
                        return opServe(cfg, String(a.siteId ?? ""), port);
                    }
                    case "unserve":
                        return opUnserve(cfg, String(a.siteId ?? ""));
                    case "expose":
                        return opExpose(cfg, String(a.siteId ?? ""));
                    case "unexpose":
                        return opUnexpose(cfg, String(a.siteId ?? ""));
                    case "reveal-token":
                        return { ok: true, token: loadOrMintToken() };
                    case "rotate-token": {
                        apiToken = crypto.randomBytes(32).toString("hex");
                        try {
                            fs.writeFileSync(tokenFile, apiToken + "\n", { mode: 0o600 });
                        }
                        catch {
                            /* in-memory only */
                        }
                        log.info("otto-wp-stack: HTTP API token rotated");
                        return { ok: true, rotated: true };
                    }
                    default:
                        return { ok: false, error: "unknown operation: " + op };
                }
            }
            async function invokeAndSignal(op, a) {
                const out = await invoke(op, a);
                if (MUTATIONS.has(op)) {
                    try {
                        events.emit("stack-changed", { op });
                    }
                    catch {
                        /* emitter best-effort */
                    }
                }
                return out;
            }
            // ---- HTTP API for the dashboard artifact ----------------------------
            const MAX_BODY = 64 * 1024;
            function json(res, status, obj) {
                res.statusCode = status;
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.setHeader("X-Content-Type-Options", "nosniff");
                res.end(JSON.stringify(obj));
            }
            function readBody(req) {
                return new Promise((resolve, reject) => {
                    const chunks = [];
                    let size = 0;
                    let settled = false;
                    const failTooLarge = () => {
                        if (settled)
                            return;
                        settled = true;
                        // Stop retaining received bytes and stop receiving more: detach the
                        // listeners and drop what we hold, so an oversized upload cannot
                        // keep growing memory after we already rejected (CWE-400).
                        req.removeAllListeners("data");
                        req.removeAllListeners("end");
                        chunks.length = 0;
                        size = 0;
                        reject(new Error("Request too large"));
                    };
                    req.on("data", (c) => {
                        if (settled)
                            return;
                        size += c.length; // running count — never re-measure the whole buffer
                        if (size > MAX_BODY) {
                            failTooLarge();
                            return;
                        }
                        chunks.push(c);
                    });
                    req.on("end", () => {
                        if (settled)
                            return;
                        settled = true;
                        resolve(Buffer.concat(chunks).toString("utf8"));
                    });
                    req.on("error", (e) => {
                        if (settled)
                            return;
                        settled = true;
                        reject(e);
                    });
                });
            }
            api.registerHttpRoute({
                path: "/otto-wp-stack",
                auth: "plugin",
                match: "prefix",
                handler: async (req, res) => {
                    try {
                        const u = new URL(req.url ?? "/", "http://plugin.local");
                        const p = u.pathname;
                        // CORS so the dashboard can reach this route from a browser fetch
                        // fallback when otto.script is unavailable. The bearer token stays
                        // the only credential; health stays public regardless.
                        res.setHeader("Access-Control-Allow-Origin", typeof req.headers.origin === "string" ? req.headers.origin : "*");
                        res.setHeader("Vary", "Origin");
                        res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
                        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                        if (req.method === "OPTIONS") {
                            res.writeHead(204);
                            res.end();
                            return true;
                        }
                        if (req.method === "GET" && (p === "/otto-wp-stack/health" || p === "/otto-wp-stack/")) {
                            json(res, 200, { ok: true, plugin: "otto-wp-stack", version: PLUGIN_VERSION, standalone: true, ts: new Date().toISOString() });
                            return true;
                        }
                        if (!p.startsWith("/otto-wp-stack/api")) {
                            json(res, 404, { error: "not found" });
                            return true;
                        }
                        const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
                        if (!bearer || !tokenOk(bearer)) {
                            json(res, 401, { error: "unauthorized" });
                            return true;
                        }
                        let op = "";
                        let args = {};
                        if (req.method === "GET") {
                            const seg = p.replace("/otto-wp-stack/api", "").replace(/^\//, "").split("/")[0];
                            op = seg || String(u.searchParams.get("op") ?? "");
                            for (const [k, v] of u.searchParams.entries())
                                if (k !== "op")
                                    args[k] = v;
                        }
                        else if (req.method === "POST") {
                            const declared = Number(req.headers["content-length"] ?? 0);
                            if (Number.isFinite(declared) && declared > MAX_BODY) {
                                json(res, 413, { error: "Request too large" });
                                return true;
                            }
                            let text;
                            try {
                                text = await readBody(req);
                            }
                            catch (e) {
                                const msg = e.message;
                                json(res, msg === "Request too large" ? 413 : 400, { error: msg });
                                return true;
                            }
                            let parsed;
                            try {
                                parsed = JSON.parse(text);
                            }
                            catch {
                                json(res, 400, { error: "body must be JSON: {op, args}" });
                                return true;
                            }
                            op = typeof parsed.op === "string" ? parsed.op : "";
                            args = parsed.args && typeof parsed.args === "object" ? parsed.args : {};
                        }
                        else {
                            json(res, 405, { error: "method not allowed" });
                            return true;
                        }
                        const mapped = HTTP_ALIASES[op] ?? op;
                        if (!mapped) {
                            json(res, 400, { error: "missing op" });
                            return true;
                        }
                        const out = await invokeAndSignal(mapped, args);
                        json(res, 200, out);
                        return true;
                    }
                    catch (e) {
                        try {
                            json(res, 500, { error: `plugin route failed: ${e.message}`.slice(0, 200) });
                        }
                        catch {
                            /* response already sent */
                        }
                        return true;
                    }
                },
            });
            // ---- Feature handlers (agent tools + session actions) ---------------
            const h = {
                full: async () => invoke("full", {}),
                sites: async () => invoke("sites", {}),
                details: async ({ siteId }) => invoke("details", { siteId }),
                bootstrap: async () => invoke("bootstrap", {}),
                "bootstrap-run": async () => invokeAndSignal("bootstrap-run", {}),
                rules: async () => invoke("rules", {}),
                probe: async () => invoke("probe", {}),
                "site-action": async ({ siteId, action }) => invokeAndSignal("site-action", { siteId, action }),
                "create-site": async (i) => invokeAndSignal("create-site", { ...i }),
                "delete-site": async ({ id, confirm }) => invokeAndSignal("delete-site", { id, confirm }),
                "db-action": async ({ action }) => invokeAndSignal("db-action", { action }),
                serve: async ({ siteId, httpsPort }) => invokeAndSignal("serve", { siteId, httpsPort }),
                unserve: async ({ siteId }) => invokeAndSignal("unserve", { siteId }),
                expose: async ({ siteId }) => invokeAndSignal("expose", { siteId }),
                unexpose: async ({ siteId }) => invokeAndSignal("unexpose", { siteId }),
                "reveal-token": async () => invoke("reveal-token", {}),
                "rotate-token": async () => invoke("rotate-token", {}),
            };
            return h;
        },
    });
    return { ...feature, configSchema: CONFIG_SCHEMA };
})();
