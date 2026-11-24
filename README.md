# otto-wp-stack

**Standalone headless WordPress stack for Otto.** One OpenClaw plugin + one Otto
dashboard app. No sudo, no systemd, no apt, no terminal commands, and no
dependency on any other WordPress stack — everything lives in one folder and
runs as the Otto agent user. Deploy it on any Otto **entirely from chat**:
install card → enable → one sentence to Otto per step.

```
┌─────────────────────┐   otto.script    ┌──────────────────┐   1 HTTP call   ┌───────────────────────────┐
│ Otto app            │ ───────────────▶ │ scripts/stack.mjs│ ──────────────▶ │ Gateway route              │
│ apps/wp-stack-next/ │                  │ (no model turns) │                 │ /otto-wp-stack/api (token) │
└─────────────────────┘                  └──────────────────┘                 └─────────────┬─────────────┘
                                                                                            │
                                                          ┌─────────────────────────────────┴────────────┐
                                                          │ otto-wp-stack plugin                         │
                                                          │  own runtime:  runtime/php, wp-cli.phar,     │
                                                          │                runtime/mariadb (own server,  │
                                                          │                own datadir, port 3307)       │
                                                          │  own registry: sites.json                    │
                                                          │  own sites:    sites/<id>/public on :8100+   │
                                                          │  own HTTPS:    wp_stack_serve (tailscale)    │
                                                          │  tailnet:    wp_stack_expose (bind :port     │
                                                          │               on the Tailscale IP)           │
                                                          └──────────────────────────────────────────────┘
```

## Deploy — 100% chat, zero terminal

Every step is a message to Otto (or a button in the app). The owner only ever
taps **approval cards**.

1. **Install + enable** — tell Otto:
   > *"Install @lunarlyra/otto-wp-stack from ClawHub and enable it."*
   Tap the install approval card and the capability review card. On enable the
   plugin mints its own `.api-token` (owner-only file, never pasted by anyone).

