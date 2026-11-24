/**
 * WP Stack Console — agent-driven dashboard for the otto-wp-stack plugin.
 * Bundled at console-app/ so a fresh Otto can publish it with zero terminal steps.
 *
 * This template is deliberately SCRIPT-FREE and FETCH-FREE — use it whenever
 * the owner's Otto app cannot approve app scripts (apps below 2.4.0 never can;
 * the gateway only offers the appScripts capability at minAppVersion 2.4.0 and
 * silently drops scripts/ at publish otherwise). It needs no token either.
 *
 * Architecture:
 *  - Reads: everything renders from otto.data, pushed by Otto (agent tool
 *    wp_stack_status -> otto_set_artifact_data) and refreshed on demand, on
 *    visibility changes, and on a slow poll.
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
  exposed?: boolean;
  exposeUrl?: string;
};
type Data = {
  status?: any;
  sites?: Site[];
  ts?: string;
  notice?: { msg: string; ok?: boolean } | null;
  details?: { id: string; details: any } | null;
  pending?: string | null;
};

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

const REFRESH_ASK =
  "WP Stack Console refresh: call wp_stack_status and push its result into the WP Stack Console app (this board) " +
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

function ask(text: string, setPending: (s: string | null) => void) {
  setPending(text);
  window.otto?.ask?.(text).catch(() => {});
  setTimeout(() => setPending(null), 4000);
}

function useConsoleData() {
  const [data, setData] = useState<Data | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const pull = async () => {
      try {
        const raw = (await window.otto?.data?.get?.()) ?? null;
        const d = normalize(raw);
        if (mounted.current && d) setData(d);
      } catch (e) {
        console.log("[wp-console] pull failed", String(e));
      }
    };
    pull();
    const off = window.otto?.data?.onChange?.((next: any) => {
      const d = normalize(next);
      if (mounted.current && d) setData(d);
    });
    // A phone view that was backgrounded can miss onChange pushes:
    // re-pull when it becomes visible again, and poll as a safety net.
    const onVis = () => {
      if (document.visibilityState === "visible") pull();
    };
    document.addEventListener("visibilitychange", onVis);
    const timer = setInterval(pull, 20000);
    return () => {
      try {
        off?.();
      } catch {}
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(timer);
    };
  }, []);
  return data;
}

export default function App() {
  const data = useConsoleData();
  const [pending, setPending] = useState<string | null>(null);
  const [tab, setTab] = useState<"sites" | "new" | "system">("sites");
  const [form, setForm] = useState({ id: "", name: "", adminUser: "admin", email: "" });
  const [confirmDel, setConfirmDel] = useState<Record<string, string>>({});

  const status = data?.status;
  const sites = data?.sites ?? [];
  const dbUp = !!status?.db?.up;
  const bootstrapped = !!status?.runtime?.bootstrapped;
  const notice = data?.notice ?? null;

  const siteAsk = (verb: string, id: string) =>
    ask(`WP Stack: ${verb} the site "${id}". Then refresh the WP Stack Console board.`, setPending);

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
        <div className="o-muted" style={{ fontSize: 12 }}>
          {data?.ts ? `updated ${data.ts}` : "waiting for first update from Otto…"}
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
          <button className="o-btn" onClick={() => ask(REFRESH_ASK, setPending)} disabled={!!pending}>
            ↻
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
            disabled={!!pending}
            onClick={() =>
              ask(
                "WP Stack: install the wp-stack runtime with wp_stack_bootstrap (it may take several minutes — poll wp_stack_status until the phase is ready), then refresh the WP Stack Console board.",
                setPending
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
                  {s.exposed ? <Badge ok={true}>exposed</Badge> : null}
                  <Badge ok={!!s.running}>{s.running ? "running" : "stopped"}</Badge>
                </div>
              </div>
              <div className="o-muted" style={{ fontSize: 12, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                {s.id}
                {s.port ? ` · :${s.port}` : ""}
                {s.url ? ` · ${s.url}` : ""}
                {s.serveUrl ? ` · ${s.serveUrl}` : ""}
                {s.exposeUrl ? ` · ${s.exposeUrl}` : ""}
              </div>
              <div className="o-row" style={{ gap: 6, flexWrap: "wrap" }}>
                {s.running ? (
                  <>
                    <button className="o-btn" disabled={pending !== null} onClick={() => siteAsk("stop", s.id)}>
                      Stop
                    </button>
                    <button className="o-btn" disabled={pending !== null} onClick={() => siteAsk("restart", s.id)}>
                      Restart
                    </button>
                  </>
                ) : (
                  <button className="o-btn o-btn-primary" disabled={pending !== null} onClick={() => siteAsk("start", s.id)}>
                    Start
                  </button>
                )}
                <button className="o-btn" disabled={pending !== null} onClick={() => siteAsk("show details for", s.id)}>
                  Details
                </button>
                {s.serveUrl ? (
                  <button className="o-btn" disabled={pending !== null} onClick={() => siteAsk("remove the HTTPS exposure of", s.id)}>
                    Unserve
                  </button>
                ) : s.exposed ? (
                  <button className="o-btn" disabled={pending !== null} onClick={() => siteAsk("unexpose (wp_stack_unexpose)", s.id)}>
                    Unexpose
                  </button>
                ) : (
                  <>
                    <button className="o-btn" disabled={pending !== null} onClick={() => siteAsk("expose over HTTPS with wp_stack_serve", s.id)}>
                      Serve
                    </button>
                    <button className="o-btn" disabled={pending !== null} onClick={() => siteAsk("expose on the tailnet with wp_stack_expose", s.id)}>
                      Expose
                    </button>
                  </>
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
            disabled={pending !== null || !form.id || !form.name || !form.adminUser || !form.email}
            onClick={() =>
              ask(
                `WP Stack: create a site with id "${form.id}", name "${form.name}", admin user "${form.adminUser}", email "${form.email}". Show the one-time admin password here, then refresh the WP Stack Console board.`,
                setPending
              )
            }
          >
            {pending ? "Sent to Otto…" : "Create site"}
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
              disabled={pending !== null}
              onClick={() => ask("WP Stack: start the stack database (wp_stack_db start), then refresh the board.", setPending)}
            >
              Start db
            </button>
            <button
              className="o-btn"
              disabled={pending !== null}
              onClick={() => ask("WP Stack: stop the stack database (wp_stack_db stop), then refresh the board.", setPending)}
            >
              Stop db
            </button>
          </div>
          <div className="o-muted" style={{ fontSize: 11, marginTop: 4 }}>
            Console talks to Otto through chat — no token, no scripts, no direct API. Data refreshed {data?.ts || "never"}.
          </div>
        </div>
      )}

      {pending && (
        <div className="o-muted" style={{ fontSize: 12 }}>
          Sent to Otto: {pending.slice(0, 80)}…
        </div>
      )}
    </div>
  );
}

export function Widget() {
  const data = useConsoleData();
  const sites = data?.sites ?? [];
  const dbUp = !!data?.status?.db?.up;
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
      <div className="o-muted" style={{ fontSize: 11 }}>{data?.ts ? `updated ${data.ts}` : "no data yet"}</div>
    </div>
  );
}
