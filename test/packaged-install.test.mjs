import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

test(
  "the packed MCP server installs from its tarball and its shipped binary starts",
  { timeout: 90_000 },
  async (t) => {
  const owned = await mkdtemp(path.join(tmpdir(), "dreamlayer-mcp-package-test-"));
  t.after(() => rm(owned, { recursive: true, force: true }));

  const packed = run("npm", ["pack", "--json", "--pack-destination", owned], ROOT);
  assert.equal(packed.status, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout)[0];
  assert.equal(metadata.name, "@dreamlayer/mcp");
  assert.equal(metadata.version, "0.3.0");
  assert.ok(metadata.integrity.startsWith("sha512-"));
  assert.deepEqual(
    metadata.files.map(({ path: file }) => file).sort(),
    [
      "LICENSE",
      "NOTICE",
      "README.md",
      "dist/client.d.ts",
      "dist/client.js",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/tools.d.ts",
      "dist/tools.js",
      "package.json",
    ],
  );

  const [tarballName] = (await readdir(owned)).filter((name) => name.endsWith(".tgz"));
  assert.ok(tarballName, "npm pack did not create a tarball");
  const installRoot = path.join(owned, "installed");
  await mkdir(installRoot);
  const installed = run(
    "pnpm",
    ["add", "--prefer-offline", "--ignore-scripts", path.join(owned, tarballName)],
    installRoot,
  );
  assert.equal(installed.status, 0, installed.stderr);

  const packageJson = JSON.parse(
    await readFile(
      path.join(installRoot, "node_modules", "@dreamlayer", "mcp", "package.json"),
      "utf8",
    ),
  );
  assert.equal(packageJson.version, "0.3.0");
  assert.equal(packageJson.bin["dreamlayer-mcp"], "dist/index.js");

  const env = { ...process.env, DREAMLAYER_API_KEY: "" };
  const launched = run(
    path.join(installRoot, "node_modules", ".bin", "dreamlayer-mcp"),
    [],
    installRoot,
    env,
  );
  assert.equal(launched.status, 1);
  assert.equal(launched.stdout, "", "stdout is reserved for JSON-RPC");
  assert.match(launched.stderr, /DREAMLAYER_API_KEY is not set/);
  assert.match(launched.stderr, /server's own env block/);
  assert.doesNotMatch(launched.stderr, /dlr_live_[A-Za-z0-9_-]+/);
  },
);
