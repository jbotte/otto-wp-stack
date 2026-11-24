# SETUP — what an agent does on a fresh Otto (zero terminal commands)

Every step below is chat/app driven. If a step seems to need a terminal
command, that is a bug in this plugin — fix the plugin, don't document around
it. The only things the owner ever touch are **approval cards** and (once, if
HTTPS via tailscale serve is wanted) a single operator grant on the host —
plain-HTTP tailnet exposure (section 5) needs neither.

## 1. Install + enable

Owner says: *"Install @lunarlyra/otto-wp-stack from ClawHub and enable it."*
The install card and the capability review card are tapped by the owner. On
enable the plugin immediately mints its `.api-token` file in the plugin folder
(mode 0600, never returned by read ops) — no copy-pasting, ever.

## 2. Runtime

Owner says: *"Install the wp-stack runtime."* → agent calls `wp_stack_bootstrap`.
First run downloads ~360 MB (static PHP with mysqli, WP-CLI, MariaDB bintar)
and takes several minutes; it returns immediately — poll `wp_stack_status`
(runtime.progress) until `phase: "ready"`. Idempotent: safe to re-run after a
crash or restart. The dashboard apps show an **Install runtime** button that
sends the same request.

## 3. Dashboard — pick the right app for the owner's Otto app version

The package ships TWO publishable dashboard templates:

| template | folder | needs |
|---|---|---|
| **scripts app** (live, direct) | `app/` | the Otto app must be able to approve app **scripts** |
| **console app** (chat-driven) | `console-app/` | nothing — works on every Otto app |

The gateway only offers the `appScripts` capability (capabilityOffered) when
the Otto app is **>= 2.4.0** (`minAppVersion` gate in main.js). On older apps
the scripts approval card can never be shown, so the gateway **drops
`scripts/` at publish** and the scripts app cannot reach the backend.

Decision:
1. If the Otto app version is known to be >= 2.4.0 → copy `<plugin-install>/app/`
   to `<workspace>/apps/wp-stack-next/`, publish, approve scripts+network
   capability once, then press **Auto-connect** (the agent reads `.api-token`,
   writes the app's `config.json`, verifies the probe).
2. Otherwise (or when unknown, or when the scripts capability card never
   appeared / `scripts/` was dropped at publish) → copy
   `<plugin-install>/console-app/` to `<workspace>/apps/wp-stack-console/`
   and publish. The console needs no token, no scripts and no network
   capability: it renders `otto.data` and its buttons `otto.ask` sentences to
   Otto. First push: tap **↻** (or ask *"refresh the WP Stack Console board"*);
   the agent calls `wp_stack_status` and pushes `{status, sites, ts, …}` via
   `otto_set_artifact_data`.
3. Don't leave both published; one board per Otto is the deal.

If a published scripts app mysteriously can't run its script (probe shows the
script path failing while browser→route works), that's the <2.4.0 case — switch
to the console template.

## 4. Expose a site over HTTPS (Tailscale Serve)

Owner says: *"Serve the demo site."* → agent calls `wp_stack_serve(siteId)`
(dashboard **Serve** button sends the same). The tool:

1. picks a free HTTPS port inside `servePortMin..servePortMax` (8443–8499),
2. runs `tailscale serve --bg --https=<port> http://127.0.0.1:<sitePort>`,
3. updates WordPress `siteurl`/`home` to `https://<magicdns>:<port>`,
4. records `servePort`/`serveUrl` in the site registry.

`wp_stack_unserve(siteId)` reverses it (rule removed with
`tailscale serve --bg=false <target>` — there is no `serve remove` subcommand
in current tailscale) and restores `http://127.0.0.1:<port>`. Deleting a
served site also removes its rule best-effort.

**Known denial:** tailscaled lets only the operator mutate serve config. On
Otto the agent user usually is not it, so the first serve answers
`Access denied: serve config denied`. The tool then returns the exact
one-time fix for the device operator:

> `sudo tailscale set --operator=<agent user>`   (once, on the Otto host)

After that grant, serve/unserve work from chat for good. Until then the error
also prints the owner-side single command equivalent.

## 5. Expose a site on the tailnet (no operator grant)

Owner says: *"Expose the demo site on the tailnet."* → agent calls
`wp_stack_expose(siteId)` (dashboard **Expose** button sends the same). The
tool resolves this Otto's Tailscale IPv4 + MagicDNS name, re-binds the site's
own `php -S` from loopback to the Tailscale IP (the stale loopback server is
reaped by ownership first) and updates WordPress `siteurl`/`home` to
`http://<magicdns>:<sitePort>`; the registry records `exposed`/`exposeUrl`.
Any tailnet device (e.g. the owner's Mac) opens the site there over plain
HTTP. **No tailscale mutation happens**, so unlike serve this needs no
operator grant — it is the path to use on Ottos where tailscaled denies
serve config changes. Requirements: tailscale up, and the site not currently
served (`wp_stack_unserve` first). A failed expose rolls the site back to
loopback + local URLs completely.

`wp_stack_unexpose(siteId)` reverses it: local `siteurl`/`home` restored, the
server re-bound to the `bindHost` config (`127.0.0.1` by default, `tailnet`,
or an IPv4 — whitelisted). `wp_stack_serve` refuses while a site is exposed
or `bindHost` is off loopback; expose refuses while served.

## 6. Daily use

All through the board or chat: create sites (`wp_stack_create` — one-time admin
password is shown once, in chat), start/stop/restart (`wp_stack_site_action`),
details, delete (typed-id confirm), db start/stop (`wp_stack_db`). Phone Otto
apps cannot resolve tailnet names — open served URLs from a tailnet device.
