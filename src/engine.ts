/**
 * otto-wp-stack — standalone engine.
 *
 * Everything this product needs lives under ONE folder (stackRoot):
 *
 *   stackRoot/
 *     runtime/php            static PHP CLI binary      (downloaded by bootstrap)
 *     runtime/wp-cli.phar    WP-CLI phar                (downloaded by bootstrap)
 *     runtime/mariadb/       MariaDB bintar             (downloaded by bootstrap)
 *     db/data                our own datadir            (never touches any other MySQL)
 *     run/mysql.sock         our own socket
 *     logs/<site>.log        per-site php -S logs
 *     sites/<id>/public      per-site docroot
 *     sites.json             our own registry
 *     .db-credential         MariaDB user/password for this stack (mode 0600)
 *
 * No system packages, no systemd at runtime, no sudo, and no references to any
 * other stack: PHP servers and MariaDB are OUR child processes, spawned and
 * killed as the Otto agent user on our own ports (sites portMin..portMax,
 * database dbPort — defaults keep clear of the legacy 3306/8080/8081 range).
 */
import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type StackConfig = {
  stackRoot: string;
  dbHost: string;
  dbPort: number;
  dbUser: string;
  portMin: number;
  portMax: number;
  /** HTTPS ports wp_stack_serve may allocate for Tailscale Serve rules */
  servePortMin: number;
  servePortMax: number;
  /** When true (default), createSite also runs the expose path (wp_stack_expose:
   *  plain-HTTP tailnet binding, no operator grant needed) for the new site. */
  autoExpose: boolean;
  /** derived paths (filled by resolveConfig when empty) */
  phpBin: string;
  wpCli: string;
  mariadbDir: string;
  dbDir: string;
  runDir: string;
  logsDir: string;
  sitesDir: string;
  registryFile: string;
  credFile: string;
};

/**
 * Portable default stack root, in priority order:
 * 1. WP_STACK_ROOT env (anything)
 * 2. the agent workspace env, when set and present
 * 3. the standard Otto agent workspace, when it exists
 * 4. ~/otto-wp-stack on any other machine
 */
function defaultStackRoot(): string {
  if (process.env.WP_STACK_ROOT) return process.env.WP_STACK_ROOT;
  for (const ws of [process.env.OPENCLAW_WORKSPACE, process.env.OTTO_AGENT_WORKSPACE]) {
    if (ws && fs.existsSync(ws)) return path.join(ws, "wp-stack");
  }
  const ottoWs = "/var/lib/otto/owner/agent/workspace";
  if (fs.existsSync(ottoWs)) return path.join(ottoWs, "wp-stack");
  return path.join(os.homedir(), "otto-wp-stack");
}

export const DEFAULTS: StackConfig = {
  stackRoot: defaultStackRoot(),
  dbHost: "127.0.0.1",
  dbPort: 3307,
  dbUser: "wp_stack",
  portMin: 8100,
  portMax: 8199,
  servePortMin: 8443,
  servePortMax: 8499,
  autoExpose: true,
  phpBin: "",
  wpCli: "",
  mariadbDir: "",
  dbDir: "",
  runDir: "",
  logsDir: "",
  sitesDir: "",
  registryFile: "",
  credFile: "",
};

export function resolveConfig(raw: Partial<StackConfig> | undefined): StackConfig {
  const c = { ...DEFAULTS, ...(raw ?? {}) };
  c.stackRoot = path.resolve(c.stackRoot);
  if (!c.phpBin) c.phpBin = path.join(c.stackRoot, "runtime", "php");
  if (!c.wpCli) c.wpCli = path.join(c.stackRoot, "runtime", "wp-cli.phar");
  if (!c.mariadbDir) c.mariadbDir = path.join(c.stackRoot, "runtime", "mariadb");
  if (!c.dbDir) c.dbDir = path.join(c.stackRoot, "db", "data");
  if (!c.runDir) c.runDir = path.join(c.stackRoot, "run");
  if (!c.logsDir) c.logsDir = path.join(c.stackRoot, "logs");
  if (!c.sitesDir) c.sitesDir = path.join(c.stackRoot, "sites");
  if (!c.registryFile) c.registryFile = path.join(c.stackRoot, "sites.json");
  if (!c.credFile) c.credFile = path.join(c.stackRoot, ".db-credential");
  return c;
}

export const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ACTIONS = new Set(["start", "stop", "restart"]);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const ADMIN_USER_RE = /^[a-z0-9_.-]{1,60}$/i;

export type Out = { ok?: boolean; error?: string; [k: string]: unknown };

export function bad(msg: string): Out {
  return { ok: false, error: msg };
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function portOpen(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port, timeout: timeoutMs });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

/**
 * Minimal environment for site-facing child processes (php -S, wp-cli, and the
 * stack's own mariadbd). Site code must never inherit the gateway account's
 * environment (provider API keys, proxy credentials, arbitrary config vars):
 * only what OUR static PHP + wp-cli phar + mariadbd genuinely need is
 * whitelisted — our runtime bin dir plus the usual system paths, and HOME
 * pointed INSIDE the stack so option files (~/.my.cnf, wp-cli cache) resolve
 * under stackRoot instead of the agent's home directory.
 */