2. **Runtime** — tell Otto:
   > *"Install the wp-stack runtime."*
   Otto calls `wp_stack_bootstrap`: downloads and configures its own static
   PHP (mysqli built in), WP-CLI and MariaDB bintar (~360 MB, a few minutes),
   initialises its own datadir, starts its own database on the stack port and
   creates the prefix-scoped mysql user. Idempotent — safe to re-run after any
   restart. (The dashboard's **Install runtime** button does the same thing.)

3. **Dashboard** — tell Otto:
   > *"Set up the WP Stack dashboard."*
   Otto publishes one of the two bundled templates (see below) and, for the
   scripts app, presses **Auto-connect**: the app asks Otto in one tap, Otto
   reads the token file itself, writes the app's `config.json`, and verifies
   the probe. No token ever appears in chat or gets typed by a human.

4. **First site** — tell Otto:
   > *"Make a wp site called demo."*
   The one-time admin password is shown once, in chat.

5. **HTTPS exposure** — tell Otto:
   > *"Serve the demo site."*
   `wp_stack_serve` adds the Tailscale Serve rule and repoints WordPress
   `siteurl`/`home` at `https://<magicdns>:<port>`. *"Unserve the demo site"*
   reverses it. No tailscale command needed — see the note below.

6. **Tailnet exposure (no operator grant needed)** — tell Otto:
   > *"Expose the demo site on the tailnet."*
   `wp_stack_expose` binds that site's own php server to this Otto's Tailscale
   IP and repoints `siteurl`/`home` at `http://<magicdns>:<sitePort>` — any
   tailnet device (your Mac) can open it over plain HTTP, with **no tailscale
   mutation at all**, so it works even before the operator grant that
   `wp_stack_serve` needs. *"Unexpose the demo site"* reverses it.

Then just use the board: Sites (start/stop/restart/details/delete), New site,
System (db start/stop, HTTPS rules). See **[SETUP.md](SETUP.md)** for the
exact agent-facing flow.

### Which dashboard app? (scripts app vs console app)

The package ships two publishable dashboards:

| | `app/` — **scripts app** | `console-app/` — **console app** |
|---|---|---|
| How it talks to the plugin | `otto.script` → one HTTP call to the plugin route (instant, no model turns); browser-fetch fallback | `otto.data` (pushed by Otto via `wp_stack_status` + `otto_set_artifact_data`); buttons `otto.ask` sentences to chat |
| Needs | the Otto app must be able to approve **app scripts** — the gateway offers the `appScripts` capability only for **Otto app ≥ 2.4.0** (`minAppVersion` gate) — plus one scripts+network approval | nothing: no scripts, no token, no network capability |
| Publish target | `apps/wp-stack-next/` | `apps/wp-stack-console/` |

The setup Otto picks the scripts app when the Otto app can approve scripts,
and the console app otherwise. On apps older than 2.4.0 the scripts approval
card can never be shown, so the gateway silently **drops `scripts/` at
publish** — the tell is a scripts app whose connection probe fails on the
script path. The console app renders identically from `otto.data` (it parses
string-or-object data and re-pulls on visibility + a 20 s poll, so a
backgrounded phone view catches up when it comes back).

### HTTPS exposure — `wp_stack_serve` / `wp_stack_unserve`

`wp_stack_serve(siteId, httpsPort?)` is the only way rules are created:
whitelisted site id, target always `http://127.0.0.1:<registered port>`,
HTTPS port an integer inside `servePortMin..servePortMax` (8443–8499) that no
other rule occupies. It runs `tailscale serve --bg --https=<port>
http://127.0.0.1:<sitePort>`, updates `wp option siteurl/home`, and records
the rule in the registry. `wp_stack_unserve(siteId)` removes the rule
(`tailscale serve --bg=false <target>` — current tailscale has no `serve
remove` subcommand) and restores the local URL. Deleting a site also cleans up
its rule.

> **Operator grant (one time, per Otto):** tailscaled lets only the tailscale
> **operator** mutate serve config, and on Otto the agent user usually is not
> it — the first serve answers `Access denied: serve config denied`. The tool
> returns that error with the exact fix: the device operator runs
> `sudo tailscale set --operator=<agent user>` once on the Otto host, and from
> then on serving works from chat for good. Until that grant is made, the
> error also prints the owner-side single command equivalent. Everything else
> (runtime, sites, db, dashboards) works without it.

### Tailnet exposure — `wp_stack_expose` / `wp_stack_unexpose`

The complement to Serve for Ottos where the operator grant above has not been
made: no serve config is touched at all. `wp_stack_expose(siteId)`

1. resolves this Otto's Tailscale IPv4 + MagicDNS name (tailscale must be up),
2. re-binds the site's own `php -S` from loopback to the Tailscale IP (php -S
   binds one address; the old server is reaped by ownership first),
3. updates WordPress `siteurl`/`home` to `http://<magicdns>:<sitePort>`,
4. records `exposed`/`exposeUrl` in the site registry.

Any tailnet peer (e.g. your Mac) then opens the site at that URL — plain HTTP
on the site port, no certificate, no serve rule, **no operator grant**.
`wp_stack_unexpose(siteId)` restores `http://127.0.0.1:<port>` and re-binds
the server to the `bindHost` config. A failed expose rolls back completely.

Exposed and served are mutually exclusive: each op refuses the other state,
and `wp_stack_serve` also refuses while `bindHost` is set off loopback
(tailscaled proxies to `127.0.0.1`). The `bindHost` config itself is
whitelisted — `"127.0.0.1"` (default), `"tailnet"`, or a literal IPv4; it is
the only config-influenced piece of the `php -S` argv and nothing else is
accepted. Phone Otto apps cannot resolve tailnet names either — open exposed
URLs from tailnet devices, same as served ones.

## What "standalone" means (testable claims)

- The plugin reads/writes **only** its `stackRoot` folder (default
  `<agent workspace>/wp-stack`, or `~/otto-wp-stack` elsewhere). Its one
  external mutation is Tailscale Serve rules for **its own registered sites**,
  through `wp_stack_serve`/`wp_stack_unserve` only; the rules view stays
  read-only everywhere else.
