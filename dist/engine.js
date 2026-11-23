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
/**
 * Portable default stack root, in priority order:
 * 1. WP_STACK_ROOT env (anything)
 * 2. the agent workspace env, when set and present
 * 3. the standard Otto agent workspace, when it exists
 * 4. ~/otto-wp-stack on any other machine
 */
function defaultStackRoot() {
    if (process.env.WP_STACK_ROOT)
        return process.env.WP_STACK_ROOT;
    for (const ws of [process.env.OPENCLAW_WORKSPACE, process.env.OTTO_AGENT_WORKSPACE]) {
        if (ws && fs.existsSync(ws))
            return path.join(ws, "wp-stack");
    }
    const ottoWs = "/var/lib/otto/owner/agent/workspace";
    if (fs.existsSync(ottoWs))
        return path.join(ottoWs, "wp-stack");
    return path.join(os.homedir(), "otto-wp-stack");
}
export const DEFAULTS = {
    stackRoot: defaultStackRoot(),
    dbHost: "127.0.0.1",
    dbPort: 3307,
    dbUser: "wp_stack",
    portMin: 8100,
    portMax: 8199,
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
export function resolveConfig(raw) {
    const c = { ...DEFAULTS, ...(raw ?? {}) };
    c.stackRoot = path.resolve(c.stackRoot);
    if (!c.phpBin)
        c.phpBin = path.join(c.stackRoot, "runtime", "php");
    if (!c.wpCli)
        c.wpCli = path.join(c.stackRoot, "runtime", "wp-cli.phar");
    if (!c.mariadbDir)
        c.mariadbDir = path.join(c.stackRoot, "runtime", "mariadb");
    if (!c.dbDir)
        c.dbDir = path.join(c.stackRoot, "db", "data");
    if (!c.runDir)
        c.runDir = path.join(c.stackRoot, "run");
    if (!c.logsDir)
        c.logsDir = path.join(c.stackRoot, "logs");
    if (!c.sitesDir)
        c.sitesDir = path.join(c.stackRoot, "sites");
    if (!c.registryFile)
        c.registryFile = path.join(c.stackRoot, "sites.json");
    if (!c.credFile)
        c.credFile = path.join(c.stackRoot, ".db-credential");
    return c;
}
export const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ACTIONS = new Set(["start", "stop", "restart"]);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const ADMIN_USER_RE = /^[a-z0-9_.-]{1,60}$/i;
export function bad(msg) {
    return { ok: false, error: msg };
}
export function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
export function portOpen(host, port, timeoutMs = 700) {
    return new Promise((resolve) => {
        const s = net.createConnection({ host, port, timeout: timeoutMs });
        const done = (v) => {
            s.destroy();
            resolve(v);
        };
        s.once("connect", () => done(true));
        s.once("timeout", () => done(false));
        s.once("error", () => done(false));
    });
}
export function run(argv, timeoutMs = 25_000) {
    return new Promise((resolve) => {
        const [cmd, ...args] = argv;
        let settled = false;
        const done = (code, stdout, stderr) => {
            if (!settled) {
                settled = true;
                resolve({ code, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "").trim() });
            }
        };
        try {
            execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err && err.code === "ENOENT") {
                    done(127, "", `missing: ${cmd}`);
                    return;
                }
                done(err && typeof err.code === "number" ? err.code : err ? 1 : 0, String(stdout ?? ""), String(stderr ?? ""));
            });
        }
        catch (e) {
            // execFile can throw synchronously (ETXTBSY while a binary is being
            // replaced, EACCES, …) — a failed spawn is an answer, never a crash.
            const err = e;
            done(126, "", err?.code === "ENOENT" ? `missing: ${cmd}` : `${err?.code ?? "spawn error"}: ${err?.message ?? e}`);
        }
    });
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function isFile(p) {
    try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}
