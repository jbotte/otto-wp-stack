# SETUP — what an agent does on a fresh Otto (zero terminal commands)

Every step below is chat/app driven. If a step seems to need a terminal
command, that is a bug in this plugin — fix the plugin, don't document around
it. The only things the owner ever touch are **approval cards** and (once, if
tailscale serve is wanted) a single operator grant on the host.

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
3. **Bind the board to its artifact id** (0.3.9): after publishing, write
   `<workspace>/apps/wp-stack-console/config.json` containing
   `{ "artifactId": "<the id publish returned>" }` and publish again with the
   same id so the file ships. The template reads it and names that exact
   artifact in every ask's push instruction, so a refresh can never land on a
   different board.
4. **Keep it fresh — exactly one monitor:** create ONE recurring automation
   titled `Keep WP Stack Console board fresh` (every 15 minutes, notify only
   on change) whose instructions are deterministic:
   1. call the `wp_stack_status` tool;
   2. push the result with `otto_set_artifact_data` as
      `{status, sites, ts, notice: null, details: null, pending: null}` into
      artifact `<that exact artifactId>`.
   Before creating it, cancel any other automation with this title (stale
   cadences or an old artifact id cause the "tile never updates" confusion —
   the tile shows the last PUSH, and the ↻ button is a chat round-trip, so
   exactly one deterministic pusher is what keeps it honest).
5. Don't leave both templates published; one board per Otto is the deal.

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

**No-grant alternative (zero terminal):** `wp_stack_expose(siteId)` skips
tailscale mutation entirely — the site's own `php -S` rebinds to the LIVE
tailscale IPv4 (never `0.0.0.0`) and WordPress `siteurl`/`home` follow to
`http://<magicdns>:<site port>`, plain HTTP, tailnet-only. `wp_stack_unexpose`
restores the loopback bind + local URLs. A site is either served (HTTPS, needs
the grant) or exposed (HTTP, needs nothing) — the tools guard against both.

## 5. Daily use

All through the board or chat: create sites (`wp_stack_create` — one-time admin
password is shown once, in chat), start/stop/restart (`wp_stack_site_action`),
details, delete (typed-id confirm), db start/stop (`wp_stack_db`). Phone Otto
apps cannot resolve tailnet names — open served URLs from a tailnet device.
