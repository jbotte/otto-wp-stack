import { existsSync } from "node:fs";
import { resolveConfig } from "../dist/engine.js";

const c = resolveConfig({});
console.log("stackRoot:", c.stackRoot);
console.log("php exists:", existsSync(c.phpBin));
console.log("db my.cnf exists:", existsSync(`${c.dbDir}/my.cnf`));
