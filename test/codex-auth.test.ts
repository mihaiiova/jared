import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  linkSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  createCodexRuntime,
  inspectCodexAuth,
  safeAuthPath,
} from "../src/codex-auth.js";
import { bundledLogin } from "../src/setup.js";
import { ServiceError } from "../src/contracts.js";

function authFixture(expires = Date.now() + 3600000) {
  const directory = mkdtempSync(join(tmpdir(), "jared-native-auth-"));
  const path = join(directory, "auth.json");
  const credential = {
    type: "oauth" as const,
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    accountId: "synthetic-account",
    expires,
  };
  const other = {
    type: "api_key",
    key: "!exit 99",
    env: { SENTINEL: "unrelated-synthetic-secret" },
  };
  writeFileSync(
    path,
    JSON.stringify({ "openai-codex": credential, openai: other }),
    { mode: 0o600 },
  );
  return { directory, path, credential, other };
}

test("selected OAuth validation allows other providers and normal Pi directory extras/mode; rejects unsafe files/commands", () => {
  const f = authFixture();
  chmodSync(f.directory, 0o755);
  writeFileSync(join(f.directory, "settings.json"), "{}");
  const before = readFileSync(f.path, "utf8");
  assert.equal(inspectCodexAuth(f.path).access, f.credential.access);
  assert.equal(readFileSync(f.path, "utf8"), before);
  chmodSync(f.path, 0o644);
  assert.throws(() => safeAuthPath(f.path), /safe_auth_file_required/);
  assert.throws(() => inspectCodexAuth(f.path), /invalid_codex_oauth/);
  chmodSync(f.path, 0o600);
  const other = authFixture();
  unlinkSync(f.path);
  symlinkSync(other.path, f.path);
  assert.throws(() => safeAuthPath(f.path), /symlink/);
  assert.throws(() => inspectCodexAuth(f.path), /invalid_codex_oauth/);
  unlinkSync(f.path);
  symlinkSync(join(f.directory, "missing-target"), f.path);
  assert.throws(() => safeAuthPath(f.path, true), /symlink/);
  unlinkSync(f.path);
  linkSync(other.path, f.path);
  assert.throws(() => safeAuthPath(f.path), /safe_auth_file_required/);
  assert.throws(() => inspectCodexAuth(f.path), /invalid_codex_oauth/);
  unlinkSync(f.path);
  for (const c of [
    { type: "api_key", key: "!touch /tmp/not-executed" },
    { ...f.credential, key: "!command" },
    { ...f.credential, access: "bad token" },
    { ...f.credential, expires: "tomorrow" },
  ]) {
    writeFileSync(f.path, JSON.stringify({ "openai-codex": c }), {
      mode: 0o600,
    });
    assert.throws(() => inspectCodexAuth(f.path), /invalid_codex_oauth/);
  }
  const checkout = join(f.directory, "checkout");
  mkdirSync(checkout);
  mkdirSync(join(checkout, ".git"));
  assert.throws(
    () => safeAuthPath(join(checkout, "auth.json")),
    /credential_inside_checkout/,
  );
  assert.throws(
    () => inspectCodexAuth(join(checkout, "auth.json")),
    /invalid_codex_oauth/,
  );
});

test("inspectCodexAuth maps vanished auth files and parents to a safe auth diagnostic", () => {
  const f = authFixture();
  unlinkSync(f.path);
  for (const path of [f.path, join(f.directory, "missing-parent/auth.json")])
    assert.throws(
      () => inspectCodexAuth(path),
      (error) => {
        assert(error instanceof ServiceError);
        assert.equal(error.code, "invalid_codex_oauth");
        assert.equal(error.message, "invalid_codex_oauth");
        return true;
      },
    );
});

test("native authPath refresh serializes concurrent runtimes, writes in place and preserves unrelated provider semantically", async () => {
  const f = authFixture(1);
  const runtime = await createCodexRuntime(f.path);
  const other = await createCodexRuntime(f.path);
  let refreshes = 0;
  const provider = openaiCodexProvider();
  provider.auth.oauth = {
    ...provider.auth.oauth!,
    refresh: async (current) => {
      refreshes++;
      await delay(100);
      return {
        ...current,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 3600000,
      };
    },
    toAuth: async (c) => ({ apiKey: c.access }),
  };
  runtime.registerNativeProvider(provider);
  other.registerNativeProvider(provider);
  const inode = statSync(f.path).ino;
  const results = await Promise.all([
    runtime.getAuth("openai-codex"),
    other.getAuth("openai-codex"),
    runtime.getAuth("openai-codex"),
  ]);
  assert.equal(refreshes, 1);
  assert(results.every((a) => a?.auth.apiKey === "rotated-access"));
  assert.equal(statSync(f.path).ino, inode);
  assert.equal(inspectCodexAuth(f.path).refresh, "rotated-refresh");
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).openai, f.other);
  await Promise.all([
    runtime.settleCredentialWrites(),
    other.settleCredentialWrites(),
  ]);
});

