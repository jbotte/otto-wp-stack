/**
 * WP Stack Console — agent-driven dashboard for the otto-wp-stack plugin.
 * Bundled at console-app/ so a fresh Otto can publish it with zero terminal steps.
 *
 * This template is deliberately SCRIPT-FREE and FETCH-FREE (its only fetch is
 * its own same-origin `config.json`) — use it whenever the owner's Otto app
 * cannot approve app scripts (apps below 2.4.0 never can; the gateway only
 * offers the appScripts capability at minAppVersion 2.4.0 and silently drops
 * scripts/ at publish otherwise). It needs no token either.
 *
 * Architecture:
 *  - Reads: everything renders from otto.data, pushed by Otto (agent tool
 *    wp_stack_status -> otto_set_artifact_data) and refreshed on demand, on
 *    visibility/focus changes, and on a slow poll.
 *  - Freshness (0.3.9): the header shows the age of the last push and turns
 *    warning-colored when it is older than the keep-fresh monitor cadence, so
 *    "tile didn't update" is visible instead of mysterious. Tapping ↻ keeps
 *    "waiting for Otto…" up (with a 6s rapid re-pull for a minute) until the
 *    pushed data's ts actually changes.
 *  - Target binding: if `config.json` next to the app holds
 *    { "artifactId": "<artifact id>" } (written by SETUP.md after publish),
 *    every ask names that exact artifact id for the otto_set_artifact_data
 *    push, so a refresh can never land on a different board.
 *  - Writes: every button calls otto.ask(...) with a plain sentence; Otto runs
 *    the matching plugin tool in chat and pushes fresh data back.
 *  - Data may arrive as an object OR a JSON string (the gateway has stored it
 *    both ways) — normalize() accepts both.
 *
 * Data shape (otto.data): { status, sites, ts, notice, details, pending }
 */
import React, { useEffect, useRef, useState } from "react";

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
type Cfg = { artifactId?: string };

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

/** The keep-fresh automation runs every 15 min; past 35 min a push was missed. */
const STALE_AFTER_MS = 35 * 60 * 1000;