export function siteEnv(cfg: StackConfig): NodeJS.ProcessEnv {
  return {
    PATH: `${path.dirname(cfg.phpBin)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: cfg.stackRoot,
    TMPDIR: os.tmpdir(),
    LANG: "C.UTF-8",
  };
}

export function run(argv: string[], timeoutMs = 25_000, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    let settled = false;
    const done = (code: number, stdout: string, stderr: string) => {
      if (!settled) {
        settled = true;
        resolve({ code, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "").trim() });
      }
    };
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
        if (err && (err as { code?: unknown }).code === "ENOENT") {
          done(127, "", `missing: ${cmd}`);
          return;
        }
        done(err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0, String(stdout ?? ""), String(stderr ?? ""));
      });
    } catch (e) {
      // execFile can throw synchronously (ETXTBSY while a binary is being
      // replaced, EACCES, …) — a failed spawn is an answer, never a crash.
      const err = e as NodeJS.ErrnoException;
      done(126, "", err?.code === "ENOENT" ? `missing: ${cmd}` : `${err?.code ?? "spawn error"}: ${err?.message ?? e}`);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function ensureDirs(cfg: StackConfig): void {
  for (const d of [cfg.stackRoot, path.join(cfg.stackRoot, "runtime"), cfg.dbDir, cfg.runDir, cfg.logsDir, cfg.sitesDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o750 });
  }
}

// ---------------------------------------------------------------------------
// Registry (our own, always)
// ---------------------------------------------------------------------------

export type Site = {
  id: string;
  name: string;
  port: number;
  db: string;
  docroot: string;
  adminUser: string;
  createdAt: string;
  /** set while the site is exposed over HTTPS via Tailscale Serve */
  servePort?: number;
  serveUrl?: string;
  /** set while the site is exposed on the tailnet: the IPv4 its php -S binds
   *  to (wp_stack_expose). Absent = loopback only. */
  bind?: string;
  /** http://<magicdns-or-tailscale-ip>:<port> while bound to the tailnet */
  exposedUrl?: string;
};

export function loadRegistry(cfg: StackConfig): Site[] {
  try {
    const j = JSON.parse(fs.readFileSync(cfg.registryFile, "utf8"));
    return Array.isArray(j.sites) ? (j.sites as Site[]) : [];
  } catch {
    return [];
  }
}

export function saveRegistry(cfg: StackConfig, sites: Site[]): void {
  ensureDirs(cfg);
  const tmp = cfg.registryFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, sites }, null, 2), { mode: 0o640 });
  fs.renameSync(tmp, cfg.registryFile);
}

export function dbPrefix(cfg: StackConfig): string {
  // wps_<id with dashes as underscores> — the bootstrap grants the wp_stack
  // user exactly this prefix, nothing else.
  return "wps_";
}

function freePort(cfg: StackConfig, taken: Set<number>): number | null {
  for (let p = cfg.portMin; p <= cfg.portMax; p++) {
    if (!taken.has(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runtime presence (bootstrap status)
// ---------------------------------------------------------------------------

export type RuntimeStatus = {
  stackRoot: string;
  bootstrapped: boolean;
  php: { installed: boolean; version?: string; error?: string };
  wpCli: { installed: boolean; error?: string };
  mariadb: { installed: boolean; version?: string; error?: string };
  dbCredential: boolean;
};

export async function runtimeStatus(cfg: StackConfig): Promise<RuntimeStatus> {
  const st: RuntimeStatus = {
    stackRoot: cfg.stackRoot,
    bootstrapped: false,
    php: { installed: isFile(cfg.phpBin) },
    wpCli: { installed: isFile(cfg.wpCli) },
    mariadb: { installed: isFile(path.join(cfg.mariadbDir, "bin", "mariadbd")) },
    dbCredential: isFile(cfg.credFile),
  };
  if (st.php.installed) {
    const r = await run([cfg.phpBin, "-v"], 10_000);
    if (r.code === 0) st.php.version = r.stdout.split("\n")[0]?.slice(0, 80);
    else {
      st.php.installed = false;
      st.php.error = (r.stderr || "php -v failed").slice(0, 120);
    }
  }
  if (st.mariadb.installed) {
    const r = await run([path.join(cfg.mariadbDir, "bin", "mariadbd"), "--version"], 10_000);
    if (r.code === 0) st.mariadb.version = r.stdout.slice(0, 80);
    else {
      st.mariadb.installed = false;
      st.mariadb.error = (r.stderr || "mariadbd --version failed").slice(0, 120);
    }
  }
  st.bootstrapped = st.php.installed && st.wpCli.installed && st.mariadb.installed && st.dbCredential;
  return st;
}

// ---------------------------------------------------------------------------
// Self-bootstrap — the plugin installs its OWN runtime, so a fresh Otto needs
// no terminal beyond `openclaw plugins install`. Same steps as
// bin/wp-stack-bootstrap.sh (which stays as the offline fallback), and every
// step is idempotent: re-running only fills gaps. Progress is persisted to
// .bootstrap-state.json so the dashboard can poll across restarts.
// ---------------------------------------------------------------------------

export const BOOTSTRAP_URLS = {
  phpVersion: "8.3.13",
  // bulk preset — includes mysqli, which WordPress core requires ("common" does not)
  php: "https://dl.static-php.dev/static-php-cli/bulk/php-8.3.13-cli-linux-x86_64.tar.gz",
  wpCli: "https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar",
  dbVersion: "11.4.5",
  db: "https://archive.mariadb.org/mariadb-11.4.5/bintar-linux-systemd-x86_64/mariadb-11.4.5-linux-systemd-x86_64.tar.gz",
};

export type BootstrapProgress = {
  running: boolean;
  phase: "idle" | "php" | "wpcli" | "mariadb" | "dbinit" | "dbstart" | "dbuser" | "ready" | "error";
  startedAt?: string;
  updatedAt?: string;
  error?: string;
  log: string[];
};

let bootstrapRunning = false;
let bootstrapState: BootstrapProgress = { running: false, phase: "idle", log: [] };

function bootstrapStateFile(cfg: StackConfig): string {
  return path.join(cfg.stackRoot, ".bootstrap-state.json");
}

function persistBootstrap(cfg: StackConfig): void {
  try {
    ensureDirs(cfg);
    fs.writeFileSync(bootstrapStateFile(cfg), JSON.stringify({ ...bootstrapState, running: bootstrapRunning }), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

function bootLog(cfg: StackConfig, line: string): void {
  bootstrapState.log = [...bootstrapState.log.slice(-59), `${new Date().toISOString().slice(11, 19)} ${line}`.slice(0, 240)];
  bootstrapState.updatedAt = new Date().toISOString();
  persistBootstrap(cfg);
}

export function bootstrapProgressOf(cfg: StackConfig): BootstrapProgress {
  if (!bootstrapRunning) {
    try {
      const j = JSON.parse(fs.readFileSync(bootstrapStateFile(cfg), "utf8")) as BootstrapProgress;
      if (j && typeof j.phase === "string") {
        if (j.running) {
          return { ...j, running: false, error: j.error ?? "install was interrupted (gateway restart?) — start it again" };
        }
        return j;
      }
    } catch {
      /* no persisted state */
    }
  }
  return { ...bootstrapState, running: bootstrapRunning };
}

async function phpRuns(cfg: StackConfig): Promise<boolean> {
  if (!isFile(cfg.phpBin)) return false;
  return (await run([cfg.phpBin, "-v"], 10_000)).code === 0;
}

async function wpCliRuns(cfg: StackConfig): Promise<boolean> {
  if (!isFile(cfg.wpCli) || !(await phpRuns(cfg))) return false;
  return (await run([cfg.phpBin, cfg.wpCli, "--version", "--allow-root"], 60_000)).code === 0;
}

function findInDir(dir: string, name: string, maxDepth: number): string | null {
  if (maxDepth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === name) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findInDir(path.join(dir, e.name), name, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

async function download(url: string, dest: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  const r = await run(["curl", "-fsSL", "--retry", "3", "--connect-timeout", "15", "-o", dest, url], timeoutMs);
  return { code: r.code, stderr: (r.stderr || `curl exit ${r.code}`).slice(-200) };
}

/** Start (or report on) installing this stack's own runtime. Never blocks. */
export async function startBootstrap(cfg: StackConfig): Promise<Out> {
  if (bootstrapRunning) return { ok: true, result: "bootstrap already running", progress: bootstrapProgressOf(cfg) };
  if (process.getuid?.() === 0) return bad("do not run the stack as root — it must live and run as the Otto agent user");
  if (!/^[A-Za-z0-9_]{1,32}$/.test(cfg.dbUser)) return bad("invalid dbUser config (letters, digits, underscore)");
  const rt = await runtimeStatus(cfg);
  if (rt.bootstrapped) return { ok: true, result: "runtime already installed", progress: bootstrapProgressOf(cfg) };
  for (const bin of ["curl", "tar"]) {
    if ((await run([bin, "--version"], 10_000)).code !== 0) return bad(`bootstrap needs ${bin} on PATH`);
  }
  bootstrapRunning = true;
  bootstrapState = { running: true, phase: "php", startedAt: new Date().toISOString(), log: [] };
  persistBootstrap(cfg);
  void runBootstrap(cfg).finally(() => {
    bootstrapRunning = false;
    persistBootstrap(cfg);
  });
  return { ok: true, result: "bootstrap started — poll the bootstrap op for progress", progress: bootstrapProgressOf(cfg) };
}

async function runBootstrap(cfg: StackConfig): Promise<void> {
  const t0 = Date.now();
  let tmp = "";
  try {
    ensureDirs(cfg);
    // sweep temp dirs left behind by interrupted installs (crash/restart)
    try {
      for (const e of fs.readdirSync(os.tmpdir())) {
        if (!e.startsWith("wpstack-boot-")) continue;
        const p = path.join(os.tmpdir(), e);
        try {
          if (Date.now() - fs.statSync(p).mtimeMs > 6 * 3600_000) fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* not ours */
        }
      }
    } catch {
      /* best effort */
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wpstack-boot-"));

    // 1) PHP — static bulk build (mysqli included, WordPress requires it)
    if (await phpRuns(cfg)) bootLog(cfg, "php: present");
    else {
      bootstrapState.phase = "php";
      bootLog(cfg, `php: downloading static build ${BOOTSTRAP_URLS.phpVersion} (bulk, with mysqli)…`);
      const d = await download(BOOTSTRAP_URLS.php, path.join(tmp, "php.tgz"), 900_000);
      if (d.code !== 0) throw new Error("php download failed: " + d.stderr);
      const x = await run(["tar", "-xzf", path.join(tmp, "php.tgz"), "-C", tmp], 300_000);
      if (x.code !== 0) throw new Error("php extract failed");
      const found = findInDir(tmp, "php", 2);
      if (!found) throw new Error("php binary not found in the download");
      // install atomically so concurrent readers never spawn a half-written binary
      fs.copyFileSync(found, cfg.phpBin + ".part");
      fs.chmodSync(cfg.phpBin + ".part", 0o755);
      fs.renameSync(cfg.phpBin + ".part", cfg.phpBin);
      if (!(await phpRuns(cfg))) throw new Error("downloaded php does not run");
      bootLog(cfg, "php: installed");
    }

    // 2) WP-CLI phar
    if (await wpCliRuns(cfg)) bootLog(cfg, "wp-cli: present");
    else {
      bootstrapState.phase = "wpcli";
      bootLog(cfg, "wp-cli: downloading…");
      const part = cfg.wpCli + ".part";
      const d = await download(BOOTSTRAP_URLS.wpCli, part, 900_000);
      if (d.code !== 0) {
        fs.rmSync(part, { force: true });
        throw new Error("wp-cli download failed: " + d.stderr);
      }
      fs.renameSync(part, cfg.wpCli);
      if (!(await wpCliRuns(cfg))) {
        fs.rmSync(cfg.wpCli, { force: true });
        throw new Error("downloaded wp-cli does not run");
      }
      bootLog(cfg, "wp-cli: installed");
    }

    // 3) MariaDB bintar — our own server with our own datadir
    if (isFile(mariadbBin(cfg, "mariadbd"))) bootLog(cfg, "mariadb: present");
    else {
      bootstrapState.phase = "mariadb";
      bootLog(cfg, `mariadb: downloading ${BOOTSTRAP_URLS.dbVersion} bintar (~333 MB — may take several minutes)…`);
      const d = await download(BOOTSTRAP_URLS.db, path.join(tmp, "db.tgz"), 3_600_000);
      if (d.code !== 0) throw new Error("mariadb download failed: " + d.stderr);
      fs.mkdirSync(cfg.mariadbDir, { recursive: true });
      const x = await run(["tar", "-xzf", path.join(tmp, "db.tgz"), "-C", cfg.mariadbDir, "--strip-components=1"], 1_200_000);
      if (x.code !== 0) throw new Error("mariadb extract failed");
      if (!isFile(mariadbBin(cfg, "mariadbd"))) throw new Error("mariadbd missing after extract");
      bootLog(cfg, "mariadb: installed");
    }

    // 4) Our own data directory
    if (!fs.existsSync(path.join(cfg.dbDir, "mysql"))) {
      bootstrapState.phase = "dbinit";
      bootLog(cfg, "db: initialising datadir…");
      let user = "";
      try {
        user = os.userInfo().username;
      } catch {
        user = String(process.getuid?.() ?? "");
      }
      const r = await run(
        [
          path.join(cfg.mariadbDir, "scripts", "mariadb-install-db"),
          `--user=${user}`,
          `--basedir=${cfg.mariadbDir}`,
          `--datadir=${cfg.dbDir}`,
          "--auth-root-authentication-method=normal",
          "--skip-test-db",
        ],
        600_000,
      );
      if (r.code !== 0) throw new Error("mariadb-install-db failed: " + (r.stderr || r.stdout).slice(-200));
      bootLog(cfg, "db: datadir initialised");
    } else bootLog(cfg, "db: datadir ready");

    // 5) Bring our own server up on the stack port
    bootstrapState.phase = "dbstart";
    const up = await startDb(cfg);
    if (!up.ok) throw new Error(String(up.error ?? "database did not start"));
    bootLog(cfg, `db: up on ${cfg.dbHost}:${cfg.dbPort}`);

    // 6) Stack-scoped mysql user (grants limited to wps_%) + credential file
    if (!isFile(cfg.credFile)) {
      bootstrapState.phase = "dbuser";
      bootLog(cfg, `db: creating user '${cfg.dbUser}' (grants limited to wps_% databases)…`);
      const pass = crypto.randomBytes(24).toString("hex");
      const sql =
        `CREATE USER IF NOT EXISTS '${cfg.dbUser}'@'%' IDENTIFIED BY '${pass}';` +
        `GRANT ALL PRIVILEGES ON \`wps\_%\`.* TO '${cfg.dbUser}'@'%';` +
        `FLUSH PRIVILEGES;`;
      const r = await run([mariadbBin(cfg, "mariadb"), "--protocol=socket", `--socket=${dbSocket(cfg)}`, "-uroot", "-e", sql], 60_000);
      if (r.code !== 0) throw new Error("user create failed: " + r.stderr.replace(/IDENTIFIED BY '[^']*'/g, "IDENTIFIED BY '***'").slice(0, 200));
      fs.writeFileSync(cfg.credFile, JSON.stringify({ user: cfg.dbUser, password: pass, socket: dbSocket(cfg), port: cfg.dbPort }, null, 2), { mode: 0o600 });
      bootLog(cfg, "db: credential written (.db-credential, mode 600)");
    } else bootLog(cfg, "db: credential present");

    // 7) Prove the prefix-scoped grants actually work
    const probe = await mysqlSql(cfg, "CREATE DATABASE IF NOT EXISTS wps_bootstrap_probe; DROP DATABASE wps_bootstrap_probe;");
    if (probe.code !== 0) throw new Error("stack db user cannot create wps_* databases — check grants");

    bootstrapState.phase = "ready";
    bootLog(cfg, `done — runtime ready under ${cfg.stackRoot} in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    bootstrapState.phase = "error";
    bootstrapState.error = String((e as Error)?.message ?? e)
      .replace(/IDENTIFIED BY '[^']*'/g, "IDENTIFIED BY '***'")
      .slice(0, 300);
    bootLog(cfg, "ERROR: " + bootstrapState.error);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Database (our own MariaDB on cfg.dbPort — never 3306)
// ---------------------------------------------------------------------------

type DbCred = { user: string; password: string; socket: string };

function readCred(cfg: StackConfig): DbCred | null {
  try {
    const j = JSON.parse(fs.readFileSync(cfg.credFile, "utf8"));
    if (typeof j.user === "string" && typeof j.password === "string") {
      return { user: j.user, password: j.password, socket: j.socket ?? path.join(cfg.runDir, "mysql.sock") };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

function mariadbBin(cfg: StackConfig, name: string): string {
  return path.join(cfg.mariadbDir, "bin", name);
}

export function dbSocket(cfg: StackConfig): string {
  return path.join(cfg.runDir, "mysql.sock");
}

/** Run SQL as the stack's own mysql user (prefix-scoped grants only). */
export async function mysqlSql(cfg: StackConfig, sql: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const cred = readCred(cfg);
  if (!cred) return { code: 1, stdout: "", stderr: "db credential missing — press Install runtime in the WP Stack app (or run bin/wp-stack-bootstrap.sh)" };
  return run(
    [
      mariadbBin(cfg, "mariadb"),
      "--protocol=TCP",
      `-h${cfg.dbHost}`,
      `-P${cfg.dbPort}`,
      `-u${cred.user}`,
      `-p${cred.password}`,
      "--batch",
      "--skip-column-names",
      "-e",
      sql,
    ],
    timeoutMs,
  );
}

export async function dbPing(cfg: StackConfig): Promise<{ up: boolean; version?: string; error?: string }> {
  if (!(await portOpen(cfg.dbHost, cfg.dbPort, 500))) return { up: false };
  const cred = readCred(cfg);
  if (!cred) return { up: true, error: "up, but credential file missing" };
  const r = await run(
    [mariadbBin(cfg, "mariadb"), "--protocol=TCP", `-h${cfg.dbHost}`, `-P${cfg.dbPort}`, `-u${cred.user}`, `-p${cred.password}`, "-e", "SELECT VERSION()"],
    10_000,
  );
  if (r.code !== 0) return { up: true, error: (r.stderr || "query failed").replace(/.*password.*$/i, "").trim().slice(0, 120) };
  return { up: true, version: r.stdout.split("\n").pop()?.slice(0, 60) };
}

export async function startDb(cfg: StackConfig): Promise<Out> {
  const rt = await runtimeStatus(cfg);
  if (!rt.mariadb.installed) return bad("mariadb runtime missing — press Install runtime in the WP Stack app (or run bin/wp-stack-bootstrap.sh)");
  if (!(await portOpen(cfg.dbHost, cfg.dbPort, 400))) {
    if (!fs.existsSync(cfg.dbDir) || fs.readdirSync(cfg.dbDir).length === 0) {
      return bad("database not initialised — press Install runtime in the WP Stack app (or run bin/wp-stack-bootstrap.sh)");
    }
    ensureDirs(cfg);
    const log = fs.openSync(path.join(cfg.logsDir, "mariadb.log"), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
    try {
      const p = spawn(
        mariadbBin(cfg, "mariadbd"),
        [
          `--datadir=${cfg.dbDir}`,
          `--socket=${dbSocket(cfg)}`,
          `--pid-file=${path.join(cfg.runDir, "mysqld.pid")}`,
          `--bind-address=${cfg.dbHost}`,
          `--port=${cfg.dbPort}`,
          "--skip-name-resolve",
          "--skip-networking=0",
          `--log-error=${path.join(cfg.logsDir, "mariadb.log")}`,
        ],
        { detached: true, stdio: ["ignore", log, log], cwd: cfg.stackRoot, env: siteEnv(cfg) },
      );
      await new Promise<void>((res, rej) => {
        p.once("spawn", () => res());
        p.once("error", (e) => rej(e));
      });
      p.unref();
    } catch (e) {
      return bad(`mariadbd spawn failed: ${(e as Error).message}`.slice(0, 160));
    } finally {
      fs.closeSync(log);
    }
    for (let i = 0; i < 240; i++) {
      if (await portOpen(cfg.dbHost, cfg.dbPort, 400)) return { ok: true, result: "database started" };
      await sleep(500);
    }
    // First-run InnoDB init can be slow; include the server log tail so users
    // (and the dashboard) see WHY instead of hunting for the file.
    let tail = "";
    try {
      tail = fs.readFileSync(path.join(cfg.logsDir, "mariadb.log"), "utf8").split("\n").slice(-12).join(" | ").slice(-400);
    } catch {
      /* no log */
    }
    return bad(("database did not come up within ~3 min — check logs/mariadb.log" + (tail ? " · " + tail : "")).slice(0, 500));
  }
  return { ok: true, result: "already running" };
}

export async function stopDb(cfg: StackConfig): Promise<Out> {
  if (!(await portOpen(cfg.dbHost, cfg.dbPort, 400))) return { ok: true, result: "already stopped" };
  const cred = readCred(cfg);
  if (!cred) return bad("no credential file; cannot shut the database down cleanly");
  const r = await run(
    [
      mariadbBin(cfg, "mariadb-admin"),
      "--protocol=TCP",
      `-h${cfg.dbHost}`,
      `-P${cfg.dbPort}`,
      `-u${cred.user}`,
      `-p${cred.password}`,
      "shutdown",
    ],
    30_000,
  );
  // shutdown closes the socket mid-response; treat connection reset as success.
  if (r.code !== 0 && !/shutdown|Lost connection|server has gone|Access denied/i.test(r.stderr)) {
    return bad((r.stderr || "shutdown failed").replace(/.*password.*$/i, "").trim().slice(0, 160));
  }
  for (let i = 0; i < 40; i++) {
    if (!(await portOpen(cfg.dbHost, cfg.dbPort, 400))) return { ok: true, result: "database stopped" };
    await sleep(250);
  }
  return { ok: true, result: "shutdown requested (still draining)" };
}

// ---------------------------------------------------------------------------
// Tailscale Serve (HTTPS exposure for OUR sites)
//
// The plugin only ever touches serve rules whose target is one of its own
// registered sites (127.0.0.1:<registered port>). Whether the agent user may
// mutate serve config at all is decided by tailscaled: on Otto the agent is
// not the tailscale operator by default, and every mutation answers
// "Access denied: serve config denied" until the owner/operator runs
//   sudo tailscale set --operator=<agent user>
// once. Callers must surface that error verbatim-ish with the fix hint.
// ---------------------------------------------------------------------------

export async function tailscaleDnsName(): Promise<{ ok: true; dns: string } | { ok: false; error: string }> {
  const st = await run(["tailscale", "status", "--json"], 15_000);
  if (st.code !== 0) return { ok: false, error: (st.stderr || st.stdout || "tailscale status failed").slice(0, 150) };
  try {
    const j = JSON.parse(st.stdout) as { Self?: { DNSName?: string } };
    const dns = String(j.Self?.DNSName ?? "").replace(/\.$/, "");
    if (!dns) return { ok: false, error: "tailscale reports no MagicDNS name on this device" };
    return { ok: true, dns };
  } catch {
    return { ok: false, error: "unexpected tailscale status output" };
  }
}

/** This device's tailscale IPv4 (Self.TailscaleIPs) — the bind address for
 *  tailnet-exposed sites. Resolved live; never hardcoded, never 0.0.0.0. */
export async function tailscaleSelfIPv4(): Promise<{ ok: true; ip: string } | { ok: false; error: string }> {
  const st = await run(["tailscale", "status", "--json"], 15_000);
  if (st.code !== 0) return { ok: false, error: (st.stderr || st.stdout || "tailscale status failed").slice(0, 150) };
  try {
    const j = JSON.parse(st.stdout) as { Self?: { TailscaleIPs?: unknown } };
    const ips = Array.isArray(j.Self?.TailscaleIPs) ? (j.Self?.TailscaleIPs as unknown[]).map(String) : [];
    const ip = ips.find((a) => IPv4_RE.test(a) && !a.startsWith("127."));
    if (!ip) return { ok: false, error: "tailscale reports no IPv4 address on this device" };
    return { ok: true, ip };
  } catch {
    return { ok: false, error: "unexpected tailscale status output" };
  }
}

/** Parse `tailscale serve status --json` into its rule list (throws on garbage). */
export type ServeRule = { host: string; mount: string; target: string };

export async function serveStatusRules(): Promise<ServeRule[] | null> {
  const r = await run(["tailscale", "serve", "status", "--json"], 15_000);
  if (r.code !== 0) return null;
  try {
    const cfgJson = JSON.parse(r.stdout) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Text?: string }> }> };
    const rules: ServeRule[] = [];
    for (const [host, v] of Object.entries(cfgJson.Web ?? {})) {
      for (const [mount, h] of Object.entries(v.Handlers ?? {})) {
        rules.push({ host, mount, target: h.Proxy ?? h.Text ?? "other" });
      }
    }
    return rules;
  } catch {
    return null;
  }
}

/** HTTPS ports currently occupied by ANY serve rule on this box. */
export async function servePortsInUse(): Promise<number[]> {
  const rules = await serveStatusRules();
  if (!rules) return [];
  const ports = new Set<number>();
  for (const rule of rules) {
    const seg = rule.host.split(":").pop() ?? "";
    const p = parseInt(seg, 10);
    if (Number.isFinite(p)) ports.add(p);
  }
  return [...ports];
}

/** Add or remove OUR serve rule for a site (target is always our own 127.0.0.1 site port). */
export async function tailscaleServeSet(
  sitePort: number,
  httpsPort: number,
  add: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = `http://127.0.0.1:${sitePort}`;
  // tailscale >=1.102 has no `serve remove` subcommand — `--bg=false <target>` deletes the handler.
  const argv = add
    ? ["tailscale", "serve", "--bg", `--https=${httpsPort}`, target]
    : ["tailscale", "serve", "--bg=false", target];
  const r = await run(argv, 30_000);
  if (r.code === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || `tailscale serve exit ${r.code}`).slice(0, 300) };
}

// ---------------------------------------------------------------------------
// WP-CLI + site processes
// ---------------------------------------------------------------------------

export async function wpCli(cfg: StackConfig, docroot: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  // wp-cli loads site code (wp-settings.php) — run it with the same minimal
  // site environment as the site's own php -S, never the gateway's env.
  return run([cfg.phpBin, "-d", "memory_limit=1G", cfg.wpCli, `--path=${docroot}`, "--skip-plugins", "--skip-themes", ...args], timeoutMs, siteEnv(cfg));
}

/** All PIDs that are OUR php -S for this exact port + docroot. */
export function siteProcesses(cfg: StackConfig, site: Site): number[] {
  const found: number[] = [];
  let phpReal = "";
  try {
    phpReal = fs.realpathSync(cfg.phpBin);
  } catch {
    return found;
  }
  let docReal = "";
  try {
    docReal = fs.realpathSync(site.docroot);
  } catch {
    return found;
  }
  const myUid = process.getuid?.();
  for (const p of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const dir = "/proc/" + p;
      if (fs.statSync(dir).uid !== myUid) continue;
      const cmdline = fs.readFileSync(dir + "/cmdline", "utf8").split("\0");
      const exe = fs.readlinkSync(dir + "/exe").replace(/ \(deleted\)$/, "");
      if (exe !== phpReal) continue;
      const i = cmdline.indexOf("-S");
      const t = cmdline.indexOf("-t");
      if (i < 0 || t < 0) continue;
      // Accept OUR binds only: loopback or the tailnet bind recorded for this
      // site. The port must match, and exe + uid + docroot were verified
      // above — a foreign process on either address is still never killed.
      const spec = String(cmdline[i + 1] ?? "");
      const sep = spec.lastIndexOf(":");
      const bindHost = sep > 0 ? spec.slice(0, sep) : "";
      const bindPort = sep > 0 ? spec.slice(sep + 1) : "";
      if (bindPort === String(site.port) && (bindHost === "127.0.0.1" || bindHost === siteBindWants(site)) && fs.realpathSync(cmdline[t + 1]) === docReal) {
        found.push(Number(p));
      }
    } catch {
      /* vanished / unreadable — not ours */
    }
  }
  return found;
}

