// esbuild config for the VSCode extension.
//
// VSCode loads extensions as CommonJS on its Node runtime, with the `vscode`
// module provided by the host. We:
//   - bundle everything (including @token-count/core) into one file,
//   - externalize `vscode` so esbuild doesn't try to resolve it,
//   - emit CJS so it matches VSCode's current module loader.
//
// Run with `node esbuild.config.mjs` (build) or `node esbuild.config.mjs --watch`.

import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  // `vscode` is provided by the VSCode runtime — it must NOT be bundled.
  external: ["vscode"],
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("esbuild watching...");
} else {
  await esbuild.build(options);
}
