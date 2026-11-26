/**
 * WP Stack Console — zero-scripts dashboard for the otto-wp-stack plugin.
 * Bundled at console-app/ so a fresh Otto can publish it with zero terminal
 * steps on ANY Otto app version (it needs no scripts capability).
 *
 * Two modes, decided by config.json beside the app:
 *  - REST mode (config.json has apiBase+token): every button and the ↻ talk
 *    straight to the plugin's HTTP API — POST {apiBase}/otto-wp-stack/api
 *    with the bearer token. No scripts, no chat round trip, no model turn.
 *    SETUP.md has the agent write apiBase (the gateway's tailnet-served
 *    https URL) and token (read from the plugin's .api-token) — the owner
 *    never pastes anything.
 *  - Chat mode (config.json without apiBase/token): every button sends Otto a
 *    plain sentence via otto.ask and Otto runs the matching plugin tool and
 *    pushes data back — the conservative default.
 *
 * Data: the otto.data blob is pushed by the keep-fresh automation (agent tool
 * wp_stack_status -> otto_set_artifact_data); REST mode additionally pulls a
 * live "full" snapshot on mount / visibility change / ↻. Tap-triggered asks
 * only fire from a real tap; data is the always-live channel.
 *
 * Data may arrive as an object OR a JSON string — normalize() accepts both.
 * Data shape (otto.data): { status, sites, ts, notice, details, pending }
 */
import React, { useEffect, useRef, useState } from "react";

/** Serve (wp_stack_serve, HTTPS via Tailscale Serve) needs a one-time owner-side
 *  `sudo tailscale set --operator=…` grant an agent cannot prompt for.
 *  Expose (plain-HTTP tailnet binding) remains the zero-grant exposure path. */
const SHOW_SERVE: boolean = false;

type Site = {
  id: string;
  name?: string;
  url?: string;
  port?: number;
  running?: boolean;
  serveUrl?: string;
  servePort?: number;
  bind?: string;
  exposedUrl?: string;
};
type Data = {
  status?: any;
  sites?: Site[];
  ts?: string;
  notice?: { msg: string; ok?: boolean } | null;
  details?: { id: string; details: any } | null;
  pending?: string | null;
};
type Cfg = { artifactId?: string; apiBase?: string; token?: string };

/** The gateway may hand back data as a JSON string, an object, or a
 *  character-indexed string store; accept all three. */
function normalize(d: any): Data | null {
  if (d == null) return null;
  if (typeof d === "string") {
    try {
      return JSON.parse(d) as Data;
    } catch {
      return null;
    }
  }
  if (typeof d === "object") {
    const keys = Object.keys(d);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      try {
        return JSON.parse(keys.sort((a, b) => +a - +b).map((k) => d[k]).join("")) as Data;
      } catch {
        return null;
      }
    }
    return d as Data;
  }
  return null;
}

/** ts pushed by Otto, e.g. "2026-11-24 16:39:22" (device-local). */
function parseTs(ts?: string | null): number | null {
  if (!ts) return null;
  const t = Date.parse(String(ts).trim().replace(" ", "T"));
  return Number.isFinite(t) ? t : null;
}

/** The keep-fresh automation runs every 15–30 min; past 35 min a push was missed. */
const STALE_AFTER_MS = 35 * 60 * 1000;
/** A live read younger than this wins over the pushed blob. */
const LIVE_FRESH_MS = 90 * 1000;

function ageLabel(ts?: string | null, at?: number | null): string {
  const t = at != null ? at : parseTs(ts);
  if (t == null) return ts ? String(ts) : "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m ago`;
}

function isStale(ts?: string | null): boolean {
  const t = parseTs(ts);
  if (t == null) return true;
  return Date.now() - t > STALE_AFTER_MS;
}

