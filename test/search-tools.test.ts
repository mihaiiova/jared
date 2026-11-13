import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isolated } from "./local-fixtures.js";
import {
  prepareSearchTools,
  runSearchPreparation,
  searchHelperEnv,
  searchToolPath,
} from "../src/search-tools.js";

async function withFixture(
  fn: (f: ReturnType<typeof isolated>, state: string) => Promise<void>,
) {
  const f = isolated();
  const saved = { ...process.env };
  Object.assign(process.env, f.env, { PATH: "/usr/bin:/bin" });
  const state = join(f.root, "managed");
  mkdirSync(state, { mode: 0o700 });
  try {
    await fn(f, state);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("Pi-cached fd without system fd: binary-only cache, native find AND grep, idempotent shared worker paths; no downloads/auth/config imports", async () => {
  await withFixture(async (f, state) => {
    const global = f.env.PI_CODING_AGENT_DIR;
    // Typical personal Pi cache: group-writable bin under an owned private
    // root. Other users cannot traverse that root; no chmod/apt is needed.
    chmodSync(join(global, "bin"), 0o775);
    const before = readFileSync(join(global, "auth.json"), "utf8");
    const prepare = (fixture: string, bin: string, download: boolean) => {
      assert.equal(download, false);
      runSearchPreparation(fixture, bin, false); // PI_OFFLINE explicitly prevents any download.
    };
    assert.equal(
      await prepareSearchTools(
        state,
        async () => assert.fail("unexpected download consent"),
        { prepare },
      ),
      true,
    );
    const path = searchToolPath(state);
    assert.equal(path, `${state}/search-tools/bin:/usr/bin:/bin`);
    const fd = join(state, "search-tools/bin/fd");
    assert.deepEqual(readFileSync(fd), readFileSync(join(global, "bin/fd")));
    const inode = statSync(fd).ino,
      mtime = statSync(fd).mtimeMs;
    // Removing the original cache proves subsequent setup/roles do not depend on it.
    unlinkSync(join(global, "bin/fd"));
    assert.equal(
      await prepareSearchTools(state, async () => assert.fail(), { prepare }),
      true,
    );
    assert.equal(statSync(fd).ino, inode);
    assert.equal(statSync(fd).mtimeMs, mtime);
    assert.equal(readFileSync(join(global, "auth.json"), "utf8"), before);
    assert.deepEqual(readdirSync(join(state, "search-tools")).sort(), ["bin"]);
  });
});

test("fresh-machine native provisioning requires bounded explicit consent; mocked native output only, sanitized helper env", async () => {
  await withFixture(async (f, state) => {
    let preparations = 0;
    const hooks = {
      discover: () => undefined,
      prepare: (fixture: string, bin: string, download: boolean) => {
        preparations++;
        assert(download);
        const env = searchHelperEnv(
          join(fixture, "home"),
          join(fixture, "pi"),
          bin,
          download,
        );
        assert.deepEqual(Object.keys(env).sort(), [
          "HOME",
          "LANG",
          "PATH",
          "PI_CODING_AGENT_DIR",
        ]);
        assert.equal(env.PATH, `${bin}:/usr/bin:/bin`);
        assert.equal(env.PI_OFFLINE, undefined);
        assert.equal(env.NODE_OPTIONS, undefined);
        mkdirSync(join(fixture, "pi/bin"), { recursive: true, mode: 0o700 });
        for (const tool of ["fd", "rg"])
          copyFileSync(
            join(f.env.PI_CODING_AGENT_DIR, "bin", tool),
            join(fixture, "pi/bin", tool),
          );
      },
    };
    assert.equal(
      await prepareSearchTools(state, async () => false, hooks),
      false,
    );
    assert.equal(preparations, 0);
    assert.throws(() => searchToolPath(state));
    assert.equal(
      await prepareSearchTools(
        state,
        async (message) => {
          assert.match(
            message,
            /180 seconds.*no login\/model\/registration permission/,
          );
          return true;
        },
        hooks,
      ),
      true,
    );
    assert.equal(preparations, 1);
    assert(searchToolPath(state));
    assert.deepEqual(readdirSync(join(state, "search-tools")), ["bin"]);
  });
});

test("failed native verification rolls back only newly cached tools so rerunning setup recovers", async () => {
  await withFixture(async (f, state) => {
    const bin = join(state, "search-tools/bin");
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    const rg = join(bin, "rg");
    copyFileSync(join(f.env.PI_CODING_AGENT_DIR, "bin/rg"), rg);
    const original = statSync(rg);
    const broken = join(f.root, "broken-fd");
    writeFileSync(broken, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await assert.rejects(
      prepareSearchTools(
        state,
        async () => assert.fail("no download consent needed"),
        {
          discover: () => broken,
        },
      ),
      /native_search_preparation_failed_rerun_setup/,
    );
    assert(!existsSync(join(bin, "fd")));
    assert.equal(statSync(rg).ino, original.ino);
    assert.equal(statSync(rg).mtimeMs, original.mtimeMs);
    assert.deepEqual(readdirSync(join(state, "search-tools")), ["bin"]);
    assert.equal(
      await prepareSearchTools(state, async () => assert.fail("no downloads")),
      true,
    );
    assert(searchToolPath(state));
  });
});

test("cache refuses unsafe executables, checkout sources, symlinks/escape and never replaces an invalid existing entry", async () => {
  await withFixture(async (f, state) => {
    const unsafe = join(f.root, "unsafe");
    writeFileSync(unsafe, "unsafe", { mode: 0o777 });
    chmodSync(unsafe, 0o777);
    await assert.rejects(
      prepareSearchTools(state, async () => assert.fail(), {
        discover: () => unsafe,
      }),
      /unsafe_search_tool/,
    );
    const repo = join(f.root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const binary = join(repo, "fd");
    copyFileSync(join(f.env.PI_CODING_AGENT_DIR, "bin/fd"), binary);
    await assert.rejects(
      prepareSearchTools(state, async () => assert.fail(), {
        discover: () => binary,
      }),
      /credential_inside_checkout/,
    );
    const escaped = join(f.root, "escaped");
    writeFileSync(escaped, "keep", { mode: 0o700 });
    const target = join(state, "search-tools/bin/fd");
    symlinkSync(escaped, target);
    await assert.rejects(prepareSearchTools(state, async () => false));
    assert.equal(readFileSync(escaped, "utf8"), "keep");
    assert(existsSync(target));
    assert.throws(() => searchToolPath(state));
  });
});
