/**
 * wp-stack-next — Otto dashboard for the standalone otto-wp-stack plugin.
 *
 * Talks to the backend ONLY through scripts/stack.mjs, which makes ONE
 * token-authed HTTP call to the plugin's /otto-wp-stack/api route on the
 * Gateway. No automations, no model turns, no old-stack dependencies.
 *
 * Data shape (otto.data):
 *   { status, sites, rules, ts, lastResult, details:{id,details}, createNote }
 */
import React, { useEffect, useMemo, useRef, useState } from "react";

const otto = window.otto;

// Dashboard argv vocabulary -> plugin operation + named args (mirrors scripts/stack.mjs).
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
    case "token-check": return ["full", {}];
    default: return [null, null];
  }
}

const AUTH = { apiBase: "http://127.0.0.1:18789", token: "" };

// One-tap handoff: this message goes into the owner's chat with their Otto, which
// does the whole token dance (install plugin from ClawHub if missing, read
// .api-token, write config.json, probe). The owner never handles a token.
const SETUP_PROMPT =
  "Set up the WP Stack (Standalone) dashboard app for me: " +
  "1) make sure the otto-wp-stack plugin is installed and enabled (install @lunarlyra/otto-wp-stack from ClawHub if it is not), " +
  "2) read the API token from the .api-token file in the plugin's install folder (the plugin writes it when it loads; if the file is missing, enable/reload the plugin first), " +
  "3) write the app's config.json in its app folder as {\"apiBase\":\"http://127.0.0.1:18789\",\"token\":\"<the token>\"}, " +
  "4) verify by POSTing {\"op\":\"full\",\"args\":{}} to http://127.0.0.1:18789/otto-wp-stack/api with the bearer token and confirming ok:true. " +
  "If the runtime is not installed yet, start it (wp_stack_bootstrap). Never paste the token itself into this chat.";

async function getAuth() {
  if (AUTH.token && !AUTH.token.startsWith("<")) return AUTH;
  try {
    const r = await fetch("config.json?cb=" + Date.now(), { cache: "no-store" });
    const j = await r.json();
    if (j && typeof j.token === "string" && j.token.trim()) {
      AUTH.token = j.token.trim();
      if (j.apiBase) AUTH.apiBase = String(j.apiBase).replace(/\/+$/, "");
    }
  } catch { /* config.json not saved yet */ }
  return AUTH;
}

// Fallback when otto.script is unavailable on this client: POST straight to the
// plugin route (same-origin first, then the configured apiBase). Token still required.
async function fetchFallback(argv) {
  const [op, a] = translate(argv);
  if (!op) return { error: "unknown command: " + argv[0] };
  const auth = await getAuth();
  if (!auth.token || auth.token.startsWith("<")) {
    return { error: "no API token set — open the app's Settings and paste the token from the otto-wp-stack plugin (.api-token file)." };
  }
  // Only the explicitly configured gateway origin receives the bearer token.
  // Never add location.origin: if the dashboard is hosted elsewhere (e.g. a
  // shared link), that would disclose the token to the hosting origin.
  const bases = [];
  if (auth.apiBase) bases.push(auth.apiBase);
  let last = { error: "plugin unreachable" };
  for (const b of bases) {
    try {
      const res = await fetch(b.replace(/\/+$/, "") + "/otto-wp-stack/api", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + auth.token },
        body: JSON.stringify({ op, args: a }),
        cache: "no-store",
      });
      if (res.status === 401) return { error: "plugin rejected the token — check Settings (or rotate it)." };
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        j.via = "browser";
        return j;
      } catch {
        last = { error: `plugin answered ${res.status}: ${text.slice(0, 200)}` };
      }
    } catch (e) {
      last = { error: `plugin unreachable at ${b} — ${String(e?.name ?? "Error")}. Enable the otto-wp-stack plugin or fix apiBase in Settings.` };
    }
  }
  return last;
}

