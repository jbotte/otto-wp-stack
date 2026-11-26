#!/usr/bin/env node
/**
 * template-syntax-check.mjs — fast transpile-parse gate for the shipped
 * board templates (app/index.tsx, console-app/index.tsx).
 *
 * The templates are NOT part of tsconfig (they're Otto-app React, not plugin
 * code), so `npm run typecheck` never sees them. This gate catches syntax
 * errors before release: each template is transpiled with the repo's
 * typescript compiler and any syntactic diagnostic fails the run.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(join(root, "package.json"));
const ts = require("typescript");

const TEMPLATES = ["app/index.tsx", "console-app/index.tsx"];

let failed = false;
for (const rel of TEMPLATES) {
  const src = readFileSync(join(root, rel), "utf8");
  const out = ts.transpileModule(src, {
    fileName: rel,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
  });
  const diags = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diags.length) {
    failed = true;
    console.log(`FAIL ${rel}`);
    for (const d of diags) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
      let pos = "";
      if (d.file && d.start != null) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        pos = `:${line + 1}:${character + 1}`;
      }
      console.log(`  ${rel}${pos} ${msg}`);
    }
  } else {
    console.log(`PASS ${rel} (transpile-parse, ${src.split("\n").length} lines)`);
  }
}

if (failed) {
  console.log("template-syntax-check: FAILED");
  process.exit(1);
}
console.log("template-syntax-check: OK");
