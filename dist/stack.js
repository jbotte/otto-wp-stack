/**
 * otto-wp-stack — ops layer (one function per dashboard/plugin operation).
 *
 * Fully standalone: everything goes through engine.ts (our own runtime,
 * registry, database and child processes). This module never touches any
 * other stack's files, services, panels or databases. Every probe is
 * defensive — functions return { ok:false, error } instead of throwing, and
 * credentials never appear in return values or logs.
 */
import * as os from "node:os";
import { ACTIONS, SITE_ID_RE, bad, bootstrapProgressOf, createSite, dbPing, deleteSite, listSites, loadRegistry, portOpen, runtimeStatus, saveRegistry, serveStatusRules, siteDetails, startBootstrap, startDb, stopDb, startSite, stopSite, stamp, servePortsInUse, tailscaleDnsName, tailscaleServeSet, wpCli, } from "./engine.js";
export { DEFAULTS, resolveConfig, SITE_ID_RE, portOpen, startBootstrap, bootstrapProgressOf } from "./engine.js";
// ---------------------------------------------------------------------------
// Status snapshot for the dashboard
// ---------------------------------------------------------------------------
export async function snapshot(cfg) {
    const [rt, db, sites] = await Promise.all([runtimeStatus(cfg), dbPing(cfg), listSites(cfg)]);
    const running = sites.filter((s) => s.running).length;
    return {
        runtime: rt,
        db: {
            up: db.up,
            port: cfg.dbPort,
            version: db.version ?? null,
            error: db.error ?? null,
        },
        sites: { total: sites.length, running },
        ports: { min: cfg.portMin, max: cfg.portMax },
        host: { name: os.hostname(), user: process.getuid?.() === 0 ? "root(!)" : "agent" },
    };
}
// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
export async function opFull(cfg) {
    const [status, sites] = await Promise.all([snapshot(cfg), listSites(cfg)]);
    return { ok: true, status, sites, ts: stamp() };
}
export async function opSites(cfg) {
    return { ok: true, sites: await listSites(cfg), ts: stamp() };
}
export async function opBootstrap(cfg) {
    return { ok: true, runtime: await runtimeStatus(cfg), progress: bootstrapProgressOf(cfg), ts: stamp() };
}
/** Install this stack's own runtime (php, wp-cli, mariadb, db init, user). Async; poll opBootstrap. */
export async function opBootstrapRun(cfg) {
    return startBootstrap(cfg);
}
export async function opDetails(cfg, siteId) {
    if (!SITE_ID_RE.test(siteId))
        return bad("invalid site id");
    const site = loadRegistry(cfg).find((s) => s.id === siteId);
    if (!site)
        return bad("unknown site id");
    return siteDetails(cfg, site);
}
export async function opSiteAction(cfg, siteId, action) {
    if (!SITE_ID_RE.test(siteId))
        return bad("invalid site id");
    if (!ACTIONS.has(action))
        return bad("action must be start|stop|restart");
    const site = loadRegistry(cfg).find((s) => s.id === siteId);
    if (!site)
        return bad("unknown site id");
    const out = { ok: true, ts: stamp() };
    if (action === "start") {
        const r = await startSite(cfg, site);
        if (!r.ok)
            return r;
        out.result = r.result;
    }
    else if (action === "stop") {
        const r = await stopSite(cfg, site);
        if (!r.ok)
            return r;
        out.result = r.result;
    }
    else {
        const r1 = await stopSite(cfg, site);
        if (!r1.ok)
            return r1;
        const r2 = await startSite(cfg, site);
        if (!r2.ok)
            return r2;
        out.result = "restarted";
    }
    out.sites = await listSites(cfg);
    return out;
}
export async function opCreate(cfg, id, name, adminUser, email) {
    return createSite(cfg, id, name, adminUser, email);
}
export async function opDeleteSite(cfg, id, confirm) {
    return deleteSite(cfg, id, confirm);
}
export async function opDbAction(cfg, action) {
    if (action !== "start" && action !== "stop")
        return bad("action must be start|stop");
    const r = action === "start" ? await startDb(cfg) : await stopDb(cfg);
    if (!r.ok)
        return r;
    const [status] = await Promise.all([snapshot(cfg)]);
    return { ok: true, message: r.result, status, ts: stamp() };
}
/** Read-only view of Tailscale Serve rules (mutations go through opServe/opUnserve only). */
export async function serveRules(cfg) {
    const rulesAll = await serveStatusRules();
    if (!rulesAll)
        return bad("tailscale serve status failed (is tailscale up?)");
    const sites = loadRegistry(cfg);
    const ourTargets = new Set(sites.map((s) => `http://127.0.0.1:${s.port}`));
    const ourServePorts = new Set(sites.map((s) => s.servePort).filter((p) => typeof p === "number"));
    const rules = [];
    for (const rule of rulesAll) {
        let hostPort = null;
        const seg = rule.host.split(":").pop() ?? "";
        const p = parseInt(seg, 10);
        if (Number.isFinite(p))
            hostPort = p;
        rules.push({
            host: rule.host,
            mount: rule.mount,
            target: rule.target,
            ours: ourTargets.has(rule.target) || (hostPort !== null && ourServePorts.has(hostPort)),
        });
    }
    return { ok: true, rules, ts: stamp() };
}
// ---------------------------------------------------------------------------
// Serve / Unserve — HTTPS exposure via Tailscale Serve, chat/dashboard driven.
//
// Everything is derived from our own registry: the target is always
// http://127.0.0.1:<registered site port>, and the HTTPS port must be an
// integer inside cfg.servePortMin..servePortMax that no other serve rule (or
// of-ours site) already occupies. WordPress siteurl/home follow the URL and
// are restored on unserve. If tailscaled denies the mutation (the agent user
// is usually not the tailscale operator), the error carries the exact
// one-time fix so the owner can unblock it in one command.
// ---------------------------------------------------------------------------
function agentUser() {
    try {
        return os.userInfo().username;
    }
    catch {
        return String(process.getuid?.() ?? "agent");
    }
}
export async function opServe(cfg, siteId, httpsPort) {
    if (!SITE_ID_RE.test(siteId))
        return bad("invalid site id");
    const sites = loadRegistry(cfg);
    const site = sites.find((s) => s.id === siteId);
    if (!site)
        return bad("unknown site id");
    if (site.servePort && site.serveUrl) {
        return { ok: true, result: "already served", url: site.serveUrl, servePort: site.servePort, ts: stamp() };
    }
    const rt = await runtimeStatus(cfg);
    if (!rt.php.installed || !rt.wpCli.installed) {
        return bad("runtime missing — ask Otto to “install the wp-stack runtime” (wp_stack_bootstrap) first");
    }
    let port = httpsPort ?? null;
    if (port !== null && (!Number.isInteger(port) || port < cfg.servePortMin || port > cfg.servePortMax)) {
        return bad(`httpsPort must be an integer in ${cfg.servePortMin}-${cfg.servePortMax} (settings: servePortMin/servePortMax)`);
    }
    const dns = await tailscaleDnsName();
    if (!dns.ok)
        return bad("tailscale not available: " + dns.error);
    const takenBySites = new Set(sites.filter((s) => s.id !== siteId).map((s) => s.servePort).filter((p) => typeof p === "number"));
    const inUse = await servePortsInUseSafe();
    if (port !== null) {
        const other = sites.find((s) => s.id !== siteId && s.servePort === port);
        if (other)
            return bad(`https port ${port} already serves site "${other.id}"`);
        if (inUse.has(port))
            return bad(`tailscale already serves something on https port ${port} — pick another`);
    }
    else {
        for (let p = cfg.servePortMin; p <= cfg.servePortMax; p++) {
            if (!takenBySites.has(p) && !inUse.has(p)) {
                port = p;
                break;
            }
        }
        if (port === null)
            return bad(`no free https serve port in ${cfg.servePortMin}-${cfg.servePortMax}`);
    }
    const url = `https://${dns.dns}:${port}`;
    const set = await tailscaleServeSet(site.port, port, true);
    if (!set.ok) {
        return bad(`tailscale refused the change (${set.error}) — one-time fix: the device operator runs \`sudo tailscale set --operator=${agentUser()}\` on this Otto, then retry; ` +
            `or expose it once yourself: tailscale serve --bg --https ${port} http://127.0.0.1:${site.port}`);
    }
    const u1 = await wpCli(cfg, site.docroot, ["option", "update", "siteurl", url, "--allow-root"]);
    const u2 = await wpCli(cfg, site.docroot, ["option", "update", "home", url, "--allow-root"]);
    if (u1.code !== 0 || u2.code !== 0) {
        await tailscaleServeSet(site.port, port, false); // roll the rule back — leave no half-served site
        return bad("wp option update failed: " + String(u1.stderr || u1.stdout || u2.stderr || u2.stdout || "wp option update error").slice(0, 180) + " (serve rule rolled back)");
    }
    site.servePort = port;
    site.serveUrl = url;
    saveRegistry(cfg, sites);
    return { ok: true, url, servePort: port, site: { ...site }, sites: await listSites(cfg), ts: stamp() };
}
export async function opUnserve(cfg, siteId) {
    if (!SITE_ID_RE.test(siteId))
        return bad("invalid site id");
    const sites = loadRegistry(cfg);
    const site = sites.find((s) => s.id === siteId);
    if (!site)
        return bad("unknown site id");
    if (!site.servePort)
        return { ok: true, result: "not served", ts: stamp() };
    const port = site.servePort;
    const rm = await tailscaleServeSet(site.port, port, false);
    if (!rm.ok) {
        const stillThere = (await servePortsInUseSafe()).has(port);
        if (stillThere) {
            return bad(`tailscale refused to remove the rule (${rm.error}) — remove it once yourself: tailscale serve --bg=false http://127.0.0.1:${site.port}; ` +
                `the site still points at ${site.serveUrl ?? "the https URL"} until it is gone`);
        }
        // rule already gone (e.g. removed by hand) — continue the restore
    }
    const local = `http://127.0.0.1:${site.port}`;
    let warn = "";
    const rt = await runtimeStatus(cfg);
    if (rt.php.installed && rt.wpCli.installed) {
        const u1 = await wpCli(cfg, site.docroot, ["option", "update", "siteurl", local, "--allow-root"]);
        const u2 = await wpCli(cfg, site.docroot, ["option", "update", "home", local, "--allow-root"]);
        if (u1.code !== 0 || u2.code !== 0) {
            warn = " (wp options could not be restored — check the site's siteurl/home)";
        }
    }
    delete site.servePort;
    delete site.serveUrl;
    saveRegistry(cfg, sites);
    return { ok: true, result: `unserved — site is back at ${local}${warn}`, url: local, sites: await listSites(cfg), ts: stamp() };
}
async function servePortsInUseSafe() {
    try {
        return new Set(await servePortsInUse());
    }
    catch {
        return new Set();
    }
}
/** Cheap liveness used by the dashboard probe button. */
export async function opProbe(cfg) {
    const dbUp = await portOpen(cfg.dbHost, cfg.dbPort, 500);
    return { ok: true, plugin: "otto-wp-stack", standalone: true, dbUp, ts: stamp() };
}
