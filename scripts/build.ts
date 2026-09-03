import { rmSync } from "node:fs";
import { $ } from "bun";

console.log("[regoof] Building...");
rmSync("dist", { force: true, recursive: true });
await $`bunx tsc -p tsconfig.build.json`;
console.log("[regoof] Build complete.");
