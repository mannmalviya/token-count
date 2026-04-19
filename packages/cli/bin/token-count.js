#!/usr/bin/env node
// Thin shebang wrapper that delegates to the compiled entrypoint.
// Keeping this file tiny and ESM-pure means the `bin` field in package.json
// resolves correctly on every platform (Linux, macOS) that pnpm links it on.
import "../dist/index.js";
