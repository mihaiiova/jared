import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  cpSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isolated, project, client, call } from "./local-fixtures.js";
import { waitFor } from "./helpers.js";
import { ownerLock } from "../src/safety.js";
import { runtimeTarget } from "../src/search-tools.js";
import { nativeSearchProbe } from "./native-search.js";
const main = resolve("dist/src/main.js");

test("offline setup is private/idempotent, missing-auth doctor is actionable and read-only; explicit API-key alternative keeps choices", () => {
  const f = isolated();
  const run = (args: string[]) =>
    spawnSync(process.execPath, [main, ...args], {
      cwd: "/",
      env: f.env,
      encoding: "utf8",
    });
  const config = join(f.env.XDG_CONFIG_HOME, "jared-local/config.json");
  assert.equal(run(["doctor"]).status, 1);
  assert(!existsSync(config));
  assert(!existsSync(f.env.XDG_STATE_HOME));
  assert.equal(run(["--help"]).status, 0);
  const setup = run(["setup", "--no-login", "--no-register"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Audits BLOCKED/);
  const content = readFileSync(config, "utf8"),
    mtime = statSync(config).mtimeMs;
  assert.match(content, /gpt-6.1-sol/);
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.equal(
    statSync(join(f.env.XDG_CONFIG_HOME, "jared-local")).mode & 0o777,
    0o700,
  );
  const auth = join(f.env.XDG_CONFIG_HOME, "jared-local/codex-auth");
  assert.deepEqual(readdirSync(auth), []);
  assert.equal(run(["setup", "--no-login", "--no-register"]).status, 0);
  assert.equal(statSync(config).mtimeMs, mtime);
  assert.equal(readFileSync(config, "utf8"), content);
  const before = readdirSync(join(f.env.XDG_STATE_HOME, "jared-local"));
  const doctor = run(["doctor"]);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /Audits blocked/);
  assert.match(doctor.stdout, /connection NOT checked/);
  assert.match(doctor.stdout, /no login, network, provider request/);
  assert.deepEqual(
    readdirSync(join(f.env.XDG_STATE_HOME, "jared-local")),
    before,
  );
  assert.equal(
    readFileSync(join(f.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"),
    '{"sentinel":"do-not-change"}\n',
  );
  for (const output of [
    setup.stdout + setup.stderr,
    doctor.stdout + doctor.stderr,
  ])
    assert(!output.includes("GLOBAL-SECRET"));
  const alternative = isolated();
  const keydir = join(alternative.root, "credentials");
  mkdirSync(keydir, { mode: 0o700 });
  const keyfile = join(keydir, "key");
  writeFileSync(keyfile, "synthetic-test-secret-no-provider", { mode: 0o600 });
  const api = spawnSync(
    process.execPath,
    [
      main,
      "setup",
      "--no-login",
      "--no-register",
      "--provider",
      "openai",
      "--model",
      "explicit-test-model",
      "--api-key-file",
      keyfile,
    ],
    { env: alternative.env, encoding: "utf8", cwd: "/" },
  );
  assert.equal(api.status, 0, api.stderr);
  assert(!api.stdout.includes("synthetic-test-secret"));
  const again = spawnSync(
    process.execPath,
    [main, "setup", "--no-login", "--no-register"],
    { env: alternative.env, encoding: "utf8", cwd: "/" },
  );
  assert.match(again.stdout, /openai\/explicit-test-model/);
  const symlink = isolated();
  mkdirSync(symlink.env.XDG_CONFIG_HOME);
  symlinkSync(f.root, join(symlink.env.XDG_CONFIG_HOME, "jared-local"));
  assert.equal(
    spawnSync(
      process.execPath,
      [main, "setup", "--no-login", "--no-register"],
      { env: symlink.env, stdio: "ignore" },
    ).status,
    1,
  );
});

test("fresh noninteractive setup needs no host search tools/cache and offers no helper-download prompt", () => {
  const f = isolated();
  const result = spawnSync(
    process.execPath,
    [main, "setup", "--no-login", "--no-register"],
    {
      cwd: "/",
      env: { ...f.env, PATH: "" },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Packaged file tools ready/);
  assert.match(result.stdout, /Setup incomplete: runtime ready/);
  assert(!result.stdout.includes("Allow bundled Pi to download"));
  assert(
    !result.stderr.includes("ExperimentalWarning"),
    "No service/SQLite import should interrupt setup prompts",
  );
  assert(!existsSync(join(f.env.PI_CODING_AGENT_DIR, "bin")));
  assert(!existsSync(join(f.env.XDG_STATE_HOME, "jared-local/search-tools")));
});

test("damaged installation fails closed with reinstall guidance, never a helper-setup loop", async () => {
  const f = isolated();
  const packageRoot = join(f.root, "installation");
  mkdirSync(packageRoot);
  for (const file of ["dist/src", "agent", "vendor", "package.json"])
    cpSync(resolve(file), join(packageRoot, file), { recursive: true });
  symlinkSync(
    resolve("node_modules"),
    join(packageRoot, "node_modules"),
    "dir",
  );
  const installedMain = join(packageRoot, "dist/src/main.js");
  const credentials = join(f.root, "credentials");
  mkdirSync(credentials, { mode: 0o700 });
  const key = join(credentials, "key");
  writeFileSync(key, "synthetic-no-provider-request", { mode: 0o600 });
  const setup = spawnSync(
    process.execPath,
    [
      installedMain,
      "setup",
      "--no-login",
      "--no-register",
      "--provider",
      "openai",
      "--model",
      "gpt-4o",
      "--api-key-file",
      key,
    ],
    { cwd: "/", env: f.env, encoding: "utf8" },
  );
  assert.equal(setup.status, 0, setup.stderr);
  const bin = join(packageRoot, "vendor/tools", runtimeTarget());
  unlinkSync(join(bin, "fd"));
  const c = await client(installedMain, f.env, "/");
  try {
    const p = project(f.root, "missing-tools-product");
    assert.equal(
      (
        await call(c, "setup_project", {
          projectId: "missing-tools",
          projectPath: p.path,
          platform: "web",
          purpose: "Fixture",
          approvedDirection: "Keep existing",
          setupProfile: "source-only-v1",
          designPaths: ["README.md"],
        })
      ).error,
      false,
    );
    for (const kind of ["missing", "unsafe"]) {
      if (kind === "unsafe") symlinkSync("/usr/bin/true", join(bin, "fd"));
      const blocked = await call(c, "submit_job", {
        projectId: "missing-tools",
        baseCommit: p.commit,
        kind: "audit",
        request: "Must not call provider",
        scope: "product",
        idempotencyKey: kind,
      });
      assert.equal(blocked.error, true);
      assert.equal(
        blocked.data.error,
        "packaged_search_tools_unavailable_reinstall_jared",
      );
    }
    assert.deepEqual(readdirSync(join(p.path, ".jared/runs")), []);
  } finally {
    await c.close();
  }
  await waitFor(
    () => !existsSync(join(f.env.XDG_STATE_HOME, "jared-local/worker.sock")),
    10000,
  );
});

test("packed standalone install outside checkout: bin/help/setup/doctor, two simultaneous production stdio clients, offline discovery and blocked audits", async () => {
  const f = isolated();
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", f.root],
      {
        encoding: "utf8",
        env: { ...process.env, npm_config_update_notifier: "false" },
      },
    ),
  )[0];
  const files = packed.files.map((r: { path: string }) => r.path) as string[];
  assert.equal(
    files.filter((p) => /agent\/v1\/\.pi\/skills\/.*\/SKILL.md$/.test(p))
      .length,
    6,
  );
  assert(files.includes("agent/v1/.pi/system.yaml"));
  assert(files.includes("npm-shrinkwrap.json"));
  assert(files.includes("agent/v1/.pi/agents/ui-reviewer.md"));
  for (const file of files) {
    assert(!/^(src|test|node_modules)\//.test(file));
    assert(
      !/(http\.js|git-ssh|provision-tokens|check-config|\.env|\.faur|sessions|auth\.json)/.test(
        file,
      ),
      file,
    );
  }
  const archive = join(f.root, packed.filename);
  const prefix = join(f.root, "install");
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--offline",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    {
      cwd: f.root,
      stdio: "pipe",
      env: { ...process.env, npm_config_update_notifier: "false" },
    },
  );
  const bin = join(prefix, "node_modules/.bin/jared");
  const installed = join(
    prefix,
    "node_modules/@jared-local/cli/dist/src/main.js",
  );
  assert(existsSync(bin));
  assert.equal(
    spawnSync(bin, ["--help"], { cwd: "/", env: f.env, encoding: "utf8" })
      .status,
    0,
  );
  const setup = spawnSync(bin, ["setup", "--no-login", "--no-register"], {
    cwd: "/",
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(setup.status, 0, setup.stderr);
  const doctor = spawnSync(bin, ["doctor"], {
    cwd: "/",
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /10 bundled native assets match provenance/);
  assert.match(doctor.stdout, /Packaged fd and rg pass checksums/);
  assert(!doctor.stdout.includes("Install fd"));
  // Exercise installed Pi's actual tools with packaged binaries and no host cache.
  const nativeFixture = join(f.root, "installed-native-probe");
  mkdirSync(nativeFixture, { mode: 0o700 });
  nativeSearchProbe(
    nativeFixture,
    join(prefix, "node_modules/@jared-local/cli"),
  );
  assert(!existsSync(join(f.env.XDG_STATE_HOME, "jared-local/search-tools")));
  assert(!existsSync(join(f.env.PI_CODING_AGENT_DIR, "bin")));
  const [a, b] = await Promise.all([
    client(installed, f.env, "/"),
    client(installed, f.env, f.root),
  ]);
  try {
    assert.equal((await a.listTools()).tools.length, 10);
    assert.equal((await b.listTools()).tools.length, 10);
    assert.match(
      (await call(a, "get_jared_guide", {})).data.guide,
      /same-user operator authority/,
    );
    const p = project(f.root, "offline-product");
    const setupProject = await call(a, "setup_project", {
      projectId: "offline",
      projectPath: p.path,
      platform: "web",
      purpose: "Offline fixture",
      approvedDirection: "Keep existing",
      setupProfile: "source-only-v1",
      designPaths: ["README.md"],
    });
    assert.equal(setupProject.error, false);
    const blocked = await call(b, "submit_job", {
      projectId: "offline",
      baseCommit: p.commit,
      kind: "audit",
      request: "Must not call provider",
      scope: "product",
      idempotencyKey: "blocked",
    });
    assert.equal(blocked.error, true);
    assert.equal(
      blocked.data.error,
      "authentication_missing_or_invalid_run_jared_setup",
    );
    const socket = join(f.env.XDG_STATE_HOME, "jared-local/worker.sock");
    assert.equal(statSync(socket).mode & 0o777, 0o600);
    assert(!existsSync(join(p.path, ".jared/runs/blocked")));
    assert.equal(
      readFileSync(join(f.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"),
      '{"sentinel":"GLOBAL-SECRET-DO-NOT-IMPORT"}\n',
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
  await waitFor(
    () => !existsSync(join(f.env.XDG_STATE_HOME, "jared-local/worker.sock")),
    10000,
  );
  const restarted = await client(installed, f.env, "/");
  try {
    assert.equal((await restarted.listTools()).tools.length, 10);
  } finally {
    await restarted.close();
  }
  await waitFor(
    () => !existsSync(join(f.env.XDG_STATE_HOME, "jared-local/worker.sock")),
    10000,
  );
  console.log(
    `Standalone pack: ${archive}; SHA256 ${createHash("sha256").update(readFileSync(archive)).digest("hex")}; installed native find+grep passed; ${files.length} package files; 6 native skills; offline isolated-prefix install, two stdio clients and automatic idle restart passed.`,
  );
});

test("frontend retries exited starters while the previous owner's lock is still held", async () => {
  const f = isolated();
  const setup = spawnSync(
    process.execPath,
    [main, "setup", "--no-login", "--no-register"],
    {
      cwd: "/",
      env: f.env,
      encoding: "utf8",
    },
  );
  assert.equal(setup.status, 0, setup.stderr);
  const root = join(f.env.XDG_STATE_HOME, "jared-local");
  const release = await ownerLock(root);
  // Reproduce the socket-gone/lock-held shutdown window. The first starter
  // exits on ownership-lock contention; the same frontend must recover after release.
  let released = false;
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await release();
  };
  const timer = setTimeout(() => void releaseOnce(), 1500);
  let c: Awaited<ReturnType<typeof client>> | undefined;
  try {
    c = await client(main, f.env, "/");
    assert.equal((await c.listTools()).tools.length, 10);
  } finally {
    clearTimeout(timer);
    await releaseOnce();
    await c?.close();
  }
  await waitFor(() => !existsSync(join(root, "worker.sock")), 10000);
});

test("frontend startup failure exposes only the bounded starter exit diagnostic on stderr", async () => {
  const f = isolated();
  const setup = spawnSync(
    process.execPath,
    [main, "setup", "--no-login", "--no-register"],
    {
      cwd: "/",
      env: f.env,
      encoding: "utf8",
    },
  );
  assert.equal(setup.status, 0, setup.stderr);
  const release = await ownerLock(join(f.env.XDG_STATE_HOME, "jared-local"));
  try {
    const frontend = spawnSync(process.execPath, [main, "mcp"], {
      cwd: "/",
      env: f.env,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(frontend.status, 1, frontend.stderr);
    assert.equal(frontend.stdout, "");
    assert.match(
      frontend.stderr,
      /(?:^|\n)Jared worker startup failed: local_worker_start_failed_exit_1_run_jared_doctor\n$/,
    );
    assert(!frontend.stderr.includes(f.root));
    assert(!frontend.stderr.includes("GLOBAL-SECRET"));
  } finally {
    await release();
  }
});
