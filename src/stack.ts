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
import {
  ACTIONS,
  SITE_ID_RE,
  bad,
  bootstrapProgressOf,
  createSite,
  dbPing,
  deleteSite,
  listSites,
  loadRegistry,
  portOpen,
  runtimeStatus,
  siteDetails,
  startBootstrap,
  startDb,
  stopDb,
  startSite,
  stopSite,
  stamp,
  run,
  type Out,
  type StackConfig,
} from "./engine.js";

export type { Out, StackConfig };
export { DEFAULTS, resolveConfig, SITE_ID_RE, portOpen, startBootstrap, bootstrapProgressOf } from "./engine.js";

// ---------------------------------------------------------------------------
// Status snapshot for the dashboard
// ---------------------------------------------------------------------------

export async function snapshot(cfg: StackConfig): Promise<Record<string, unknown>> {
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

export async function opFull(cfg: StackConfig): Promise<Out> {
  const [status, sites] = await Promise.all([snapshot(cfg), listSites(cfg)]);
  return { ok: true, status, sites, ts: stamp() };
}

export async function opSites(cfg: StackConfig): Promise<Out> {
  return { ok: true, sites: await listSites(cfg), ts: stamp() };
}

export async function opBootstrap(cfg: StackConfig): Promise<Out> {
  return { ok: true, runtime: await runtimeStatus(cfg), progress: bootstrapProgressOf(cfg), ts: stamp() };
}

/** Install this stack's own runtime (php, wp-cli, mariadb, db init, user). Async; poll opBootstrap. */
export async function opBootstrapRun(cfg: StackConfig): Promise<Out> {
  return startBootstrap(cfg);
}

export async function opDetails(cfg: StackConfig, siteId: string): Promise<Out> {
  if (!SITE_ID_RE.test(siteId)) return bad("invalid site id");
  const site = loadRegistry(cfg).find((s) => s.id === siteId);
  if (!site) return bad("unknown site id");
  return siteDetails(cfg, site);
}

export async function opSiteAction(cfg: StackConfig, siteId: string, action: string): Promise<Out> {
  if (!SITE_ID_RE.test(siteId)) return bad("invalid site id");
  if (!ACTIONS.has(action)) return bad("action must be start|stop|restart");
  const site = loadRegistry(cfg).find((s) => s.id === siteId);
  if (!site) return bad("unknown site id");
  const out: Out = { ok: true, ts: stamp() };
  if (action === "start") {
    const r = await startSite(cfg, site);
    if (!r.ok) return r;
    out.result = r.result;
  } else if (action === "stop") {
    const r = await stopSite(cfg, site);
    if (!r.ok) return r;
    out.result = r.result;
  } else {
    const r1 = await stopSite(cfg, site);
    if (!r1.ok) return r1;
    const r2 = await startSite(cfg, site);
    if (!r2.ok) return r2;
    out.result = "restarted";
  }
  out.sites = await listSites(cfg);
  return out;
}

export async function opCreate(
  cfg: StackConfig,
  id: string,
  name: string,
  adminUser: string,
  email: string,
): Promise<Out> {
  return createSite(cfg, id, name, adminUser, email);
}

export async function opDeleteSite(cfg: StackConfig, id: string, confirm: string): Promise<Out> {
  return deleteSite(cfg, id, confirm);
}

export async function opDbAction(cfg: StackConfig, action: string): Promise<Out> {
  if (action !== "start" && action !== "stop") return bad("action must be start|stop");
  const r = action === "start" ? await startDb(cfg) : await stopDb(cfg);
  if (!r.ok) return r;
  const [status] = await Promise.all([snapshot(cfg)]);
  return { ok: true, message: r.result, status, ts: stamp() };
}

/** Read-only view of Tailscale Serve rules (mutations are owner-side by design). */
export async function serveRules(cfg: StackConfig): Promise<Out> {
  const r = await run(["tailscale", "serve", "status", "--json"], 15_000);
  if (r.code !== 0) return bad((r.stderr || r.stdout || "tailscale serve status failed").slice(0, 150));
  let cfgJson: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Text?: string }> }> };
  try {
    cfgJson = JSON.parse(r.stdout);
  } catch {
    return bad("unexpected serve status output");
  }
  const sites = loadRegistry(cfg);
  const ourPorts = new Set(sites.map((s) => s.port));
  const rules: Array<Record<string, unknown>> = [];
  for (const [host, v] of Object.entries(cfgJson.Web ?? {})) {
    let port: number | null = null;
    try {
      port = parseInt(host.split(":").pop() ?? "", 10);
      if (Number.isNaN(port)) port = null;
    } catch {
      port = null;
    }
    for (const [mount, h] of Object.entries(v.Handlers ?? {})) {
      rules.push({
        host,
        mount,
        target: h.Proxy ?? h.Text ?? "other",
        ours: port !== null && ourPorts.has(port),
      });
    }
  }
  return { ok: true, rules, ts: stamp() };
}

/** Cheap liveness used by the dashboard probe button. */
export async function opProbe(cfg: StackConfig): Promise<Out> {
  const dbUp = await portOpen(cfg.dbHost, cfg.dbPort, 500);
  return { ok: true, plugin: "otto-wp-stack", standalone: true, dbUp, ts: stamp() };
}
