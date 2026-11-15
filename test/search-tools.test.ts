import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../src/config.js";
import {
  packagedSearchTools,
  runtimeTarget,
  runtimeTargets,
  searchToolPath,
  verifySearchTools,
} from "../src/search-tools.js";
import { tmpdir } from "./temp.js";
import { isolated } from "./local-fixtures.js";
import { nativeSearchProbe } from "./native-search.js";

function packageFixture() {
  const root = mkdtempSync(join(tmpdir(), "jared-packaged-tools-"));
  const target = runtimeTarget();
  const bin = join(root, "vendor/tools", target);
  mkdirSync(bin, { recursive: true });
  copyFileSync(
    join(repositoryRoot(), "vendor/tools/manifest.json"),
    join(root, "vendor/tools/manifest.json"),
  );
  const originals = packagedSearchTools();
  for (const tool of ["fd", "rg"] as const)
    copyFileSync(originals[tool], join(bin, tool));
  return { root, bin, target, originals };
}

test("packaged tools cover both Mac architectures and Linux; unsupported targets fail closed", () => {
  for (const target of runtimeTargets) {
    const [platform, arch] = target.split("-");
    assert.equal(runtimeTarget(platform, arch), target);
    const tools = packagedSearchTools(repositoryRoot(), target);
    assert(tools.fd.endsWith(`${target}/fd`));
    assert(tools.rg.endsWith(`${target}/rg`));
  }
  assert.throws(
    () => runtimeTarget("win32", "x64"),
    /unsupported_runtime_target/,
  );
  assert.throws(
    () => runtimeTarget("darwin", "arm"),
    /unsupported_runtime_target/,
  );
  assert(verifySearchTools());
});

test("fresh HOME with no global tools: actual Pi find and grep use installed binaries without downloads", () => {
  const f = isolated();
  const before = readdirSync(f.env.PI_CODING_AGENT_DIR);
  nativeSearchProbe(f.root);
  assert.deepEqual(readdirSync(f.env.PI_CODING_AGENT_DIR), before);
  assert(!readdirSync(join(f.root, "pi")).includes("bin"));
  assert(
    searchToolPath().startsWith(
      join(repositoryRoot(), "vendor/tools", runtimeTarget()),
    ),
  );
});

test("packaged resolver ignores PATH, Pi caches and legacy state; it never writes a new cache", () => {
  const f = isolated();
  const old = { ...process.env };
  const bin = join(f.root, "legacy/search-tools/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "fd"), "broken legacy helper\n");
  const before = readFileSync(join(bin, "fd"), "utf8");
  try {
    Object.assign(process.env, f.env, { PATH: bin });
    assert.equal(
      packagedSearchTools().bin,
      join(repositoryRoot(), "vendor/tools", runtimeTarget()),
    );
    assert(verifySearchTools());
    assert.equal(readFileSync(join(bin, "fd"), "utf8"), before);
    assert.deepEqual(readdirSync(f.env.PI_CODING_AGENT_DIR).sort(), [
      "auth.json",
      "settings.json",
    ]);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

test("missing, modified, writable, hardlinked and symlinked packaged tools are refused", () => {
  const f = packageFixture();
  const path = join(f.bin, "fd");
  unlinkSync(path);
  assert.throws(() => packagedSearchTools(f.root));
  writeFileSync(path, "modified", { mode: 0o755 });
  assert.throws(() => packagedSearchTools(f.root), /checksum_mismatch/);
  copyFileSync(f.originals.fd, path);
  chmodSync(path, 0o777);
  assert.throws(
    () => packagedSearchTools(f.root),
    /unsafe_packaged_search_tool/,
  );
  unlinkSync(path);
  copyFileSync(f.originals.fd, path);
  const alias = join(f.bin, "fd-alias");
  linkSync(path, alias);
  try {
    assert.throws(
      () => packagedSearchTools(f.root),
      /unsafe_packaged_search_tool/,
    );
  } finally {
    unlinkSync(alias);
    unlinkSync(path);
  }
  symlinkSync(f.originals.fd, path);
  assert.throws(() => packagedSearchTools(f.root), /symlink_forbidden/);
});

test("manifest cannot redirect an executable outside the package target", () => {
  const f = packageFixture();
  const file = join(f.root, "vendor/tools/manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.targets[f.target].fd.file = "../../outside";
  writeFileSync(file, JSON.stringify(manifest));
  assert.throws(
    () => packagedSearchTools(f.root),
    /invalid_packaged_tool_path/,
  );
});
