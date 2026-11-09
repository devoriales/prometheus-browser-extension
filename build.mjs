// Bundles the extension into dist/ (load dist/ as an unpacked extension).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

const options = {
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.ts",
    options: "src/options/index.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome116",
  sourcemap: watch ? "inline" : false,
  minify: false,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