const IPv4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The address this site's php -S should listen on (validated at use time). */
export function siteBindWants(site: Site): string {
  return site.bind && IPv4_RE.test(site.bind) ? site.bind : "127.0.0.1";
}

/** Our site's port answering on loopback OR on its recorded tailnet bind. */
export async function sitePortOpen(cfg: StackConfig, site: Site): Promise<boolean> {
  if (await portOpen("127.0.0.1", site.port, 400)) return true;
  const bind = siteBindWants(site);
  if (bind !== "127.0.0.1" && (await portOpen(bind, site.port, 400))) return true;
  return false;
}

export async function startSite(cfg: StackConfig, site: Site): Promise<Out> {
  const rt = await runtimeStatus(cfg);
  if (!rt.php.installed) return bad("php runtime missing — run bin/wp-stack-bootstrap.sh");
  if (!fs.existsSync(site.docroot)) return bad("site files missing; delete and recreate the site");
  const bind = siteBindWants(site);
  if (await sitePortOpen(cfg, site)) {
    if (siteProcesses(cfg, site).length) return { ok: true, result: "already running" };
    return bad(`port ${site.port} is held by a process this stack does not own — refusing`);
  }
  ensureDirs(cfg);
  const fd = fs.openSync(path.join(cfg.logsDir, `${site.id}.log`), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
  try {
    const p = spawn(cfg.phpBin, ["-d", "memory_limit=512M", "-S", `${bind}:${site.port}`, "-t", site.docroot], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: site.docroot,
      env: siteEnv(cfg),
    });
    await new Promise<void>((res, rej) => {
      p.once("spawn", () => res());
      p.once("error", (e) => rej(e));
    });
    p.unref();
  } catch (e) {
    return bad(`php -S spawn failed: ${(e as Error).message}`.slice(0, 160));
  } finally {
    fs.closeSync(fd);
  }
  for (let i = 0; i < 40; i++) {
    if (await sitePortOpen(cfg, site)) return { ok: true, result: "started" };
    await sleep(150);
  }
  return bad("server did not start within 6s — check logs/" + site.id + ".log");
}