function ensureDirs(cfg) {
    for (const d of [cfg.stackRoot, path.join(cfg.stackRoot, "runtime"), cfg.dbDir, cfg.runDir, cfg.logsDir, cfg.sitesDir]) {
        fs.mkdirSync(d, { recursive: true, mode: 0o750 });
    }
}
export function loadRegistry(cfg) {
    try {
        const j = JSON.parse(fs.readFileSync(cfg.registryFile, "utf8"));
        return Array.isArray(j.sites) ? j.sites : [];
    }
    catch {
        return [];
    }
}
export function saveRegistry(cfg, sites) {
    ensureDirs(cfg);
    const tmp = cfg.registryFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sites }, null, 2), { mode: 0o640 });
    fs.renameSync(tmp, cfg.registryFile);
}
export function dbPrefix(cfg) {
    // wps_<id with dashes as underscores> — the bootstrap grants the wp_stack
    // user exactly this prefix, nothing else.
    return "wps_";
}
function freePort(cfg, taken) {
    for (let p = cfg.portMin; p <= cfg.portMax; p++) {
        if (!taken.has(p))
            return p;
    }
    return null;
}
export async function runtimeStatus(cfg) {
    const st = {
        stackRoot: cfg.stackRoot,
        bootstrapped: false,
        php: { installed: isFile(cfg.phpBin) },
        wpCli: { installed: isFile(cfg.wpCli) },
        mariadb: { installed: isFile(path.join(cfg.mariadbDir, "bin", "mariadbd")) },
        dbCredential: isFile(cfg.credFile),
    };
    if (st.php.installed) {
        const r = await run([cfg.phpBin, "-v"], 10_000);
        if (r.code === 0)
            st.php.version = r.stdout.split("\n")[0]?.slice(0, 80);
        else {
            st.php.installed = false;
            st.php.error = (r.stderr || "php -v failed").slice(0, 120);
        }
    }
    if (st.mariadb.installed) {
        const r = await run([path.join(cfg.mariadbDir, "bin", "mariadbd"), "--version"], 10_000);
        if (r.code === 0)
            st.mariadb.version = r.stdout.slice(0, 80);
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
let bootstrapRunning = false;
let bootstrapState = { running: false, phase: "idle", log: [] };
function bootstrapStateFile(cfg) {
    return path.join(cfg.stackRoot, ".bootstrap-state.json");
}
function persistBootstrap(cfg) {
    try {
        ensureDirs(cfg);
        fs.writeFileSync(bootstrapStateFile(cfg), JSON.stringify({ ...bootstrapState, running: bootstrapRunning }), { mode: 0o600 });
    }
    catch {
        /* best effort */
    }
}
function bootLog(cfg, line) {
    bootstrapState.log = [...bootstrapState.log.slice(-59), `${new Date().toISOString().slice(11, 19)} ${line}`.slice(0, 240)];
    bootstrapState.updatedAt = new Date().toISOString();
    persistBootstrap(cfg);
}
export function bootstrapProgressOf(cfg) {
    if (!bootstrapRunning) {
        try {
            const j = JSON.parse(fs.readFileSync(bootstrapStateFile(cfg), "utf8"));
            if (j && typeof j.phase === "string") {
                if (j.running) {
                    return { ...j, running: false, error: j.error ?? "install was interrupted (gateway restart?) — start it again" };
                }
                return j;
            }
        }
        catch {
            /* no persisted state */
        }
    }
    return { ...bootstrapState, running: bootstrapRunning };
}
async function phpRuns(cfg) {
    if (!isFile(cfg.phpBin))
        return false;
    return (await run([cfg.phpBin, "-v"], 10_000)).code === 0;
}
async function wpCliRuns(cfg) {
    if (!isFile(cfg.wpCli) || !(await phpRuns(cfg)))
        return false;
    return (await run([cfg.phpBin, cfg.wpCli, "--version", "--allow-root"], 60_000)).code === 0;
}
function findInDir(dir, name, maxDepth) {
    if (maxDepth < 0)
        return null;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return null;
    }
    for (const e of entries) {
        if (e.isFile() && e.name === name)
            return path.join(dir, e.name);
    }
    for (const e of entries) {
        if (e.isDirectory()) {
            const found = findInDir(path.join(dir, e.name), name, maxDepth - 1);
            if (found)
                return found;
        }
    }
    return null;
}
async function download(url, dest, timeoutMs) {
    const r = await run(["curl", "-fsSL", "--retry", "3", "--connect-timeout", "15", "-o", dest, url], timeoutMs);
    return { code: r.code, stderr: (r.stderr || `curl exit ${r.code}`).slice(-200) };
}
/** Start (or report on) installing this stack's own runtime. Never blocks. */
export async function startBootstrap(cfg) {
    if (bootstrapRunning)
        return { ok: true, result: "bootstrap already running", progress: bootstrapProgressOf(cfg) };
    if (process.getuid?.() === 0)
        return bad("do not run the stack as root — it must live and run as the Otto agent user");
    if (!/^[A-Za-z0-9_]{1,32}$/.test(cfg.dbUser))
        return bad("invalid dbUser config (letters, digits, underscore)");
    const rt = await runtimeStatus(cfg);
    if (rt.bootstrapped)
        return { ok: true, result: "runtime already installed", progress: bootstrapProgressOf(cfg) };
    for (const bin of ["curl", "tar"]) {
        if ((await run([bin, "--version"], 10_000)).code !== 0)
            return bad(`bootstrap needs ${bin} on PATH`);
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
async function runBootstrap(cfg) {
    const t0 = Date.now();
    let tmp = "";
    try {
        ensureDirs(cfg);
        // sweep temp dirs left behind by interrupted installs (crash/restart)
        try {
            for (const e of fs.readdirSync(os.tmpdir())) {
                if (!e.startsWith("wpstack-boot-"))
                    continue;
                const p = path.join(os.tmpdir(), e);
                try {
                    if (Date.now() - fs.statSync(p).mtimeMs > 6 * 3600_000)
                        fs.rmSync(p, { recursive: true, force: true });
                }
                catch {
                    /* not ours */
                }
            }
        }
        catch {
            /* best effort */
        }
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wpstack-boot-"));
        // 1) PHP — static bulk build (mysqli included, WordPress requires it)
        if (await phpRuns(cfg))
            bootLog(cfg, "php: present");
        else {
            bootstrapState.phase = "php";
            bootLog(cfg, `php: downloading static build ${BOOTSTRAP_URLS.phpVersion} (bulk, with mysqli)…`);
            const d = await download(BOOTSTRAP_URLS.php, path.join(tmp, "php.tgz"), 900_000);
            if (d.code !== 0)
                throw new Error("php download failed: " + d.stderr);
            const x = await run(["tar", "-xzf", path.join(tmp, "php.tgz"), "-C", tmp], 300_000);
            if (x.code !== 0)
                throw new Error("php extract failed");
            const found = findInDir(tmp, "php", 2);
            if (!found)
                throw new Error("php binary not found in the download");
            // install atomically so concurrent readers never spawn a half-written binary
            fs.copyFileSync(found, cfg.phpBin + ".part");
            fs.chmodSync(cfg.phpBin + ".part", 0o755);
            fs.renameSync(cfg.phpBin + ".part", cfg.phpBin);
            if (!(await phpRuns(cfg)))
                throw new Error("downloaded php does not run");
            bootLog(cfg, "php: installed");
        }
        // 2) WP-CLI phar
        if (await wpCliRuns(cfg))
            bootLog(cfg, "wp-cli: present");
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
        if (isFile(mariadbBin(cfg, "mariadbd")))
            bootLog(cfg, "mariadb: present");
        else {
            bootstrapState.phase = "mariadb";
            bootLog(cfg, `mariadb: downloading ${BOOTSTRAP_URLS.dbVersion} bintar (~333 MB — may take several minutes)…`);
            const d = await download(BOOTSTRAP_URLS.db, path.join(tmp, "db.tgz"), 3_600_000);
            if (d.code !== 0)
                throw new Error("mariadb download failed: " + d.stderr);
            fs.mkdirSync(cfg.mariadbDir, { recursive: true });
            const x = await run(["tar", "-xzf", path.join(tmp, "db.tgz"), "-C", cfg.mariadbDir, "--strip-components=1"], 1_200_000);
            if (x.code !== 0)
                throw new Error("mariadb extract failed");
            if (!isFile(mariadbBin(cfg, "mariadbd")))
                throw new Error("mariadbd missing after extract");
            bootLog(cfg, "mariadb: installed");
        }
        // 4) Our own data directory
        if (!fs.existsSync(path.join(cfg.dbDir, "mysql"))) {
            bootstrapState.phase = "dbinit";
            bootLog(cfg, "db: initialising datadir…");
            let user = "";
            try {
                user = os.userInfo().username;
            }
            catch {
                user = String(process.getuid?.() ?? "");
            }
            const r = await run([
                path.join(cfg.mariadbDir, "scripts", "mariadb-install-db"),
                `--user=${user}`,
                `--basedir=${cfg.mariadbDir}`,
                `--datadir=${cfg.dbDir}`,
                "--auth-root-authentication-method=normal",
                "--skip-test-db",
            ], 600_000);
            if (r.code !== 0)
                throw new Error("mariadb-install-db failed: " + (r.stderr || r.stdout).slice(-200));
            bootLog(cfg, "db: datadir initialised");
        }
        else
            bootLog(cfg, "db: datadir ready");
        // 5) Bring our own server up on the stack port
        bootstrapState.phase = "dbstart";
        const up = await startDb(cfg);
        if (!up.ok)
            throw new Error(String(up.error ?? "database did not start"));
        bootLog(cfg, `db: up on ${cfg.dbHost}:${cfg.dbPort}`);
        // 6) Stack-scoped mysql user (grants limited to wps_%) + credential file
        if (!isFile(cfg.credFile)) {
            bootstrapState.phase = "dbuser";
            bootLog(cfg, `db: creating user '${cfg.dbUser}' (grants limited to wps_% databases)…`);
            const pass = crypto.randomBytes(24).toString("hex");
            const sql = `CREATE USER IF NOT EXISTS '${cfg.dbUser}'@'%' IDENTIFIED BY '${pass}';` +
                `GRANT ALL PRIVILEGES ON \`wps\_%\`.* TO '${cfg.dbUser}'@'%';` +
                `FLUSH PRIVILEGES;`;
            const r = await run([mariadbBin(cfg, "mariadb"), "--protocol=socket", `--socket=${dbSocket(cfg)}`, "-uroot", "-e", sql], 60_000);
            if (r.code !== 0)
                throw new Error("user create failed: " + r.stderr.replace(/IDENTIFIED BY '[^']*'/g, "IDENTIFIED BY '***'").slice(0, 200));
            fs.writeFileSync(cfg.credFile, JSON.stringify({ user: cfg.dbUser, password: pass, socket: dbSocket(cfg), port: cfg.dbPort }, null, 2), { mode: 0o600 });
            bootLog(cfg, "db: credential written (.db-credential, mode 600)");
        }
        else
            bootLog(cfg, "db: credential present");
        // 7) Prove the prefix-scoped grants actually work
        const probe = await mysqlSql(cfg, "CREATE DATABASE IF NOT EXISTS wps_bootstrap_probe; DROP DATABASE wps_bootstrap_probe;");
        if (probe.code !== 0)
            throw new Error("stack db user cannot create wps_* databases — check grants");
        bootstrapState.phase = "ready";
        bootLog(cfg, `done — runtime ready under ${cfg.stackRoot} in ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    catch (e) {
        bootstrapState.phase = "error";
        bootstrapState.error = String(e?.message ?? e)
            .replace(/IDENTIFIED BY '[^']*'/g, "IDENTIFIED BY '***'")
            .slice(0, 300);
        bootLog(cfg, "ERROR: " + bootstrapState.error);
    }
    finally {
        if (tmp)
            fs.rmSync(tmp, { recursive: true, force: true });
    }
}
function readCred(cfg) {
    try {
        const j = JSON.parse(fs.readFileSync(cfg.credFile, "utf8"));
        if (typeof j.user === "string" && typeof j.password === "string") {
            return { user: j.user, password: j.password, socket: j.socket ?? path.join(cfg.runDir, "mysql.sock") };
        }
    }
    catch {
        /* fallthrough */
    }
    return null;
}
function mariadbBin(cfg, name) {
    return path.join(cfg.mariadbDir, "bin", name);
}
export function dbSocket(cfg) {
    return path.join(cfg.runDir, "mysql.sock");
}
/** Run SQL as the stack's own mysql user (prefix-scoped grants only). */
export async function mysqlSql(cfg, sql, timeoutMs = 30_000) {
    const cred = readCred(cfg);
    if (!cred)
        return { code: 1, stdout: "", stderr: "db credential missing — press Install runtime in the WP Stack app (or run bin/wp-stack-bootstrap.sh)" };
    return run([
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
    ], timeoutMs);
}
export async function dbPing(cfg) {
    if (!(await portOpen(cfg.dbHost, cfg.dbPort, 500)))
        return { up: false };
    const cred = readCred(cfg);
    if (!cred)
        return { up: true, error: "up, but credential file missing" };
    const r = await run([mariadbBin(cfg, "mariadb"), "--protocol=TCP", `-h${cfg.dbHost}`, `-P${cfg.dbPort}`, `-u${cred.user}`, `-p${cred.password}`, "-e", "SELECT VERSION()"], 10_000);
    if (r.code !== 0)
        return { up: true, error: (r.stderr || "query failed").replace(/.*password.*$/i, "").trim().slice(0, 120) };
    return { up: true, version: r.stdout.split("\n").pop()?.slice(0, 60) };
}
export async function startDb(cfg) {
    const rt = await runtimeStatus(cfg);
    if (!rt.mariadb.installed)
        return bad("mariadb runtime missing — press Install runtime in the WP Stack app (or run bin/wp-stack-bootstrap.sh)");
    if (!(await portOpen(cfg.dbHost, cfg.dbPort, 400))) {
        if (!fs.existsSync(cfg.dbDir) || fs.readdirSync(cfg.dbDir).length === 0) {
            return bad("database not initialised — press Install runtime in the WP Stack app (or run bin/wp-stack-bootstrap.sh)");
        }
        ensureDirs(cfg);
        const log = fs.openSync(path.join(cfg.logsDir, "mariadb.log"), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
        try {
            const p = spawn(mariadbBin(cfg, "mariadbd"), [
                `--datadir=${cfg.dbDir}`,
                `--socket=${dbSocket(cfg)}`,
                `--pid-file=${path.join(cfg.runDir, "mysqld.pid")}`,
                `--bind-address=${cfg.dbHost}`,
                `--port=${cfg.dbPort}`,
                "--skip-name-resolve",
                "--skip-networking=0",
                `--log-error=${path.join(cfg.logsDir, "mariadb.log")}`,
            ], { detached: true, stdio: ["ignore", log, log], cwd: cfg.stackRoot });
            await new Promise((res, rej) => {
                p.once("spawn", () => res());
                p.once("error", (e) => rej(e));
            });
            p.unref();
        }
        catch (e) {
            return bad(`mariadbd spawn failed: ${e.message}`.slice(0, 160));
        }
        finally {
            fs.closeSync(log);
        }
        for (let i = 0; i < 240; i++) {
            if (await portOpen(cfg.dbHost, cfg.dbPort, 400))
                return { ok: true, result: "database started" };
            await sleep(500);
        }
        // First-run InnoDB init can be slow; include the server log tail so users
        // (and the dashboard) see WHY instead of hunting for the file.
        let tail = "";
        try {
            tail = fs.readFileSync(path.join(cfg.logsDir, "mariadb.log"), "utf8").split("\n").slice(-12).join(" | ").slice(-400);
        }
        catch {
            /* no log */
        }
        return bad(("database did not come up within ~3 min — check logs/mariadb.log" + (tail ? " · " + tail : "")).slice(0, 500));
    }
    return { ok: true, result: "already running" };
}
export async function stopDb(cfg) {
    if (!(await portOpen(cfg.dbHost, cfg.dbPort, 400)))
        return { ok: true, result: "already stopped" };
    const cred = readCred(cfg);
    if (!cred)
        return bad("no credential file; cannot shut the database down cleanly");
    const r = await run([
        mariadbBin(cfg, "mariadb-admin"),
        "--protocol=TCP",
        `-h${cfg.dbHost}`,
        `-P${cfg.dbPort}`,
        `-u${cred.user}`,
        `-p${cred.password}`,
        "shutdown",
    ], 30_000);
    // shutdown closes the socket mid-response; treat connection reset as success.
    if (r.code !== 0 && !/shutdown|Lost connection|server has gone|Access denied/i.test(r.stderr)) {
        return bad((r.stderr || "shutdown failed").replace(/.*password.*$/i, "").trim().slice(0, 160));
    }
    for (let i = 0; i < 40; i++) {
        if (!(await portOpen(cfg.dbHost, cfg.dbPort, 400)))
            return { ok: true, result: "database stopped" };
        await sleep(250);
    }
    return { ok: true, result: "shutdown requested (still draining)" };
}
// ---------------------------------------------------------------------------
// WP-CLI + site processes
// ---------------------------------------------------------------------------
export async function wpCli(cfg, docroot, args, timeoutMs = 120_000) {
    return run([cfg.phpBin, "-d", "memory_limit=1G", cfg.wpCli, `--path=${docroot}`, "--skip-plugins", "--skip-themes", ...args], timeoutMs);
}
/** All PIDs that are OUR php -S for this exact port + docroot. */
export function siteProcesses(cfg, site) {
    const found = [];
    let phpReal = "";
    try {
        phpReal = fs.realpathSync(cfg.phpBin);
    }
    catch {
        return found;
    }
    let docReal = "";
    try {
        docReal = fs.realpathSync(site.docroot);
    }
    catch {
        return found;
    }
    const myUid = process.getuid?.();
    for (const p of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(p))
            continue;
        try {
            const dir = "/proc/" + p;
            if (fs.statSync(dir).uid !== myUid)
                continue;
            const cmdline = fs.readFileSync(dir + "/cmdline", "utf8").split("\0");
            const exe = fs.readlinkSync(dir + "/exe").replace(/ \(deleted\)$/, "");
            if (exe !== phpReal)
                continue;
            const i = cmdline.indexOf("-S");
            const t = cmdline.indexOf("-t");
            if (i >= 0 && t >= 0 && cmdline[i + 1] === `127.0.0.1:${site.port}` && fs.realpathSync(cmdline[t + 1]) === docReal) {
                found.push(Number(p));
            }
        }
        catch {
            /* vanished / unreadable — not ours */
        }
    }
    return found;
}
export async function startSite(cfg, site) {
    const rt = await runtimeStatus(cfg);
    if (!rt.php.installed)
        return bad("php runtime missing — run bin/wp-stack-bootstrap.sh");
    if (!fs.existsSync(site.docroot))
        return bad("site files missing; delete and recreate the site");
    if (await portOpen("127.0.0.1", site.port)) {
        if (siteProcesses(cfg, site).length)
            return { ok: true, result: "already running" };
        return bad(`port ${site.port} is held by a process this stack does not own — refusing`);
    }
    ensureDirs(cfg);
    const fd = fs.openSync(path.join(cfg.logsDir, `${site.id}.log`), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
    try {
        const p = spawn(cfg.phpBin, ["-d", "memory_limit=512M", "-S", `127.0.0.1:${site.port}`, "-t", site.docroot], {
            detached: true,
            stdio: ["ignore", fd, fd],
            cwd: site.docroot,
        });
        await new Promise((res, rej) => {
            p.once("spawn", () => res());
            p.once("error", (e) => rej(e));
        });
        p.unref();
    }
    catch (e) {
        return bad(`php -S spawn failed: ${e.message}`.slice(0, 160));
    }
    finally {
        fs.closeSync(fd);
    }
    for (let i = 0; i < 40; i++) {
        if (await portOpen("127.0.0.1", site.port))
            return { ok: true, result: "started" };
        await sleep(150);
    }
    return bad("server did not start within 6s — check logs/" + site.id + ".log");
}
export async function stopSite(cfg, site) {
    const pids = siteProcesses(cfg, site);
    if (!pids.length) {
        if (await portOpen("127.0.0.1", site.port))
            return bad(`port ${site.port} held by a foreign process — refusing to kill it`);
        return { ok: true, result: "already stopped" };
    }
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGTERM");
        }
        catch {
            /* race */
        }
    }
    for (let i = 0; i < 20; i++) {
        if (!siteProcesses(cfg, site).length && !(await portOpen("127.0.0.1", site.port, 300)))
            return { ok: true, result: "stopped" };
        await sleep(150);
    }
    for (const pid of siteProcesses(cfg, site)) {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch {
            /* race */
        }
    }
    return { ok: true, result: "stopped (forced)" };
}
export async function listSites(cfg) {
    const sites = loadRegistry(cfg);
    return Promise.all(sites.map(async (s) => ({
        ...s,
        running: (await portOpen("127.0.0.1", s.port, 400)) && siteProcesses(cfg, s).length > 0,
        url: `http://127.0.0.1:${s.port}`,
    })));
}
export async function siteDetails(cfg, site) {
    const base = [cfg.phpBin, "-d", "memory_limit=1G", cfg.wpCli, `--path=${site.docroot}`, "--skip-plugins", "--skip-themes", "--no-color"];
    const plugin = await run([...base, "plugin", "list", "--format=json", "--fields=name,status,version"], 120_000);
    if (plugin.code !== 0)
        return bad((plugin.stderr || plugin.stdout || "wp plugin list failed").slice(0, 200));
    const theme = await run([...base, "theme", "list", "--format=json", "--fields=name,status,version"], 120_000);
    const version = await run([...base, "core", "version"], 60_000);
    let plugins = [];
    let themes = [];
    try {
        plugins = JSON.parse(plugin.stdout || "[]");
    }
    catch {
        /* empty */
    }
    try {
        themes = JSON.parse(theme.stdout || "[]");
    }
    catch {
        /* empty */
    }
    return { ok: true, details: { id: site.id, name: site.name, port: site.port, version: version.stdout.trim(), plugins, themes } };
}
// ---------------------------------------------------------------------------
// Create / delete (fully ours)
// ---------------------------------------------------------------------------
function genPassword(bytes = 12) {
    return crypto.randomBytes(bytes).toString("base64url");
}
export async function createSite(cfg, id, name, adminUser, email) {
    if (!SITE_ID_RE.test(id))
        return bad("invalid site id (lowercase letters, digits, dashes; 1-64 chars)");
    if (!name || name.length > 120)
        return bad("name required (≤120 chars)");
    if (!ADMIN_USER_RE.test(adminUser))
        return bad("invalid admin user (letters, digits, _ . -)");
    if (!EMAIL_RE.test(email))
        return bad("invalid email");
    const rt = await runtimeStatus(cfg);
    if (!rt.bootstrapped)
        return bad("stack not bootstrapped on this Otto — run bin/wp-stack-bootstrap.sh first");
    const sites = loadRegistry(cfg);
    if (sites.some((s) => s.id === id))
        return bad("site id already exists");
    const db = dbPrefix(cfg) + id.replace(/-/g, "_");
    if (!/^[a-z0-9_]+$/.test(db))
        return bad("invalid database name");
    const port = freePort(cfg, new Set(sites.map((s) => s.port)));
    if (!port)
        return bad(`no free port in ${cfg.portMin}-${cfg.portMax}`);
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
    const conf = await wpCli(cfg, docroot, [
        "config",
        "create",
        `--dbname=${db}`,
        `--dbuser=${cred.user}`,
        `--dbpass=${cred.password}`,
        `--dbhost=${cfg.dbHost}:${cfg.dbPort}`,
        `--dbprefix=${dbPrefix(cfg)}`,
        "--allow-root",
    ], 60_000);
    if (conf.code !== 0) {
        await mysqlSql(cfg, `DROP DATABASE IF EXISTS \`${db}\`;`);
        fs.rmSync(path.join(cfg.sitesDir, id), { recursive: true, force: true });
        return bad("wp config create failed: " + (conf.stderr || conf.stdout).replace(/(--db\w*=)\S+/gi, "$1***").replace(/\S*password\S*/gi, "***").slice(0, 200));
    }
    await wpCli(cfg, docroot, ["config", "set", "FS_METHOD", "direct", "--type=constant", "--allow-root"], 60_000);
    // 3) Install
    const adminPassword = genPassword();
    const inst = await wpCli(cfg, docroot, [
        "core",
        "install",
        `--url=http://127.0.0.1:${port}`,
        `--title=${name}`,
        `--admin_user=${adminUser}`,
        `--admin_password=${adminPassword}`,
        `--admin_email=${email}`,
        "--skip-email",
        "--allow-root",
    ], 240_000);
    if (inst.code !== 0) {
        await mysqlSql(cfg, `DROP DATABASE IF EXISTS \`${db}\`;`);
        fs.rmSync(path.join(cfg.sitesDir, id), { recursive: true, force: true });
        return bad("wp core install failed: " + (inst.stderr || inst.stdout).slice(0, 200));
    }
    const site = { id, name, port, db, docroot, adminUser, createdAt: new Date().toISOString() };
    sites.push(site);
    saveRegistry(cfg, sites);
    // 4) Start it
    const started = await startSite(cfg, site);
    const list = await listSites(cfg);
    if (!started.ok)
        return { ok: false, error: started.error, sites: list, ts: stamp() };
    return {
        ok: true,
        site,
        sites: list,
        message: `Site created. Sign in at http://127.0.0.1:${port}/wp-admin/ as ${adminUser} / ${adminPassword} (password shown once — copy it now).`,
        ts: stamp(),
    };
}
export async function deleteSite(cfg, id, confirm) {
    if (!SITE_ID_RE.test(id))
        return bad("invalid site id");
    if (!confirm || confirm !== id)
        return bad("confirm by passing the site id twice");
    const sites = loadRegistry(cfg);
    const site = sites.find((s) => s.id === id);
    if (!site)
        return bad("unknown site id");
    await stopSite(cfg, site);
    const drop = await mysqlSql(cfg, `DROP DATABASE IF EXISTS \`${site.db}\`;`);
    fs.rmSync(path.join(cfg.sitesDir, id), { recursive: true, force: true });
    saveRegistry(cfg, sites.filter((s) => s.id !== id));
    const list = await listSites(cfg);
    const warn = drop.code !== 0 ? " (database drop failed — check the db user)" : "";
    return { ok: true, message: `Site ${id} deleted${warn}.`, sites: list, ts: stamp() };
}