test("bundled login prepares only explicit native authPath; mocked native provider login preserves other providers", async () => {
  const f = authFixture();
  const runtime = await createCodexRuntime(f.path);
  const provider = openaiCodexProvider();
  let logins = 0;
  provider.auth.oauth = {
    ...provider.auth.oauth!,
    login: async (interaction) => {
      logins++;
      assert.equal(
        await interaction.prompt({ type: "text", message: "synthetic" }),
        "synthetic-answer",
      );
      return { ...f.credential, access: "mock-login-access" };
    },
  };
  runtime.registerNativeProvider(provider);
  await bundledLogin(
    f.path,
    { prompt: async () => "synthetic-answer", notify: () => {} },
    async (options) => {
      assert.deepEqual(options, {
        authPath: f.path,
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      return runtime;
    },
  );
  assert.equal(logins, 1);
  assert.equal(inspectCodexAuth(f.path).access, "mock-login-access");
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).openai, f.other);
});

test("native cancellation after refresh begins persists rotation; provider failure leaves durable auth untouched", async () => {
  const f = authFixture(1);
  const runtime = await createCodexRuntime(f.path);
  let entered!: () => void, finish!: () => void;
  const entry = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (finish = r));
  const provider = openaiCodexProvider();
  provider.auth.oauth = {
    ...provider.auth.oauth!,
    refresh: async (c) => {
      entered();
      await hold;
      return {
        ...c,
        refresh: "cancelled-rotation",
        expires: Date.now() + 3600000,
      };
    },
  };
  runtime.registerNativeProvider(provider);
  const controller = new AbortController();
  const rejected = assert.rejects(
    runtime.getAuth("openai-codex", { signal: controller.signal }),
  );
  await entry;
  controller.abort();
  await rejected;
  finish();
  await runtime.settleCredentialWrites();
  assert.equal(inspectCodexAuth(f.path).refresh, "cancelled-rotation");
  const expired = authFixture(1);
  const before = readFileSync(expired.path, "utf8");
  const failing = await createCodexRuntime(expired.path);
  const bad = openaiCodexProvider();
  bad.auth.oauth = {
    ...bad.auth.oauth!,
    refresh: async () => {
      throw new Error("synthetic-private-body");
    },
  };
  failing.registerNativeProvider(bad);
  await assert.rejects(failing.getAuth("openai-codex"));
  await failing.settleCredentialWrites();
  assert.equal(readFileSync(expired.path, "utf8"), before);
});

test("separate native SDK authPath processes lock a shared multi-provider refresh", async () => {
  const f = authFixture(1);
  const marker = join(f.directory, "refresh-count");
  const child = join(f.directory, "refresh.mjs");
  writeFileSync(
    child,
    `
    import {createCodexRuntime} from ${JSON.stringify(new URL("../src/codex-auth.js", import.meta.url).href)};
    import {openaiCodexProvider} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/openai-codex"))};
    import {appendFileSync} from 'node:fs';
    const runtime = await createCodexRuntime(${JSON.stringify(f.path)});
    const provider = openaiCodexProvider();
    provider.auth.oauth = {...provider.auth.oauth, refresh:async c => {
      appendFileSync(${JSON.stringify(marker)}, 'refresh\\n');
      await new Promise(r=>setTimeout(r,150));
      return {...c,access:'process-access',refresh:'process-refresh',expires:Date.now()+3600000};
    }, toAuth:async c=>({apiKey:c.access})};
    runtime.registerNativeProvider(provider);
    if ((await runtime.getAuth('openai-codex'))?.auth.apiKey !== 'process-access') process.exitCode=1;
    await runtime.settleCredentialWrites();
  `,
  );
  const run = () =>
    new Promise<void>((yes, no) => {
      const p = spawn(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), child],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: f.directory,
            PI_CODING_AGENT_DIR: f.directory,
            PI_OFFLINE: "1",
          },
          stdio: "ignore",
        },
      );
      p.once("error", no);
      p.once("close", (code) =>
        code === 0 ? yes() : no(new Error("native_mock_refresh_child_failed")),
      );
    });
  await Promise.all([run(), run()]);
  assert.equal(readFileSync(marker, "utf8"), "refresh\n");
  assert.equal(inspectCodexAuth(f.path).refresh, "process-refresh");
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).openai, f.other);
});