- Its database is **its own MariaDB bintar** with **its own datadir** on port
  **3307**, reached as a stack-scoped mysql user whose grants are limited to
  `wps_%` databases. It never touches any other MySQL/MariaDB on the box.
- Site servers are **its own child processes** (`runtime/php -S` on ports
  8100–8199, bound to the whitelisted `bindHost` — loopback by default, this
  Otto's Tailscale IPv4 while a site is exposed). It only ever signals
  processes verified as its own
  (exe path + port + docroot + uid all match).
- No systemd units, no root helpers, no other panels or worker scripts.
  `test/standalone-check.mjs` fails the build if any plugin/app file so much
  as names another stack's paths, ports, units or panels.

## Layout

```
otto-wp-stack-plugin/          ← the npm package (ClawHub: @lunarlyra/otto-wp-stack)
  openclaw.plugin.json         ← manifest; contracts.tools gates which tools agents get
  dist/                        ← compiled; ship as-is, or `npm run build`
  src/                         ← TypeScript source (index/stack/engine)
  bin/wp-stack-bootstrap.sh    ← offline fallback for the runtime install (no sudo)
  app/                         ← dashboard app TEMPLATE (scripts-based; Otto app ≥ 2.4.0)
  console-app/                 ← dashboard app TEMPLATE (zero-scripts; every Otto app)
  SETUP.md                     ← the agent-facing, zero-command setup flow
  test/standalone-check.mjs    ← isolation + live e2e test
```

## Daily use (the app)

- **Sites** — Start/Stop/Restart/Details/Delete (type the id to confirm),
  Open / WP Admin links, **Serve / Unserve** per site (Tailscale Serve HTTPS)
  and **Expose / Unexpose** per site (plain-HTTP tailnet reach via the
  Tailscale IP).
- **New site** — creates its own `wps_*` database and its own PHP server and
  starts it; the one-time admin password is shown **once**.
- **System** — runtime versions, the stack's own database (Start db / Stop db),
  and the Tailscale Serve rules view (rules created by this stack are marked
  *ours*).
- **Settings** (scripts app) — API token + connection probe. Rotate with the
  plugin's `rotate-token` action (Auto-connect re-wires it; no paste needed).

## Self-test

```bash
node test/standalone-check.mjs
```

Checks isolation (no other-stack references anywhere in plugin/app code,
including both app templates and SETUP.md), then runs a live e2e: starts its
own database, creates a real WordPress site through its own runtime, exercises
start/stop/details/guards **and the serve/unserve round-trip** (or, when
tailscaled denies agent-user mutations, that the denial comes back
actionable) **and the expose/unexpose round-trip** (or, when tailscale is
down, that the failure is actionable and rolled back), deletes it, and
confirms nothing is left behind. Also verifies
the self-bootstrap op is idempotent and that every contract tool is listed in
the manifest (`contracts.tools`) — the guard against the 0.3.6 bootstrap bug.

## Config (plugin settings)

| key | default | meaning |
|---|---|---|
| `stackRoot` | `<workspace>/wp-stack` | the one folder this stack owns |
| `dbPort` | `3307` | stack-owned MariaDB port |
| `dbUser` | `wp_stack` | stack-owned mysql user (grants: `wps_%` only) |
| `portMin` / `portMax` | `8100` / `8199` | site port range |
| `servePortMin` / `servePortMax` | `8443` / `8499` | HTTPS ports `wp_stack_serve` may allocate |
| `bindHost` | `127.0.0.1` | site php bind address: `127.0.0.1`, `tailnet` (this Otto's Tailscale IPv4), or an IPv4; exposed sites always use the tailnet IP |
| `apiToken` | *(auto)* | bearer for `/otto-wp-stack/api`; auto-minted to `.api-token` |

## Security posture

- HTTP route is `auth:"plugin"`; the only credential is the 64-hex bearer
  token, compared timing-safe, never logged and never returned by reads.
- Site ids: `^[a-z0-9][a-z0-9-]{0,63}$`; actions/ports strictly whitelisted;
  serve targets are always derived from the registry (never caller-supplied)
  and serve ports must be integers inside `servePortMin..servePortMax`;
  `bindHost` is whitelisted (`127.0.0.1` / `tailnet` / IPv4) before it ever
  reaches the `php -S` argv.
- Process control is ownership-verified (exe realpath + port + docroot + uid);
  foreign processes on a stack port are refused, never killed.
- The mysql user cannot see any database outside its `wps_` prefix.
- Tailscale Serve: the plugin only adds/removes rules that proxy **its own**
  site ports; tailscaled itself still gates who may mutate serve config (see
  the operator-grant note above).

## Roadmap (v1.1)

- ZIP site import (`wp export` + media copy round-trip).
- Plugin updates via `openclaw plugins update`.

---

## Appendix (developers / offline — not part of deploy)

Nothing below is needed to run the product; it exists for development and
air-gapped boxes.

**Offline runtime install** — `bin/wp-stack-bootstrap.sh` performs exactly the
steps `wp_stack_bootstrap` does (idempotent, honors `WP_STACK_ROOT`, no sudo).
Pre-seed `runtime/` however you like.

**Local smoke test of the HTTP API:**

```bash
TOKEN=*** <plugin-folder>/.api-token)
curl -s localhost:18789/otto-wp-stack/health
curl -s -X POST localhost:18789/otto-wp-stack/api \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"op":"full","args":{}}'
```

**Dev commands:** `npm run typecheck && npm run build` before every commit
(`dist/` ships as-is); `node test/standalone-check.mjs` before release.
Publishing to ClawHub is the owner's action.

## Changelog

- **0.3.8** — Tailnet reachability without the operator grant.
  - **New:** `wp_stack_expose` / `wp_stack_unexpose` agent tools (plus HTTP
    `expose`/`unexpose` ops and dashboard **Expose/Unexpose** buttons) — binds
    a site's own php server to this Otto's Tailscale IPv4 and rewrites
    WordPress `siteurl`/`home` to `http://<magicdns>:<sitePort>`, so any
    tailnet device can open the site over plain HTTP. No tailscale mutation
    and no operator grant — the thing `wp_stack_serve` cannot do on ungranted
    Ottos. Exposed and served are mutually exclusive (each refuses the other,
    and serve refuses while `bindHost` is off loopback); unexpose restores the
    loopback bind and the local URL; a failed expose rolls back completely.
  - **New:** `bindHost` config for site php servers — `"127.0.0.1"` (default),
    `"tailnet"` (this Otto's Tailscale IPv4) or a literal IPv4; the address is
    whitelisted before it reaches the `php -S` argv, stale servers on the old
    bind are reaped by ownership on start, and `wp_stack_sites` now reports
    each site's bound address (`bindHost`/`url`).
- **0.3.7** — Zero-command deploy, end to end.
  - **Fix:** `wp_stack_bootstrap` added to `contracts.tools` — it was
    registered in the contract but gated out of the manifest, so no agent
    could install the runtime and the terminal bootstrap was the only path.
    A new guard fails the build whenever contract tool names and
    `contracts.tools` drift apart.
  - **New:** `wp_stack_serve` / `wp_stack_unserve` agent tools (plus HTTP
    `serve`/`unserve` ops and dashboard Serve/Unserve buttons) — Tailscale
    Serve exposure + WordPress URL rewrite in one whitelisted call; deletion
    via `--bg=false` (no `serve remove` in current tailscale), registry-backed
    port allocation, rollback on failure, cleanup on site delete. When
    tailscaled denies agent-user mutations the error carries the one-time
    `sudo tailscale set --operator=…` fix.
  - **New:** bundled zero-scripts **console app** template (`console-app/`) —
    chat-driven board with no token, no scripts, no network capability;
    string-or-object data parsing, visibility re-pull + 20 s poll. SETUP.md
    tells the agent to pick scripts-app vs console by the Otto app's
    `appScripts` capability (minAppVersion 2.4.0).
  - Serve port range is configurable (`servePortMin`/`servePortMax`).
- 0.3.6 — bound request-body memory. Earlier history in git.