async function call(args) {
  // 1) Preferred: the app's own script (no CORS, reads config.json itself).
  try {
    const r = await otto.script("stack.mjs", { args });
    if (r && typeof r.stdout === "string") {
      const j = JSON.parse(r.stdout);
      if (r.exitCode !== 0 && !j.error) return { error: "script exit " + r.exitCode + ": " + (r.stderr || "").slice(0, 160) };
      if (!j.error) return j;
      // A token/config problem is the same for both paths — report it directly.
      if (!/no API token/i.test(String(j.error))) return j;
    }
  } catch { /* client can't run scripts (or otto.script missing) — fall back */ }
  // 2) Fallback: browser fetch straight to the plugin route.
  return await fetchFallback(args);
}

function Badge({ ok, children }) {
  return (
    <span
      className="o-chip"
      style={{
        color: ok === true ? "var(--ok)" : ok === false ? "var(--danger)" : "var(--muted)",
        borderColor: "var(--border)",
      }}
    >
      {ok === true ? "●" : ok === false ? "○" : "◌"} {children}
    </span>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span className="o-muted" style={{ fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 13, textAlign: "right" }}>{children}</span>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState("sites");
  const [form, setForm] = useState({ id: "", name: "", adminUser: "", email: "" });
  const [confirmDel, setConfirmDel] = useState({});
  const [tokenDraft, setTokenDraft] = useState("");
  const [probe, setProbe] = useState(null);
  const [askedOtto, setAskedOtto] = useState(false);
  const [showPw, setShowPw] = useState(null);
  const [bootProgress, setBootProgress] = useState(null);
  const mounted = useRef(true);
  const pollRef = useRef(null);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      let saved = {};
      try { saved = (await otto?.data?.get?.()) ?? {}; } catch { /* first run */ }
      if (mounted.current) setData(saved);
      const j = await call(["full"]);
      if (!mounted.current) return;
      if (j.ok) {
        setData((d) => ({ ...(d ?? {}), status: j.status, sites: j.sites, ts: j.ts }));
        if (j.status?.runtime && !j.status.runtime.bootstrapped) pollBootstrap();
      } else if (!saved.status) setData((d) => ({ ...(d ?? {}), lastResult: { ok: false, error: j.error } }));
    })();
    return () => { mounted.current = false; if (pollRef.current) clearTimeout(pollRef.current); };
  }, []);

  useEffect(() => {
    const off = otto?.data?.onChange?.((next) => { if (mounted.current) setData(next ?? {}); });
    return () => { try { off?.(); } catch { /* noop */ } };
  }, []);

  const run = async (label, args, after) => {
    setBusy(label);
    const j = await call(args);
    if (!mounted.current) return;
    setBusy("");
    if (after) after(j);
    if (j.ok && ["full", "sites", "site-action", "create", "delete-site", "db-action"].includes(args[0])) {
      const patch = { ts: j.ts };
      if (j.status) patch.status = j.status;
      if (j.sites) patch.sites = j.sites;
      if (j.message !== undefined || j.error) patch.lastResult = { id: Date.now(), cmd: args[0], ok: j.ok !== false, message: j.message, error: j.error };
      if (args[0] === "create" && j.ok) patch.createNote = j.message ?? null;
      try {
        const cur = (await otto.data.get()) ?? {};
        await otto.data.set({ ...cur, ...patch });
      } catch { /* data write best-effort */ }
      if (mounted.current) setData((d) => ({ ...(d ?? {}), ...patch }));
    } else if (!j.ok) {
      try {
        const cur = (await otto.data.get()) ?? {};
        await otto.data.set({ ...cur, lastResult: { id: Date.now(), cmd: args[0], ok: false, error: j.error } });
      } catch { /* noop */ }
      if (mounted.current) setData((d) => ({ ...(d ?? {}), lastResult: { ok: false, error: j.error } }));
    }
  };

  async function autoConnect() {
    try {
      await otto.ask(SETUP_PROMPT);
      setAskedOtto(true);
    } catch { /* client without ask — manual steps stay available */ }
  }

  const refresh = () => run("refresh", ["full"]);

  async function pollBootstrap() {
    const j = await call(["bootstrap"]);
    if (!mounted.current) return;
    if (j.ok && j.progress) {
      setBootProgress(j.progress);
      if (j.progress.running) {
        pollRef.current = setTimeout(pollBootstrap, 3000);
      } else if (j.progress.phase === "ready") {
        refresh();
      }
    }
  }

  async function installRuntime() {
    setBusy("install");
    const j = await call(["bootstrap-run"]);
    if (!mounted.current) return;
    setBusy("");
    if (j.ok) {
      setBootProgress(j.progress ?? { running: true, phase: "php", log: ["starting…"] });
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = setTimeout(pollBootstrap, 2000);
      if (typeof j.result === "string" && j.result.includes("already installed")) refresh();
    } else {
      setData((d) => ({ ...(d ?? {}), lastResult: { id: Date.now(), cmd: "install", ok: false, error: j.error } }));
    }
  }

  const refreshRules = async () => {
    setBusy("rules");
    const j = await call(["rules"]);
    setBusy("");
    if (j.ok && mounted.current) {
      try { const cur = (await otto.data.get()) ?? {}; await otto.data.set({ ...cur, rules: j.rules }); } catch { /* noop */ }
      setData((d) => ({ ...(d ?? {}), rules: j.rules }));
    }
  };

  const status = data?.status;
  const sites = data?.sites ?? [];
  const rules = data?.rules ?? null;
  const last = data?.lastResult;
  const rt = status?.runtime;
  const runningCount = sites.filter((s) => s.running).length;

  const details = data?.details;
  const detailsOpen = details && sites.some((s) => s.id === details.id);

  async function saveToken() {
    const t = tokenDraft.trim();
    if (!t) return;
    setBusy("token");
    try {
      await otto.files.put("config.json", new Blob([JSON.stringify({ apiBase: data?.apiBase ?? "http://127.0.0.1:18789", token: t }, null, 2)], { type: "application/json" }));
      const j = await call(["full"]);
      setBusy("");
      const ok = j.ok === true;
      setData((d) => ({ ...(d ?? {}), lastResult: { id: Date.now(), cmd: "token", ok, message: ok ? "Token saved — connected." : null, error: ok ? null : j.error } }));
    } catch (e) {
      setBusy("");
      setData((d) => ({ ...(d ?? {}), lastResult: { ok: false, error: String(e?.message ?? e) } }));
    }
  }

  async function runProbe() {
    setBusy("probe");
    const out = {};
    const apiBase = data?.apiBase ?? "http://127.0.0.1:18789";
    try {
      const h = await fetch(apiBase + "/otto-wp-stack/health", { cache: "no-store" });
      out.health = h.status === 200 ? "ok" : "http " + h.status;
    } catch (e) { out.health = "blocked: " + String(e?.name ?? e); }
    try {
      const cur = (await otto.data.get?.()) ?? {};
      const r = await call(["probe"]);
      out.script = r.ok ? "ok (db " + (r.dbUp ? "up" : "down") + ")" : "error: " + r.error;
    } catch (e) { out.script = "error: " + String(e?.message ?? e); }
    setBusy("");
    setProbe(out);
  }

  const tabs = [
    ["sites", `Sites${sites.length ? ` (${runningCount}/${sites.length})` : ""}`],
    ["create", "New site"],
    ["system", "System"],
    ["settings", "Settings"],
  ];

  return (
    <div style={{ fontFamily: "var(--font-sans)", color: "var(--text)" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 650 }}>WP Stack <span className="o-muted" style={{ fontSize: 12, fontWeight: 400 }}>standalone</span></div>
          <div className="o-muted" style={{ fontSize: 12 }}>{data?.ts ? "updated " + data.ts : "loading…"}{status?.host?.name ? " · " + status.host.name : ""}</div>
        </div>
        <button className="o-btn" onClick={refresh} disabled={!!busy}>{busy === "refresh" ? "…" : "Refresh"}</button>
      </div>

      {/* bootstrap banner — one button installs the whole runtime */}
      {rt && !rt.bootstrapped && (
        <div className="o-card" style={{ marginBottom: 10, borderColor: bootProgress?.phase === "error" ? "var(--danger)" : "var(--warn)" }}>
          <b style={{ color: bootProgress?.phase === "error" ? "var(--danger)" : "var(--warn)" }}>
            {bootProgress?.running ? "Installing the runtime…" : bootProgress?.phase === "error" ? "Runtime install failed" : "Runtime not installed on this Otto"}
          </b>
          <div className="o-muted" style={{ fontSize: 13, marginTop: 4 }}>
            This stack downloads and runs its own PHP, WP-CLI and MariaDB — about 360 MB, a few minutes, no sudo. Everything stays under{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>{rt.stackRoot}</code>.
          </div>
          {!bootProgress?.running && (
            <button className="o-btn o-btn-primary" style={{ marginTop: 8 }} disabled={!!busy} onClick={installRuntime}>
              {busy === "install" ? "Starting…" : bootProgress?.phase === "error" ? "Retry install" : "Install runtime"}
            </button>
          )}
          {bootProgress?.running && (
            <div className="o-muted" style={{ fontSize: 12, marginTop: 6 }}>Phase: <b>{bootProgress.phase}</b> — large downloads can take ~10 minutes; the page keeps checking.</div>
          )}
          {bootProgress?.phase === "error" && bootProgress.error && (
            <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6, whiteSpace: "pre-wrap" }}>{bootProgress.error}</div>
          )}
          {Array.isArray(bootProgress?.log) && bootProgress.log.length > 0 && (
            <pre style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, maxHeight: 150, overflow: "auto", background: "var(--elevated)", padding: 8, borderRadius: "var(--radius)", marginTop: 8, whiteSpace: "pre-wrap" }}>
              {bootProgress.log.join("\n")}
            </pre>
          )}
        </div>
      )}

      {/* first-run setup: backend not reachable yet */}
      {!status && (
        <div className="o-card" style={{ marginBottom: 10 }}>
          <b>Set up WP Stack on this Otto</b>
          <div className="o-muted" style={{ fontSize: 13, marginTop: 4 }}>
            One tap asks your Otto to install the plugin from ClawHub if needed, read the plugin's API token, and wire this app to it. No copy-pasting.
          </div>
          <button className="o-btn o-btn-primary" style={{ marginTop: 8 }} onClick={autoConnect} disabled={askedOtto}>
            {askedOtto ? "Sent — follow the chat, then Refresh" : "Auto-connect (ask Otto)"}
          </button>
          {askedOtto && (
            <div className="o-muted" style={{ fontSize: 12, marginTop: 6 }}>Your Otto is doing the setup in this chat — approve its cards if it asks, then hit Refresh.</div>
          )}
          <details style={{ marginTop: 8 }}>
            <summary className="o-muted" style={{ fontSize: 12, cursor: "pointer" }}>Or do it manually</summary>
            <ol style={{ fontSize: 13, margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Ask Otto on this device: <i>“install the wp-stack plugin”</i> — approve the card, then enable it and restart the Gateway.</li>
              <li>On a fresh Otto the banner above then shows an <b>Install runtime</b> button (its own PHP, WP-CLI and MariaDB, no sudo); an already-installed runtime shows its details instead.</li>
              <li>Paste the plugin’s <code style={{ fontFamily: "var(--font-mono)" }}>.api-token</code> into the <button className="o-btn" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => setTab("settings")}>Settings</button> tab and Save.</li>
            </ol>
          </details>
          {last?.error && (
            <div className="o-muted" style={{ fontSize: 11, marginTop: 8, whiteSpace: "pre-wrap" }}>{String(last.error).slice(0, 200)}</div>
          )}
          <button className="o-btn" style={{ marginTop: 8 }} onClick={refresh} disabled={!!busy}>{busy === "refresh" ? "Checking…" : "Retry connection"}</button>
        </div>
      )}

      {/* last result */}
      {last && status && (
        <div className="o-card" style={{ marginBottom: 10, borderColor: last.ok ? "var(--ok)" : "var(--danger)" }}>
          <div style={{ fontSize: 13 }}>
            <span style={{ color: last.ok ? "var(--ok)" : "var(--danger)" }}>{last.ok ? "✓" : "✗"}</span>{" "}
            <span style={{ whiteSpace: "pre-wrap" }}>{String(last.message ?? last.error ?? "").slice(0, 400)}</span>
          </div>
          <button className="o-btn" style={{ marginTop: 6, fontSize: 12 }}
            onClick={async () => { try { const cur = (await otto.data.get()) ?? {}; const { lastResult, createNote, ...rest } = cur; await otto.data.set(rest); } catch { /* noop */ } setData((d) => ({ ...(d ?? {}), lastResult: null, createNote: null })); }}>
            Dismiss
          </button>
        </div>
      )}

      {/* tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {tabs.map(([k, label]) => (
          <button key={k} className="o-btn" onClick={() => setTab(k)}
            style={{ background: tab === k ? "var(--accent)" : "var(--elevated)", color: tab === k ? "var(--accent-fg)" : "var(--text)" }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "sites" && (
        <div>
          {sites.length === 0 && (
            <div className="o-card o-muted" style={{ fontSize: 13 }}>No sites yet. Use <b>New site</b> to create the first one.</div>
          )}
          {sites.map((s) => (
            <div key={s.id} className="o-card" style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <b>{s.name}</b>{" "}
                  <span className="o-muted" style={{ fontSize: 12 }}>{s.id} · :{s.port} · db {s.db}</span>
                </div>
                <Badge ok={!!s.running}>{s.running ? "running" : "stopped"}</Badge>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <a className="o-btn" style={{ textDecoration: "none", fontSize: 12 }} href={s.url} target="_blank" rel="noreferrer">Open</a>
                <a className="o-btn" style={{ textDecoration: "none", fontSize: 12 }} href={s.url + "/wp-admin/"} target="_blank" rel="noreferrer">WP Admin</a>
                {!s.running && <button className="o-btn o-btn-primary" disabled={!!busy} onClick={() => run("start", ["site-action", s.id, "start"])}>Start</button>}
                {s.running && <button className="o-btn" disabled={!!busy} onClick={() => run("stop", ["site-action", s.id, "stop"])}>Stop</button>}
                {s.running && <button className="o-btn" disabled={!!busy} onClick={() => run("restart", ["site-action", s.id, "restart"])}>Restart</button>}
                <button className="o-btn" disabled={!!busy} onClick={() => run("details", ["details", s.id], (j) => { if (j.ok) setData((d) => ({ ...(d ?? {}), details: { id: s.id, details: j.details } })); })}>Details</button>
                {confirmDel[s.id] === 1 ? (
                  <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    <input value={confirmDel[s.id + "_v"] ?? ""} placeholder={s.id}
                      onChange={(e) => setConfirmDel((c) => ({ ...c, [s.id + "_v"]: e.target.value }))}
                      style={{ width: 110, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--elevated)", color: "var(--text)" }} />
                    <button className="o-btn" style={{ background: "var(--danger)", color: "#fff" }} disabled={confirmDel[s.id + "_v"] !== s.id || !!busy}
                      onClick={() => run("delete", ["delete-site", s.id, s.id])}>Confirm</button>
                    <button className="o-btn" onClick={() => setConfirmDel((c) => ({ ...c, [s.id]: 0 }))}>Cancel</button>
                  </span>
                ) : (
                  <button className="o-btn" style={{ color: "var(--danger)" }} onClick={() => setConfirmDel((c) => ({ ...c, [s.id]: 1 }))}>Delete</button>
                )}
              </div>
              {detailsOpen && details.id === s.id && (
                <div className="o-muted" style={{ fontSize: 12, marginTop: 8 }}>
                  WordPress {details.details?.version ?? "?"} · {(details.details?.plugins ?? []).length} plugins · {(details.details?.themes ?? []).length} themes
                  {(details.details?.plugins ?? []).slice(0, 8).map((p) => (
                    <div key={p.name} style={{ marginLeft: 8 }}>{p.name} <span style={{ color: p.status === "active" ? "var(--ok)" : "var(--muted)" }}>[{p.status}]</span> {p.version}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "create" && (
        <div className="o-card">
          <div style={{ display: "grid", gap: 8 }}>
            {[["id", "site id (a-z 0-9 dashes)"], ["name", "site title"], ["adminUser", "admin username"], ["email", "admin email"]].map(([k, ph]) => (
              <input key={k} placeholder={ph} value={form[k]}
                onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--elevated)", color: "var(--text)" }} />
            ))}
            <button className="o-btn o-btn-primary" disabled={!!busy || !form.id || !form.name || !form.adminUser || !form.email}
              onClick={() => run("create", ["create", form.id, form.name, form.adminUser, form.email], (j) => { if (j.ok) { setForm({ id: "", name: "", adminUser: "", email: "" }); setShowPw(j.message); } })}>
              {busy === "create" ? "Creating… (downloads WordPress)" : "Create site"}
            </button>
            <div className="o-muted" style={{ fontSize: 12 }}>Creates its own database (wps_*) on the stack's own MariaDB and serves via its own PHP server. Admin password is shown once.</div>
          </div>
          {showPw && (
            <div className="o-card" style={{ marginTop: 8, borderColor: "var(--accent)" }}>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{showPw}</div>
              <button className="o-btn" style={{ marginTop: 6 }} onClick={() => setShowPw(null)}>I saved it</button>
            </div>
          )}
        </div>
      )}

      {tab === "system" && (
        <div>
          <div className="o-card" style={{ marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>Runtime</b>
            <Row label="stack folder"><span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{rt?.stackRoot ?? status?.runtime?.stackRoot ?? "…"}</span></Row>
            <Row label="PHP">{rt?.php?.installed ? <Badge ok>{rt.php.version ?? "installed"}</Badge> : <Badge ok={false}>missing</Badge>}</Row>
            <Row label="WP-CLI">{rt?.wpCli?.installed ? <Badge ok>installed</Badge> : <Badge ok={false}>missing</Badge>}</Row>
            <Row label="MariaDB">{rt?.mariadb?.installed ? <Badge ok>{rt.mariadb.version ?? "installed"}</Badge> : <Badge ok={false}>missing</Badge>}</Row>
            <Row label="db credential">{rt?.dbCredential ? <Badge ok>present</Badge> : <Badge ok={false}>missing</Badge>}</Row>
          </div>
          <div className="o-card" style={{ marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>Database (stack-owned)</b>
            <Row label="port"><Badge ok={status?.db?.up === true}>{status?.db?.up ? "up" : "down"} :{status?.db?.port ?? "…"}</Badge></Row>
            {status?.db?.version && <Row label="version">{status.db.version}</Row>}
            {status?.db?.error && <Row label="error"><span style={{ color: "var(--danger)", fontSize: 12 }}>{status.db.error}</span></Row>}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="o-btn" disabled={!!busy} onClick={() => run("db", ["db-action", "start"])}>Start db</button>
              <button className="o-btn" disabled={!!busy} onClick={() => run("db", ["db-action", "stop"])}>Stop db</button>
            </div>
          </div>
          <div className="o-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <b style={{ fontSize: 14 }}>HTTPS rules (Tailscale Serve)</b>
              <button className="o-btn" style={{ fontSize: 12 }} disabled={!!busy} onClick={refreshRules}>{busy === "rules" ? "…" : "Reload"}</button>
            </div>
            {!rules && <div className="o-muted" style={{ fontSize: 13, marginTop: 6 }}>Tap Reload.</div>}
            {(rules ?? []).map((r, i) => (
              <Row key={i} label={`${r.host}${r.mount}`}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{String(r.target)}</span>
                {r.ours ? <span style={{ color: "var(--accent)", fontSize: 11 }}> · ours</span> : null}
              </Row>
            ))}
            <div className="o-muted" style={{ fontSize: 12, marginTop: 6 }}>Rule changes are owner-side by design (tailscale serve).</div>
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div className="o-card">
          <b style={{ fontSize: 14 }}>Connection</b>
          <div className="o-muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
            Or just ask your Otto: <i>“connect the WP Stack app”</i> — it reads the token itself. Manual paste: contents of <code style={{ fontFamily: "var(--font-mono)" }}>.api-token</code> in the plugin folder.
          </div>
          <div style={{ marginBottom: 8 }}>
            <button className="o-btn" onClick={autoConnect} disabled={askedOtto}>{askedOtto ? "Sent — check the chat" : "Auto-connect (ask Otto)"}</button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input type="password" placeholder="API token" value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--elevated)", color: "var(--text)" }} />
            <button className="o-btn o-btn-primary" disabled={!!busy || !tokenDraft.trim()} onClick={saveToken}>{busy === "token" ? "…" : "Save"}</button>
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="o-btn" disabled={!!busy} onClick={runProbe}>{busy === "probe" ? "Probing…" : "Run connection probe"}</button>
            {probe && (
              <div className="o-muted" style={{ fontSize: 12, marginTop: 6 }}>
                browser→route: {probe.health} <br /> app→plugin (via script): {probe.script}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