export async function stopSite(cfg: StackConfig, site: Site): Promise<Out> {
  const pids = siteProcesses(cfg, site);
  if (!pids.length) {
    if (await sitePortOpen(cfg, site)) return bad(`port ${site.port} held by a foreign process — refusing to kill it`);
    return { ok: true, result: "already stopped" };
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* race */
    }
  }
  for (let i = 0; i < 20; i++) {
    if (!siteProcesses(cfg, site).length && !(await sitePortOpen(cfg, site))) return { ok: true, result: "stopped" };
    await sleep(150);
  }
  for (const pid of siteProcesses(cfg, site)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* race */
    }
  }
  return { ok: true, result: "stopped (forced)" };
}

export type SiteState = Site & { running: boolean; url: string };

export async function listSites(cfg: StackConfig): Promise<SiteState[]> {
  const sites = loadRegistry(cfg);
  return Promise.all(
    sites.map(async (s) => ({
      ...s,
      running: (await sitePortOpen(cfg, s)) && siteProcesses(cfg, s).length > 0,
      url: `http://127.0.0.1:${s.port}`,
    })),
  );
}

export async function siteDetails(cfg: StackConfig, site: Site): Promise<Out> {
  const base = [cfg.phpBin, "-d", "memory_limit=1G", cfg.wpCli, `--path=${site.docroot}`, "--skip-plugins", "--skip-themes", "--no-color"];
  const plugin = await run([...base, "plugin", "list", "--format=json", "--fields=name,status,version"], 120_000);
  if (plugin.code !== 0) return bad((plugin.stderr || plugin.stdout || "wp plugin list failed").slice(0, 200));
  const theme = await run([...base, "theme", "list", "--format=json", "--fields=name,status,version"], 120_000);
  const version = await run([...base, "core", "version"], 60_000);
  let plugins: unknown = [];
  let themes: unknown = [];
  try {
    plugins = JSON.parse(plugin.stdout || "[]");
  } catch {
    /* empty */
  }
  try {
    themes = JSON.parse(theme.stdout || "[]");
  } catch {
    /* empty */
  }
  return { ok: true, details: { id: site.id, name: site.name, port: site.port, version: version.stdout.trim(), plugins, themes } };
}

