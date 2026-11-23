// Contract guard: mirrors openclaw's feature-contract validation
// (dist/plugin-sdk/feature-contract.js): operation ids must match
// /^[a-z][a-z0-9._-]{0,127}$/u or activation throws.
import { readFileSync } from "node:fs";
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
const app = readFileSync(path.join(here, "..", "..", "apps", "wp-stack-next", "index.tsx"), "utf8");
const emitted = [...app.matchAll(/return \["([a-z0-9-]+)"/g)].map((m) => m[1]);
const unknown = emitted.filter((o) => !keys.includes(o));
if (unknown.length) {
  console.error(`FAIL  app: emits unknown ops: ${unknown.join(", ")}`);
  process.exit(1);
}

console.log(`PASS  contract: ${keys.length} operation ids valid; app emits only known ops`);
