// Tests for path resolution.
//
// The contract: by default, all data lives under `~/.token-count/`.
// The env var `TOKEN_COUNT_DIR` overrides this — used by tests (so we don't
// touch the real home dir) and the VSCode extension (which may run under a
// different HOME).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { tokenCountDir, usageJsonlPath, stateJsonPath } from "../../src/paths.js";

describe("paths", () => {
  // Save + restore env so tests don't leak state between each other.
  const originalEnv = process.env.TOKEN_COUNT_DIR;
  beforeEach(() => {
    delete process.env.TOKEN_COUNT_DIR;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TOKEN_COUNT_DIR;
    } else {
      process.env.TOKEN_COUNT_DIR = originalEnv;
    }
  });

  it("defaults to ~/.token-count when TOKEN_COUNT_DIR is not set", () => {
    expect(tokenCountDir()).toBe(path.join(os.homedir(), ".token-count"));
  });

  it("honors the TOKEN_COUNT_DIR env override", () => {
    process.env.TOKEN_COUNT_DIR = "/tmp/fake-token-count";
    expect(tokenCountDir()).toBe("/tmp/fake-token-count");
  });

  it("builds usage.jsonl under the resolved dir", () => {
    process.env.TOKEN_COUNT_DIR = "/tmp/tc";
    expect(usageJsonlPath()).toBe("/tmp/tc/usage.jsonl");
  });

  it("builds state.json under the resolved dir", () => {
    process.env.TOKEN_COUNT_DIR = "/tmp/tc";
    expect(stateJsonPath()).toBe("/tmp/tc/state.json");
  });
});