// ---------------------------------------------------------------------------
// Create / delete (fully ours)
// ---------------------------------------------------------------------------

function genPassword(bytes = 12): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export async function createSite(
  cfg: StackConfig,
  id: string,
  name: string,
  adminUser: string,
  email: string,
): Promise<Out> {
  if (!SITE_ID_RE.test(id)) return bad("invalid site id (lowercase letters, digits, dashes; 1-64 chars)");
  if (!name || name.length > 120) return bad("name required (≤120 chars)");
  if (!ADMIN_USER_RE.test(adminUser)) return bad("invalid admin user (letters, digits, _ . -)");
  if (!EMAIL_RE.test(email)) return bad("invalid email");

  const rt = await runtimeStatus(cfg);
  if (!rt.bootstrapped) return bad("stack not bootstrapped on this Otto — run bin/wp-stack-bootstrap.sh first");

  const sites = loadRegistry(cfg);
  if (sites.some((s) => s.id === id)) return bad("site id already exists");
  const db = dbPrefix(cfg) + id.replace(/-/g, "_");
  if (!/^[a-z0-9_]+$/.test(db)) return bad("invalid database name");

  const port = freePort(cfg, new Set(sites.map((s) => s.port)));
  if (!port) return bad(`no free port in ${cfg.portMin}-${cfg.portMax}`);

  const docroot = path.join(cfg.sitesDir, id, "public");
  ensureDirs(cfg);
  fs.mkdirSync(docroot, { recursive: true, mode: 0o750 });

  // 1) WordPress core files
  const dl = await wpCli(cfg, docroot, ["core", "download", "--allow-root"], 240_000);
  if (dl.code !== 0) {
    fs.rmSync(path.join(cfg.sitesDir, id), { recursive: true, force: true });
    return bad("wp core download failed: " + (dl.stderr || dl.stdout).slice(0, 200));
  }

  // 2) Database (our own user; prefix-scoped grants enforced by bootstrap)
  const mk = await mysqlSql(cfg, `CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  if (mk.code !== 0) {
    fs.rmSync(path.join(cfg.sitesDir, id), { recursive: true, force: true });
    return bad("database create failed: " + mk.stderr.replace(/.*password.*$/i, "").trim().slice(0, 180));
  }

  // 2b) wp-config.php — points at OUR database only; direct FS method
  const cred = readCred(cfg);
  if (!cred) {
    await mysqlSql(cfg, `DROP DATABASE IF EXISTS \`${db}\`;`);
    fs.rmSync(path.join(cfg.sitesDir, id), { recursive: true, force: true });
    return bad("db credential missing — run bin/wp-stack-bootstrap.sh");
  }
  const conf = await wpCli(
    cfg,
    docroot,
    [
      "config",
      "create",
      `--dbname=${db}`,
      `--dbuser=${cred.user}`,
      `--dbpass=${cred.password}`,
      `--dbhost=${cfg.dbHost}:${cfg.dbPort}`,
      `--dbprefix=${dbPrefix(cfg)}`,
      "--allow-root",
    ],
    60_000,
  );
  if (conf.code !== 0) {
    await mysqlSql(cfg, `DROP DATABASE IF EXISTS \`${db}\`;`);
    fs.rmSync(path.join(cfg.sitesDir, id), { recursive: true, force: true });
    return bad("wp config create failed: " + (conf.stderr || conf.stdout).replace(/(--db\w*=)\S+/gi, "$1***").replace(/\S*password\S*/gi, "***").slice(0, 200));
  }
  await wpCli(cfg, docroot, ["config", "set", "FS_METHOD", "direct", "--type=constant", "--allow-root"], 60_000);

  // 3) Install
  const adminPassword = genPassword();
  const inst = await wpCli(
    cfg,
    docroot,
    [
      "core",
      "install",
      `--url=http://127.0.0.1:${port}`,
      `--title=${name}`,
      `--admin_user=${adminUser}`,
      `--admin_password=${adminPassword}`,
      `--admin_email=${email}`,
      "--skip-email",
      "--allow-root",
    ],
    240_000,
  );
  if (inst.code !== 0) {
    await mysqlSql(cfg, `DROP DATABASE IF EXISTS \`${db}\`;`);
    fs.rmSync(path.join(cfg.sitesDir, id), { recursive: true, force: true });
    return bad("wp core install failed: " + (inst.stderr || inst.stdout).slice(0, 200));
  }

  const site: Site = { id, name, port, db, docroot, adminUser, createdAt: new Date().toISOString() };
  sites.push(site);
  saveRegistry(cfg, sites);

  // 4) Start it
  const started = await startSite(cfg, site);
  const list = await listSites(cfg);
  if (!started.ok) return { ok: false, error: started.error, sites: list, ts: stamp() };
  return {
    ok: true,
    site,
    sites: list,
    message: `Site created. Sign in at http://127.0.0.1:${port}/wp-admin/ as ${adminUser} / ${adminPassword} (password shown once — copy it now).`,
    ts: stamp(),
  };
}