function ageLabel(ts?: string | null): string {
  const t = parseTs(ts);
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

/** Optional { artifactId } beside the published app — written by SETUP.md. */
function useConsoleConfig(): Cfg {
  const [cfg, setCfg] = useState<Cfg>({});
  useEffect(() => {
    let dead = false;
    fetch("config.json?cb=" + Date.now(), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!dead && j && typeof j === "object" && j.artifactId) setCfg({ artifactId: String(j.artifactId) });
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

  /** ↻ / action pressed: show a live pending state and rapid re-pull until the
   *  pushed data's ts changes (60s cap; a queued agent turn can take a bit). */
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
    // A phone view that was backgrounded can miss onChange pushes:
    // re-pull when it becomes visible/focused again, and poll as a safety net.
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

  return { data, awaiting, beginAwait };
}

export default function App() {
  const { data, awaiting, beginAwait } = useConsoleData();
  const cfg = useConsoleConfig();
  const [tab, setTab] = useState<"sites" | "new" | "system">("sites");
  const [form, setForm] = useState({ id: "", name: "", adminUser: "admin", email: "" });
  const [confirmDel, setConfirmDel] = useState<Record<string, string>>({});

  const status = data?.status;
  const sites = data?.sites ?? [];
  const dbUp = !!status?.db?.up;
  const bootstrapped = !!status?.runtime?.bootstrapped;
  const notice = data?.notice ?? null;
  const stale = isStale(data?.ts);

  /** Every ask names the exact artifact when config.json gave one. */
  const ask = (text: string) => {
    beginAwait();
    const target = cfg.artifactId
      ? ` Push the fresh data with otto_set_artifact_data into artifact ${cfg.artifactId}.`
      : "";
    window.otto?.ask?.(text + target).catch(() => {});
  };

  const siteAsk = (verb: string, id: string) =>
    ask(`WP Stack: ${verb} the site "${id}". Then refresh the WP Stack Console board.`);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
          {data?.ts ? `updated ${ageLabel(data.ts)}` : "waiting for first update from Otto…"}
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
            <button
              key={t}
              className={"o-btn" + (tab === t ? " o-btn-primary" : "")}
              onClick={() => setTab(t)}
            >
              {t === "sites" ? `Sites (${sites.length})` : t === "new" ? "New site" : "System"}
            </button>
          ))}
          <button className="o-btn" onClick={() => ask(REFRESH_ASK)} disabled={awaiting}>
            {awaiting ? "…" : "↻"}
          </button>
        </div>
      </div>

      {/* runtime banner — one tap installs the whole runtime through chat */}
      {status && !bootstrapped && (
        <div className="o-card" style={{ borderColor: "var(--warn)" }}>
          <b style={{ color: "var(--warn)" }}>Runtime not installed on this Otto</b>
          <div className="o-muted" style={{ fontSize: 13, marginTop: 4 }}>
            The stack downloads and runs its own PHP, WP-CLI and MariaDB (~360 MB, a few minutes, no sudo).
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
          {sites.length === 0 && (
            <div className="o-card o-muted" style={{ fontSize: 13 }}>
              No sites yet. Use <b>New site</b>, or just tell Otto: <i>"make a wp site called demo"</i>.
            </div>
          )}
          {sites.map((s) => (
            <div key={s.id} className="o-card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
                    <button className="o-btn" disabled={awaiting} onClick={() => siteAsk("stop", s.id)}>
                      Stop
                    </button>
                    <button className="o-btn" disabled={awaiting} onClick={() => siteAsk("restart", s.id)}>
                      Restart
                    </button>
                  </>
                ) : (
                  <button className="o-btn o-btn-primary" disabled={awaiting} onClick={() => siteAsk("start", s.id)}>
                    Start
                  </button>
                )}
                <button className="o-btn" disabled={awaiting} onClick={() => siteAsk("show details for", s.id)}>
                  Details
                </button>
                {s.serveUrl ? (
                  <button className="o-btn" disabled={awaiting} onClick={() => siteAsk("remove the HTTPS exposure of", s.id)}>
                    Unserve
                  </button>
                ) : (
                  <button className="o-btn" disabled={awaiting} onClick={() => siteAsk("expose over HTTPS with wp_stack_serve", s.id)}>
                    Serve
                  </button>
                )}
                {s.bind ? (
                  <button className="o-btn" disabled={awaiting} onClick={() => siteAsk("remove the tailnet exposure of (wp_stack_unexpose)", s.id)}>
                    Unexpose
                  </button>
                ) : (
                  !s.serveUrl && (
                    <button className="o-btn" disabled={awaiting} onClick={() => siteAsk("expose on the tailnet with wp_stack_expose", s.id)}>
                      Expose
                    </button>
                  )
                )}
                {(confirmDel[s.id + "_typed"] || "") === s.id ? (
                  <button
                    className="o-btn"
                    style={{ color: "var(--danger)" }}
                    onClick={() => {
                      setConfirmDel((c) => ({ ...c, [s.id + "_typed"]: "" }));
                      siteAsk("delete (I confirmed the id by typing it)", s.id);
                    }}
                  >
                    Confirm delete
                  </button>
                ) : (
                  <input
                    className="o-btn"
                    placeholder={`type "${s.id}" to delete`}
                    value={confirmDel[s.id + "_typed"] || ""}
                    onChange={(e) => setConfirmDel((c) => ({ ...c, [s.id + "_typed"]: e.target.value }))}
                    style={{ width: 150, fontSize: 12 }}
                  />
                )}
              </div>
            </div>
          ))}
          {data?.details && (
            <div className="o-card">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Details — {data.details.id}</div>
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
                {typeof data.details.details === "string"
                  ? data.details.details
                  : JSON.stringify(data.details.details, null, 2)}
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
                className="o-btn"
                style={{ textAlign: "left", fontSize: 14 }}
                placeholder={ph}
                value={(form as any)[k]}
                onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              />
            </label>
          ))}
          <div className="o-muted" style={{ fontSize: 12 }}>
            The one-time admin password is shown once, in this chat.
          </div>
          <button
            className="o-btn o-btn-primary"
            disabled={awaiting || !form.id || !form.name || !form.adminUser || !form.email}
            onClick={() =>
              ask(
                `WP Stack: create a site with id "${form.id}", name "${form.name}", admin user "${form.adminUser}", email "${form.email}". Show the one-time admin password here, then refresh the WP Stack Console board.`
              )
            }
          >
            {awaiting ? "Sent to Otto…" : "Create site"}
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
              className="o-btn"
              disabled={awaiting}
              onClick={() => ask("WP Stack: start the stack database (wp_stack_db start), then refresh the board.")}
            >
              Start db
            </button>
            <button
              className="o-btn"
              disabled={awaiting}
              onClick={() => ask("WP Stack: stop the stack database (wp_stack_db stop), then refresh the board.")}
            >
              Stop db
            </button>
          </div>
          <div className="o-muted" style={{ fontSize: 11, marginTop: 4 }}>
            Console talks to Otto through chat — no token, no scripts, no direct API. Data refreshed{" "}
            {data?.ts ? ageLabel(data.ts) : "never"}.
          </div>
        </div>
      )}

      {awaiting && (
        <div className="o-muted" style={{ fontSize: 12 }}>
          Sent to Otto — waiting for fresh data…
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
