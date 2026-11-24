// Syntax gate for the shipped .tsx app templates (they are not in the tsconfig).
import { readFileSync } from "node:fs";
import ts from "typescript";
let bad = 0;
for (const f of ["app/index.tsx", "console-app/index.tsx"]) {
  const r = ts.transpileModule(readFileSync(f, "utf8"), {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: f,
  });
  for (const d of r.diagnostics ?? []) {
    bad++;
    console.error(`SYNTAX ${f}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")} @ ${d.start}`);
  }
}
if (!bad) console.log("PASS  templates: app/index.tsx + console-app/index.tsx parse clean");
process.exit(bad ? 1 : 0);
