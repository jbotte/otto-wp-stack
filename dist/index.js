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
import { DEFAULTS, opBootstrap, opBootstrapRun, opCreate, opDbAction, opDeleteSite, opDetails, opFull, opProbe, opSiteAction, opSites, resolveConfig, serveRules, } from "./stack.js";
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
    apiToken: Type.Optional(Type.String({ minLength: 16, description: "Bearer token for /otto-wp-stack/api. If unset, one is generated and written to .api-token in the plugin directory." })),
});
const MUTATIONS = new Set(["site-action", "create-site", "delete-site", "db-action", "bootstrap-run"]);
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
};
const PLUGIN_VERSION = "0.2.0";
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
                    let text = "";
                    req.on("data", (c) => {
                        text += c.toString("utf8");
                        if (Buffer.byteLength(text) > MAX_BODY)
                            reject(new Error("Request too large"));
                    });
                    req.on("end", () => resolve(text));
                    req.on("error", reject);
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
                            let text;
                            try {
                                text = await readBody(req);
                            }
                            catch (e) {
                                json(res, 400, { error: e.message });
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
                rules: async () => invoke("rules", {}),
                probe: async () => invoke("probe", {}),
                "site-action": async ({ siteId, action }) => invokeAndSignal("site-action", { siteId, action }),
                "create-site": async (i) => invokeAndSignal("create-site", { ...i }),
                "delete-site": async ({ id, confirm }) => invokeAndSignal("delete-site", { id, confirm }),
                "db-action": async ({ action }) => invokeAndSignal("db-action", { action }),
                "reveal-token": async () => invoke("reveal-token", {}),
                "rotate-token": async () => invoke("rotate-token", {}),
            };
            return h;
        },
    });
    return { ...feature, configSchema: CONFIG_SCHEMA };
})();