/** Tool returns look like { ok, ...payload } — unwrap defensively. */
function unwrapStatus(r: any): any | null {
  if (!r || typeof r !== "object") return null;
  if (r.status && typeof r.status === "object") return r.status;
  if (r.result && typeof r.result === "object") return unwrapStatus(r.result);
  return r.runtime || r.db || r.ports ? r : null;
}
function unwrapSites(r: any): Site[] | null {
  if (Array.isArray(r)) return r as Site[];
  if (r && Array.isArray(r.sites)) return r.sites as Site[];
  if (r && r.result && Array.isArray(r.result.sites)) return r.result.sites as Site[];
  return null;
}
function unwrapDetails(r: any): any {
  if (!r || typeof r !== "object") return r;
  if (r.details) return r.details;
  if (r.result && r.result.details) return r.result.details;
  const { ok, ...rest } = r;
  return Object.keys(rest).length ? rest : r;
}
function pickPassword(r: any): string | null {
  if (!r || typeof r !== "object") return null;
  return r.adminPassword || r.password || r?.result?.adminPassword || r?.data?.adminPassword || null;
}

const REFRESH_ASK =
  "WP Stack Console refresh: call wp_stack_status and push its result into the WP Stack Console app " +
  "with otto_set_artifact_data as {status, sites, ts, notice: null, details: null, pending: null}, " +
  "then tell me the db and site counts in one line.";

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className="o-chip"
      style={{ color: ok ? "var(--ok)" : "var(--danger)", borderColor: ok ? "var(--ok)" : "var(--danger)" }}
    >
      {children}
    </span>
  );
}

/** { artifactId, apiBase?, token? } beside the published app — written by SETUP.md. */
function useConsoleConfig(): Cfg {
  const [cfg, setCfg] = useState<Cfg>({});
  useEffect(() => {
    let dead = false;
    fetch("config.json?cb=" + Date.now(), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!dead && j && typeof j === "object")
          setCfg({
            artifactId: j.artifactId ? String(j.artifactId) : undefined,
            apiBase: j.apiBase ? String(j.apiBase) : undefined,
            token: j.token ? String(j.token) : undefined,
          });
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);
  return cfg;
}

function useConsoleData() {
  const [data, setData] = useState<Data | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  const mounted = useRef(true);
  const lastTs = useRef<string | null>(null);
  const awaitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rapidTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (awaitTimer.current) clearTimeout(awaitTimer.current);
      if (rapidTimer.current) clearInterval(rapidTimer.current);
    };
  }, []);

  const stopAwait = () => {
    setAwaiting(false);
    if (awaitTimer.current) {
      clearTimeout(awaitTimer.current);
      awaitTimer.current = null;
    }
    if (rapidTimer.current) {
      clearInterval(rapidTimer.current);
      rapidTimer.current = null;
    }
  };

  const apply = (d: Data) => {
    const changed = lastTs.current != null && (d.ts ?? null) !== lastTs.current;
    lastTs.current = d.ts ?? null;
    setData(d);
    if (changed) stopAwait();
  };

  const pull = async () => {
    try {
      const raw = (await window.otto?.data?.get?.()) ?? null;
      const d = normalize(raw);
      if (mounted.current && d) apply(d);
    } catch (e) {
      console.log("[wp-console] pull failed", String(e));
    }
  };
  const pullRef = useRef(pull);
  pullRef.current = pull;
  const applyRef = useRef(apply);
  applyRef.current = apply;

  /** action pressed: rapid re-pull until the pushed data's ts changes (60s cap). */
  const beginAwait = () => {
    setAwaiting(true);
    if (rapidTimer.current) clearInterval(rapidTimer.current);
    rapidTimer.current = setInterval(() => pullRef.current(), 6000);
    if (awaitTimer.current) clearTimeout(awaitTimer.current);
    awaitTimer.current = setTimeout(stopAwait, 60000);
  };

  useEffect(() => {
    pullRef.current();
    const off = window.otto?.data?.onChange?.((next: any) => {
      const d = normalize(next);
      if (mounted.current && d) applyRef.current(d);
    });
    const onVis = () => {
      if (document.visibilityState === "visible") pullRef.current();
    };
    const onFocus = () => pullRef.current();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => pullRef.current(), 20000);
    return () => {
      try {
        off?.();
      } catch {}
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, []);

  return { data, awaiting, beginAwait, pull };
}

