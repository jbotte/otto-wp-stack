// Contract guard: mirrors openclaw's feature-contract validation
// (dist/plugin-sdk/feature-contract.js): operation ids must match
// /^[a-z][a-z0-9._-]{0,127}$/u or activation throws.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "..", "src", "index.ts"), "utf8");

const contractBlock = src.slice(src.indexOf("const contract"), src.indexOf("const MUTATIONS"));
const keys = [...contractBlock.matchAll(/^\s{4}"?([a-zA-Z0-9._-]+)"?: \{/gm)].map((m) => m[1]);
if (keys.length === 0) {
  console.error("FAIL  contract: no operation keys parsed — guard is broken");
  process.exit(1);
}
const bad = keys.filter((k) => !/^[a-z][a-z0-9._-]{0,127}$/u.test(k));
if (bad.length) {
  console.error(`FAIL  contract: invalid operation ids: ${bad.join(", ")}`);
  process.exit(1);
}

// Every declared operation must have a handler, or activation fails with
// "Feature operation <id> is missing its handler".
const handlerBlock = src.slice(src.indexOf("const h = {"), src.indexOf("return h as"));
const handlerKeys = [...handlerBlock.matchAll(/^\s{8}"?([a-z0-9._-]+)"?: async/gm)].map((m) => m[1]);
const missing = keys.filter((k) => !handlerKeys.includes(k));
if (missing.length) {
  console.error(`FAIL  contract: operations missing handlers: ${missing.join(", ")}`);
  process.exit(1);
}

// App translate() must only emit ids that exist in the contract.
// Prefer the shipped in-repo template; fall back to the workspace sibling copy.
const appCandidates = [
  path.join(here, "..", "app", "index.tsx"),
  path.join(here, "..", "..", "apps", "wp-stack-next", "index.tsx"),
];
const appPath = appCandidates.find((p) => existsSync(p));
if (!appPath) {
  console.error("FAIL  app: no dashboard app found (app/index.tsx or ../../apps/wp-stack-next/index.tsx)");
  process.exit(1);
}
const app = readFileSync(appPath, "utf8");
const emitted = [...app.matchAll(/return \["([a-z0-9-]+)"/g)].map((m) => m[1]);
const unknown = emitted.filter((o) => !keys.includes(o));
if (unknown.length) {
  console.error(`FAIL  app: emits unknown ops: ${unknown.join(", ")}`);
  process.exit(1);
}

// Every tool the contract declares (tool: { name: ... }) MUST be listed in
// openclaw.plugin.json contracts.tools — the manifest gates which registered
// tools agents actually receive (0.3.6 shipped wp_stack_bootstrap missing, so
// no agent could install the runtime). Same in reverse: no phantom entries.
const manifest = JSON.parse(readFileSync(path.join(here, "..", "openclaw.plugin.json"), "utf8"));
const contractTools = [...contractBlock.matchAll(/tool:\s*\{\s*name:\s*"([a-z0-9_]+)"\s*\}/g)].map((m) => m[1]);
if (contractTools.length === 0) {
  console.error("FAIL  manifest: no tool names parsed from the contract — guard is broken");
  process.exit(1);
}
const listedTools = Array.isArray(manifest?.contracts?.tools) ? manifest.contracts.tools : [];
const missingTools = contractTools.filter((t) => !listedTools.includes(t));
const staleTools = listedTools.filter((t) => !contractTools.includes(t));
if (missingTools.length || staleTools.length) {
  console.error(
    `FAIL  manifest: contracts.tools out of sync — missing: ${missingTools.join(", ") || "-"}; stale: ${staleTools.join(", ") || "-"}`,
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
const ver = src.match(/const PLUGIN_VERSION = "([^"]+)"/)?.[1];
if (ver !== pkg.version) {
  console.error(`FAIL  version: PLUGIN_VERSION ${ver} != package.json ${pkg.version}`);
  process.exit(1);
}

console.log(`PASS  contract: ${keys.length} operation ids valid; app emits only known ops; ${contractTools.length} tools in sync with the manifest`);
