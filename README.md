# otto-wp-stack

**Standalone headless WordPress stack for Otto.** One OpenClaw plugin + one Otto
dashboard app. No sudo, no systemd, no apt, and no dependency on any other
WordPress stack — everything lives in one folder and runs as the Otto agent
user. Deploy it to a fresh Otto by copying two folders and running one script.

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
                                                          └──────────────────────────────────────────────┘
```

## What "standalone" means (testable claims)

- The plugin reads/writes **only** its `stackRoot` folder (default
  `<agent workspace>/wp-stack`, or `~/otto-wp-stack` elsewhere), plus read-only
  `tailscale serve status` for the rules view.
- Its database is **its own MariaDB bintar** with **its own datadir** on port
  **3307**, reached as a stack-scoped mysql user whose grants are limited to
  `wps_%` databases. It never touches any other MySQL/MariaDB on the box.
- Site servers are **its own child processes** (`runtime/php -S` on ports
  8100–8199). It only ever signals processes verified as its own
  (exe path + port + docroot + uid all match).
- No systemd units, no root helpers, no other panels or worker scripts.
  `test/standalone-check.mjs` fails the build if any plugin/app file so much
  as names another stack's paths, ports, units or panels.

## Layout

```
otto-wp-stack-plugin/          ← this folder (copy to any Otto)
  openclaw.plugin.json
  dist/                        ← compiled; ship as-is, or `npm run build`
  src/                         ← TypeScript source
  bin/wp-stack-bootstrap.sh    ← one-time runtime install (no sudo)
  test/standalone-check.mjs    ← isolation + live e2e test
apps/wp-stack-next/            ← the Otto dashboard app (artifact)
  index.tsx
  scripts/stack.mjs            ← the app's only path to the backend
  config.json                  ← { apiBase, token } (token set from Settings)
```

## Deploy to a fresh Otto

**Quickest path (published on ClawHub):** just tell the new Otto:

> *"Install @lunarlyra/otto-wp-stack from ClawHub, enable it, and set up the WP Stack dashboard."*

Otto installs the plugin (`openclaw plugins install clawhub:@lunarlyra/otto-wp-stack`),
you tap the approval card, then open the **WP Stack (Standalone)** dashboard and
press **Install runtime** — the plugin downloads and configures its own PHP,
WP-CLI and MariaDB. No terminal, no sudo.

<details>
<summary>Manual path (copy-from-scratch, or offline)</summary>

The **plugin installs its own runtime** — the only terminal step is installing
the plugin itself. Run these as the **Otto agent user** (the default Otto
terminal). Nothing here needs sudo.

1. **Copy the two folders** to the Otto's agent workspace, keeping their
   names:
   ```
   <workspace>/otto-wp-stack-plugin/
   <workspace>/apps/wp-stack-next/
   ```
2. **Install the plugin** (from the plugin folder):
   ```bash
   cd <workspace>/otto-wp-stack-plugin
   npm install --omit=dev
   openclaw plugins install --link <workspace>/otto-wp-stack-plugin
   ```
   Approve the capability review when prompted, then enable the plugin and
   restart the Gateway (Otto app → device → plugins, or ask Otto's operator).
3. **Install the runtime — from the app**: open **WP Stack (Standalone)** and
   press **Install runtime**. The plugin downloads its own static PHP (with
   mysqli), WP-CLI and MariaDB bintar (~360 MB, a few minutes), initializes
   its own datadir, starts its own server on the stack port, and creates the
   prefix-scoped mysql user — watching live progress in the banner.
   Same thing by chat: ask Otto *“install the wp-stack runtime”* (agent tool
   `wp_stack_bootstrap`).
   *(Offline/air-gapped boxes: `bin/wp-stack-bootstrap.sh` does the identical
   steps from a terminal; pre-seed `runtime/` however you like — every step
   is idempotent.)*
4. **Publish the dashboard app**: ask Otto (on that box):
   > Show me the app at apps/wp-stack-next
   and approve the app's script/network capability once.
5. **Connect them**: read the token and paste it into the app's Settings tab:
   ```bash
   cat <plugin-folder>/.api-token
   ```
   (Or ask Otto to run the plugin's `revealToken` action.) The Settings tab's
   “Run connection probe” should show `browser→route: ok` (or `blocked` —
   that's fine, the dashboard works through the script path) and
   `app→plugin: ok (db up)`.

One-shot alternative: after step 2, say to Otto —
> Set up wp-stack: install the runtime with wp_stack_bootstrap, then paste the
> plugin's .api-token into apps/wp-stack-next/config.json

and Otto does the rest.

</details>

## Daily use (the app)

- **Sites** — Start/Stop/Restart/Details/Delete (type the id to confirm),
  Open / WP Admin links.
- **New site** — creates its own `wps_*` database and its own PHP server and
  starts it; the one-time admin password is shown **once**.
- **System** — runtime versions, the stack's own database (Start db / Stop db),
  and a read-only view of Tailscale Serve rules (rules marked *ours*). Making
  a site reachable over HTTPS is one owner-side command, e.g.:
  ```bash
  tailscale serve --bg --https 8446 http://127.0.0.1:8100
  ```
- **Settings** — API token + connection probe. Rotate with the plugin's
  `rotateToken` action (then re-paste).

## Manual smoke test (curl)

```bash
TOKEN=$(cat <plugin-folder>/.api-token)
curl -s localhost:18789/otto-wp-stack/health
curl -s -X POST localhost:18789/otto-wp-stack/api \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"op":"full","args":{}}'
```

## Self-test

```bash
node test/standalone-check.mjs
```

Checks isolation (no other-stack references anywhere in plugin/app code),
then runs a live e2e: starts its own database, creates a real WordPress site
through its own runtime, exercises start/stop/details/guards, deletes it, and
confirms the check leaves nothing behind. Also verifies the self-bootstrap op
is idempotent (every download/init step skips what's already in place, so a
fresh-Otto install can be resumed after a crash or restart).

## Config (plugin settings)

| key | default | meaning |
|---|---|---|
| `stackRoot` | `<workspace>/wp-stack` | the one folder this stack owns |
| `dbPort` | `3307` | stack-owned MariaDB port |
| `dbUser` | `wp_stack` | stack-owned mysql user (grants: `wps_%` only) |
| `portMin` / `portMax` | `8100` / `8199` | site port range |
| `apiToken` | *(auto)* | bearer for `/otto-wp-stack/api`; auto-minted to `.api-token` |

## Security posture

- HTTP route is `auth:"plugin"`; the only credential is the 64-hex bearer
  token, compared timing-safe, never logged and never returned by reads.
- Site ids: `^[a-z0-9][a-z0-9-]{0,63}$`; actions/ports strictly whitelisted.
- Process control is ownership-verified (exe realpath + port + docroot + uid);
  foreign processes on a stack port are refused, never killed.
- The mysql user cannot see any database outside its `wps_` prefix.
- HTTPS Serve rules are read-only from the app; mutations stay owner-side.

## Roadmap (v1.1)

- ZIP site import (`wp export` + media copy round-trip).
- Per-site HTTPS button (wrapping owner-approved `tailscale serve`).
- Plugin updates via `openclaw plugins update`.