export async function deleteSite(cfg: StackConfig, id: string, confirm: string): Promise<Out> {
  if (!SITE_ID_RE.test(id)) return bad("invalid site id");
  if (!confirm || confirm !== id) return bad("confirm by passing the site id twice");
  const sites = loadRegistry(cfg);
  const site = sites.find((s) => s.id === id);
  if (!site) return bad("unknown site id");
  await stopSite(cfg, site);
  // best-effort: never leave a serve rule pointing at a deleted site
  let serveWarn = "";
  if (site.servePort) {
    const rm = await tailscaleServeSet(site.port, site.servePort, false);
    if (!rm.ok) {
      serveWarn = ` (tailscale serve rule for :${site.servePort} left behind — remove it: tailscale serve --bg=false http://127.0.0.1:${site.port})`;
    }
  }
  const drop = await mysqlSql(cfg, `DROP DATABASE IF EXISTS \`${site.db}\`;`);
  fs.rmSync(path.join(cfg.sitesDir, id), { recursive: true, force: true });
  saveRegistry(
    cfg,
    sites.filter((s) => s.id !== id),
  );
  const list = await listSites(cfg);
  const warn = drop.code !== 0 ? " (database drop failed — check the db user)" : "";
  return { ok: true, message: `Site ${id} deleted${warn}${serveWarn}.`, sites: list, ts: stamp() };
}