export default function App() {
  const { data, awaiting, beginAwait, pull } = useConsoleData();
  const cfg = useConsoleConfig();
  const [tab, setTab] = useState<"sites" | "new" | "system">("sites");
  const [form, setForm] = useState({ id: "", name: "", adminUser: "admin", email: "" });
  const [confirmDel, setConfirmDel] = useState<Record<string, string>>({});
  const [live, setLive] = useState<{ status?: any; sites?: Site[]; at: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [created, setCreated] = useState<{ id: string; url?: string; password?: string | null } | null>(null);
  const [detailsLive, setDetailsLive] = useState<{ id: string; details: any } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 9000);
  };

  /** One HTTP call to the plugin route; every op answers { ok, ... }. */
  const call = async (op: string, args: Record<string, unknown> = {}): Promise<any> => {
    if (!cfg.apiBase || !cfg.token)
      throw new Error("tile has no apiBase/token in config.json — ask Otto to re-bind it");
    const res = await fetch(cfg.apiBase.replace(/\/+$/, "") + "/otto-wp-stack/api", {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" },
      body: JSON.stringify({ op, args }),
    });
    const body = await res.json().catch(() => null);
    if (body && typeof body.ok === "boolean") return body;
    return { ok: false, error: "HTTP " + res.status };
  };

  /** REST binding present? (written by SETUP.md; absent => chat mode) */
  const restReady = !!(cfg.apiBase && cfg.token);

  const refreshLive = async () => {
    if (!restReady) return;
    try {
      const r = await call("full");
      const s = unwrapStatus(r);
      let arr = unwrapSites(r);
      if (!arr) {
        const s2 = await call("sites");
        arr = unwrapSites(s2);
      }
      setLive((l) => ({ status: s ?? l?.status, sites: arr ?? l?.sites, at: Date.now() }));
    } catch (e) {
      console.log("[wp-console] live pull failed", String(e));
    }
  };
  const refreshLiveRef = useRef(refreshLive);
  refreshLiveRef.current = refreshLive;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    refreshLiveRef.current();
    const onVis = () => {
      if (document.visibilityState === "visible") refreshLiveRef.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVis);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // config.json lands async — pull again the moment apiBase/token are known.
  useEffect(() => {
    if (cfg.apiBase && cfg.token) refreshLiveRef.current();
  }, [cfg.apiBase, cfg.token]);

  const status = live?.status ?? data?.status;
  const sites = live?.sites ?? data?.sites ?? [];
  const dbUp = !!status?.db?.up;
  const bootstrapped = !!status?.runtime?.bootstrapped;
  const notice = data?.notice ?? null;
  const liveFresh = live != null && Date.now() - live.at < LIVE_FRESH_MS;
  const stale = !liveFresh && isStale(data?.ts);

  /** Chat fallback — used for the long runtime install and the stale-push ask. */
  const ask = (text: string) => {
    beginAwait();
    const target = cfg.artifactId
      ? ` Push the fresh data with otto_set_artifact_data into artifact ${cfg.artifactId}.`
      : "";
    window.otto?.ask?.(text + target).catch(() => {});
  };

  /** Chat-mode sentences — what each button asks Otto to run (v1 behaviour). */
  const chatSentenceFor = (op: string, args: Record<string, unknown>): string => {
    const id = String(args.id ?? args.siteId ?? "");
    switch (op) {
      case "site-action":
        return `WP Stack: ${args.action} the site "${id}". Then refresh the WP Stack Console board.`;
      case "delete-site":
        return `WP Stack: delete the site "${id}" (I confirmed the id by typing it). Then refresh the WP Stack Console board.`;
      case "create-site":
        return (
          `WP Stack: create a site with id "${args.id}", name "${args.name}", admin user "${args.adminUser}", ` +
          `email "${args.email}". Show the one-time admin password here, then refresh the WP Stack Console board.`
        );
      case "db-action":
        return `WP Stack: ${args.action} the stack database (wp_stack_db ${args.action}), then refresh the board.`;
      case "expose":
        return `WP Stack: expose the site "${id}" on the tailnet with wp_stack_expose. Then refresh the WP Stack Console board.`;
      case "unexpose":
        return `WP Stack: remove the tailnet exposure of the site "${id}" (wp_stack_unexpose). Then refresh the WP Stack Console board.`;
      case "serve":
        return `WP Stack: expose the site "${id}" over HTTPS with wp_stack_serve. Then refresh the WP Stack Console board.`;
      case "unserve":
        return `WP Stack: remove the HTTPS exposure of the site "${id}". Then refresh the WP Stack Console board.`;
      default:
        return REFRESH_ASK;
    }
  };

  /** Async-UX: control that should get focus when an op fails (retry target). */
  const focusOnFail = useRef<string | null>(null);

  /** Pending label for buttons + the live region, e.g. stop-my-site -> "Stopping…". */
  const pendingLabel = (key: string): string => {
    if (key === "db-start") return "Starting db…";
    if (key === "db-stop") return "Stopping db…";
    if (key === "create") return "Creating…";
    if (key.startsWith("del-")) return "Deleting…";
    const map: Record<string, string> = {
      stop: "Stopping", start: "Starting", restart: "Restarting",
      expose: "Exposing", unexpose: "Unexposing", serve: "Serving", unserve: "Unserving",
    };
    return (map[key.split("-")[0]] || "Working") + "…";
  };

  /** Plugin action: direct REST when bound; otherwise degrade to a chat ask. */
  const act = async (
    key: string,
    op: string,
    args: Record<string, unknown>,
    onOk?: (res: any) => void,
    failFocusId?: string,
  ) => {
    if (busy) return;
    if (!restReady) {
      ask(chatSentenceFor(op, args));
      onOk?.({ ok: true, degraded: true });
      return;
    }
    focusOnFail.current = failFocusId || "op-" + key;
    setBusy(key);
    let failed = false;
    try {
      const raw = await call(op, args);
      const res = raw && typeof raw === "object" ? raw : {};
      const ok = !("ok" in res) ? true : !!res.ok;
      if (ok) {
        showToast(String(res.message || "done"), true);
        onOk?.(res);
      } else {
        failed = true;
        showToast(String(res.error || res.message || "failed"), false);
      }
    } catch (e) {
      failed = true;
      const msg = String((e as any)?.message || e);
      showToast(
        /HTTP 401|unauthorized/i.test(msg)
          ? `The tile's API token was refused — ask Otto to re-bind config.json. (${msg})`
          : /Failed to fetch|NetworkError|dns/i.test(msg)
            ? `Can't reach the Otto over the tailnet from this device — open the tile on your Mac, or ask Otto in chat. (${msg})`
            : msg,
        false,
      );
    } finally {
      setBusy(null);
      // Async-UX rule: after a failure, focus the control that can retry/fix.
      if (failed)
        setTimeout(() => document.getElementById(focusOnFail.current || "op-" + key)?.focus(), 30);
      refreshLive();
      pull();
    }
  };

  const showDetails = async (id: string) => {
    if (!restReady) {
      ask(`WP Stack: show details for the site "${id}". Then refresh the WP Stack Console board.`);
      return;
    }
    setBusy("details-" + id);
    try {
      const r = await call("details", { siteId: id });
      setDetailsLive({ id, details: unwrapDetails(r) });
    } catch (e) {
      showToast(String((e as any)?.message || e), false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-busy={busy !== null}>
      {/* Header */}
      <div className="o-card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="o-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>WP Stack</div>
          <div className="o-row" style={{ gap: 6 }}>
            <Badge ok={bootstrapped}>{bootstrapped ? "runtime" : "no runtime"}</Badge>
            <Badge ok={dbUp}>{dbUp ? "db up" : "db down"}</Badge>
          </div>
        </div>
        <div className="o-muted" style={{ fontSize: 12, color: stale ? "var(--warn)" : undefined }}>
          {liveFresh
            ? `live · ${ageLabel(null, live!.at)}`
            : data?.ts
              ? `updated ${ageLabel(data.ts)}`
              : "waiting for first update from Otto…"}
          {stale ? " · stale — tap ↻" : ""}
          {status?.db?.version ? ` · ${status.db.version}` : ""}
          {status?.host?.name ? ` · ${status.host.name}` : ""}
        </div>
        {notice && (
          <div
            style={{ fontSize: 13, color: notice.ok === false ? "var(--danger)" : "var(--ok)", wordBreak: "break-word" }}
          >
            {notice.msg}
          </div>
        )}
        <div className="o-row" style={{ gap: 8 }}>
          {(["sites", "new", "system"] as const).map((t) => (
            <button key={t} className={"o-btn" + (tab === t ? " o-btn-primary" : "")} onClick={() => setTab(t)}>
              {t === "sites" ? `Sites (${sites.length})` : t === "new" ? "New site" : "System"}
            </button>
          ))}
          <button
            className="o-btn"
            disabled={busy !== null}
            aria-label="Refresh board now"
            onClick={() => {
              if (restReady) {
                beginAwait();
                refreshLive();
                pull();
              } else {
                ask(REFRESH_ASK);
              }
            }}
          >
            {awaiting || busy !== null ? "…" : "↻"}
          </button>
        </div>
      </div>

      {/* Persistent live regions: pending/success polite, failures assertive. */}
      <div role="status" aria-live="polite" aria-atomic="true">
        {busy || (toast && toast.ok) ? (
          <div
            className="o-card"
            style={{ borderColor: busy ? "var(--accent)" : "var(--ok)", fontSize: 13, wordBreak: "break-word" }}
          >
            <span style={{ color: busy ? "var(--accent)" : "var(--ok)" }}>{busy ? "⟳ " : "✓ "}</span>
            {busy ? pendingLabel(busy) : toast!.msg}
          </div>
        ) : null}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        {toast && !toast.ok ? (
          <div
            className="o-card"
            style={{ borderColor: "var(--danger)", fontSize: 13, wordBreak: "break-word" }}
          >
            <span style={{ color: "var(--danger)" }}>✗ </span>
            {toast.msg}
          </div>
        ) : null}
      </div>

      {/* runtime banner — long install goes through chat, everything else is direct */}
      {status && !bootstrapped && (
        <div className="o-card" style={{ borderColor: "var(--warn)" }}>
          <b style={{ color: "var(--warn)" }}>Runtime not installed on this Otto</b>
          <div className="o-muted" style={{ fontSize: 13, marginTop: 4 }}>
            The stack downloads and runs its own PHP, WP-CLI and MariaDB (~360 MB, several minutes, no sudo). The
            direct button would outlive a single call, so this one goes through chat.
          </div>
          <button
            className="o-btn o-btn-primary"
            style={{ marginTop: 8 }}
            disabled={awaiting}
            onClick={() =>
              ask(
                "WP Stack: install the wp-stack runtime with wp_stack_bootstrap (it may take several minutes — poll wp_stack_status until the phase is ready), then refresh the WP Stack Console board."
              )
            }
          >
            Install runtime (ask Otto)
          </button>
        </div>
      )}

      {tab === "sites" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {created && (
            <div className="o-card" style={{ borderColor: "var(--ok)", display: "flex", flexDirection: "column", gap: 4 }}>
              <div className="o-row" style={{ justifyContent: "space-between" }}>
                <b style={{ color: "var(--ok)" }}>Site “{created.id}” created</b>
                <button className="o-btn" onClick={() => setCreated(null)}>
                  Dismiss
                </button>
              </div>
              {created.url && (
                <a href={created.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                  {created.url}
                </a>
              )}
              {created.password && (
                <div style={{ fontSize: 13 }}>
                  <span className="o-muted">One-time admin password: </span>
                  <code style={{ fontFamily: "var(--font-mono)", color: "var(--warn)" }}>{created.password}</code>
                </div>
              )}
              {!created.password && (
                <div className="o-muted" style={{ fontSize: 12 }}>
                  The one-time admin password was not returned to the tile — ask Otto in chat if you need it.
                </div>
              )}
            </div>
          )}
          {sites.length === 0 && (
            <div className="o-card o-muted" style={{ fontSize: 13 }}>
              No sites yet. Use <b>New site</b>, or just tell Otto: <i>"make a wp site called demo"</i>.
            </div>
          )}
          {sites.map((s) => (
            <div key={s.id} className="o-card" style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-busy={(busy ?? "").endsWith("-" + s.id) || undefined}>
              <div className="o-row" style={{ justifyContent: "space-between" }}>
                <div style={{ fontWeight: 600 }}>{s.name || s.id}</div>
                <div className="o-row" style={{ gap: 6 }}>
                  {s.serveUrl ? <Badge ok={true}>served</Badge> : null}
                  <Badge ok={!!s.running}>{s.running ? "running" : "stopped"}</Badge>
                </div>
              </div>
              <div className="o-muted" style={{ fontSize: 12, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                {s.id}
                {s.port ? ` · :${s.port}` : ""}
                {s.url ? ` · ${s.url}` : ""}
                {s.serveUrl ? ` · ${s.serveUrl}` : ""}
                {s.exposedUrl ? ` · ${s.exposedUrl}` : ""}
              </div>
              <div className="o-row" style={{ gap: 6, flexWrap: "wrap" }}>
                {s.running ? (
                  <>
                    <button
                      id={`op-stop-${s.id}`}
                      className="o-btn"
                      disabled={busy !== null}
                      onClick={() => act(`stop-${s.id}`, "site-action", { siteId: s.id, action: "stop" })}
                    >
                      {busy === `stop-${s.id}` ? "Stopping…" : "Stop"}
                    </button>
                    <button
                      id={`op-restart-${s.id}`}
                      className="o-btn"
                      disabled={busy !== null}
                      onClick={() => act(`restart-${s.id}`, "site-action", { siteId: s.id, action: "restart" })}
                    >
                      {busy === `restart-${s.id}` ? "Restarting…" : "Restart"}
                    </button>
                  </>
                ) : (
                  <button
                    id={`op-start-${s.id}`}
                    className="o-btn o-btn-primary"
                    disabled={busy !== null}
                    onClick={() => act(`start-${s.id}`, "site-action", { siteId: s.id, action: "start" })}
                  >
                    {busy === `start-${s.id}` ? "Starting…" : "Start"}
                  </button>
                )}
                <button className="o-btn" disabled={busy !== null} onClick={() => showDetails(s.id)}>
                  {busy === `details-${s.id}` ? "…" : "Details"}
                </button>
                {SHOW_SERVE &&
                  (s.serveUrl ? (
                    <button
                      id={`op-unserve-${s.id}`}
                      className="o-btn"
                      disabled={busy !== null}
                      onClick={() => act(`unserve-${s.id}`, "unserve", { siteId: s.id })}
                    >
                      {busy === `unserve-${s.id}` ? "Unserving…" : "Unserve"}
                    </button>
                  ) : (
                    <button
                      id={`op-serve-${s.id}`}
                      className="o-btn"
                      disabled={busy !== null}
                      onClick={() => act(`serve-${s.id}`, "serve", { siteId: s.id })}
                    >
                      {busy === `serve-${s.id}` ? "Serving…" : "Serve"}
                    </button>
                  ))}
                {s.bind ? (
                  <button
                    id={`op-unexpose-${s.id}`}
                    className="o-btn"
                    disabled={busy !== null}
                    onClick={() => act(`unexpose-${s.id}`, "unexpose", { siteId: s.id })}
                  >
                    {busy === `unexpose-${s.id}` ? "Unexposing…" : "Unexpose"}
                  </button>
                ) : (
                  !s.serveUrl && (
                    <button
                      id={`op-expose-${s.id}`}
                      className="o-btn"
                      disabled={busy !== null}
                      onClick={() => act(`expose-${s.id}`, "expose", { siteId: s.id })}
                    >
                      {busy === `expose-${s.id}` ? "Exposing…" : "Expose"}
                    </button>
                  )
                )}
                {confirmDel[s.id + "_armed"] ? (
                  <>
                    <input
                      className="o-btn"
                      placeholder={`type "${s.id}" to confirm`}
                      value={confirmDel[s.id + "_typed"] || ""}
                      onChange={(e) => setConfirmDel((c) => ({ ...c, [s.id + "_typed"]: e.target.value }))}
                      readOnly={busy !== null}
                      aria-disabled={busy !== null || undefined}
                      style={{ width: 170, fontSize: 12, opacity: busy !== null ? 0.6 : undefined }}
                    />
                    {(confirmDel[s.id + "_typed"] || "") === s.id ? (
                      <button
                        id={`op-del-${s.id}`}
                        className="o-btn"
                        style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                        disabled={busy !== null}
                        onClick={() => {
                          setConfirmDel((c) => ({ ...c, [s.id + "_armed"]: "", [s.id + "_typed"]: "" }));
                          act(`del-${s.id}`, "delete-site", { id: s.id, confirm: s.id });
                        }}
                      >
                        {busy === `del-${s.id}` ? "Deleting…" : "Confirm delete"}
                      </button>
                    ) : null}
                    <button
                      className="o-btn"
                      disabled={busy !== null}
                      onClick={() => setConfirmDel((c) => ({ ...c, [s.id + "_armed"]: "", [s.id + "_typed"]: "" }))}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="o-btn"
                    style={{ color: "var(--danger)" }}
                    disabled={busy !== null}
                    onClick={() => setConfirmDel((c) => ({ ...c, [s.id + "_armed"]: "1" }))}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
          {(detailsLive || data?.details) && (
            <div className="o-card">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Details — {(detailsLive ?? data?.details)!.id}
              </div>
              <pre
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  color: "var(--muted)",
                  margin: 0,
                }}
              >
                {typeof (detailsLive ?? data?.details)!.details === "string"
                  ? (detailsLive ?? data?.details)!.details
                  : JSON.stringify((detailsLive ?? data?.details)!.details, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {tab === "new" && (
        <div className="o-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(
            [
              ["id", "site id (lowercase, dashes)", "my-site"],
              ["name", "display name", "My Site"],
              ["adminUser", "admin user", "admin"],
              ["email", "admin email", "you@example.com"],
            ] as const
          ).map(([k, label, ph]) => (
            <label key={k} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--muted)" }}>
              {label}
              <input
                id={`wps-field-${k}`}
                className="o-btn"
                style={{ textAlign: "left", fontSize: 14, opacity: busy !== null ? 0.6 : undefined }}
                placeholder={ph}
                value={(form as any)[k]}
                onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                readOnly={busy !== null}
                aria-disabled={busy !== null || undefined}
              />
            </label>
          ))}
          <div className="o-muted" style={{ fontSize: 12 }}>
            Goes straight to the plugin — no chat round trip. The one-time admin password shows here when the tool
            returns it. New sites are auto-exposed on your tailnet.
          </div>
          <button
            className="o-btn o-btn-primary"
            disabled={busy !== null || !form.id || !form.name || !form.adminUser || !form.email}
            onClick={() => {
              const id = form.id.trim();
              // Field values are snapshotted here, before anything locks.
              act(
                "create",
                "create-site",
                { id, name: form.name.trim(), adminUser: form.adminUser.trim(), email: form.email.trim() },
                (res) => {
                  setCreated({
                    id,
                    url: res.url || res.serveUrl || res.exposedUrl || res.site?.url || res.site?.exposedUrl || undefined,
                    password: pickPassword(res),
                  });
                  setForm({ id: "", name: "", adminUser: "admin", email: "" });
                  setTab("sites");
                },
                "wps-field-id",
              );
            }}
          >
            {busy === "create" ? "Creating…" : "Create site"}
          </button>
        </div>
      )}

      {tab === "system" && (
        <div className="o-card" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
          <div className="o-row" style={{ justifyContent: "space-between" }}>
            <span className="o-muted">PHP</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{status?.runtime?.php?.version || "—"}</span>
          </div>
          <div className="o-row" style={{ justifyContent: "space-between" }}>
            <span className="o-muted">WP-CLI</span>
            <span>{status?.runtime?.wpCli?.installed ? "installed" : "missing"}</span>
          </div>
          <div className="o-row" style={{ justifyContent: "space-between" }}>
            <span className="o-muted">MariaDB</span>
            <span>{status?.db?.version || status?.runtime?.mariadb?.version || "—"}</span>
          </div>
          <div className="o-row" style={{ justifyContent: "space-between" }}>
            <span className="o-muted">DB port</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>{status?.db?.port ?? "—"}</span>
          </div>
          <div className="o-row" style={{ justifyContent: "space-between" }}>
            <span className="o-muted">Site ports</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {status?.ports ? `${status.ports.min}–${status.ports.max}` : "—"}
            </span>
          </div>
          <div className="o-row" style={{ gap: 8, marginTop: 4 }}>
            <button
              id="op-db-start"
              className="o-btn"
              disabled={busy !== null}
              onClick={() => act("db-start", "db-action", { action: "start" })}
            >
              {busy === "db-start" ? "Starting db…" : "Start db"}
            </button>
            <button
              id="op-db-stop"
              className="o-btn"
              disabled={busy !== null}
              onClick={() => act("db-stop", "db-action", { action: "stop" })}
            >
              {busy === "db-stop" ? "Stopping db…" : "Stop db"}
            </button>
          </div>
          <div className="o-row" style={{ gap: 8, marginTop: 2 }}>
            <button
              className="o-btn"
              disabled={awaiting}
              onClick={() => ask(REFRESH_ASK)}
            >
              Ask Otto to push fresh data
            </button>
          </div>
          <div className="o-muted" style={{ fontSize: 11, marginTop: 4 }}>
            {restReady
              ? "Buttons call the plugin's REST API directly over the tailnet (no chat round trip); board data is pushed by Otto's keep-fresh job."
              : "Chat mode: buttons send Otto a sentence and Otto runs the matching tool. Ask Otto to bind this tile for direct REST buttons."}
            {" "}
            {liveFresh ? `live ${ageLabel(null, live!.at)}` : data?.ts ? `pushed ${ageLabel(data.ts)}` : "no data yet"}.
          </div>
        </div>
      )}

      {awaiting && busy === null && (
        <div className="o-muted" style={{ fontSize: 12 }}>
          Waiting for Otto's next data push…
        </div>
      )}
    </div>
  );
}

export function Widget() {
  const { data } = useConsoleData();
  const sites = data?.sites ?? [];
  const dbUp = !!data?.status?.db?.up;
  const stale = isStale(data?.ts);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 2 }}>
      <div className="o-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 700 }}>WP Stack</div>
        <Badge ok={dbUp}>{dbUp ? "db up" : "db down"}</Badge>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700 }}>
        {sites.length}{" "}
        <span style={{ fontSize: 13, fontWeight: 400, color: "var(--muted)" }}>
          site{sites.length === 1 ? "" : "s"} · {sites.filter((s) => s.running).length} running
        </span>
      </div>
      <div style={{ fontSize: 11, color: stale ? "var(--warn)" : "var(--muted)" }}>
        {data?.ts ? `updated ${ageLabel(data.ts)}` : "no data yet"}
        {stale ? " · open the app and tap ↻" : ""}
      </div>
    </div>
  );
}
