import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { isolated } from "./local-fixtures.js";
import { setup, doctor, piAuthPath } from "../src/setup.js";
import { bootstrap, loadLocalConfig } from "../src/local-config.js";
import { ownerLock } from "../src/safety.js";

const credential = {
  type: "oauth",
  access: "SETUP-SYNTHETIC-ACCESS",
  refresh: "SETUP-SYNTHETIC-REFRESH",
  accountId: "synthetic",
  expires: Date.now() + 3600000,
};
const other = { type: "api_key", key: "!exit 99" };
async function isolatedSetup(
  fn: (f: ReturnType<typeof isolated>, output: string[]) => Promise<void>,
) {
  const f = isolated();
  const env = { ...process.env };
  const log = console.log;
  const output: string[] = [];
  Object.assign(process.env, f.env);
  console.log = (...args: unknown[]) => {
    output.push(args.join(" "));
  };
  try {
    await fn(f, output);
    assert(!output.join("\n").includes("SETUP-SYNTHETIC-ACCESS"));
    assert(!output.join("\n").includes("SETUP-SYNTHETIC-REFRESH"));
  } finally {
    console.log = log;
    for (const key of Object.keys(process.env))
      if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
}

test("setup consent decline/no-login/noninteractive never borrow auth; explicit reuse persists pointer only and doctor is offline", async () => {
  await isolatedSetup(async (f) => {
    const path = piAuthPath();
    const data = JSON.stringify({ "openai-codex": credential, openai: other });
    writeFileSync(path, data, { mode: 0o600 });
    await setup(
      { noLogin: false, noRegister: true },
      { ask: async () => false },
    );
    const initial = readFileSync(
      join(f.env.XDG_CONFIG_HOME, "jared-local/config.json"),
      "utf8",
    );
    await setup(
      { noLogin: true, noRegister: true },
      {
        ask: async () => {
          assert.fail("no-login prompted");
        },
      },
    );
    await setup({ noLogin: false, noRegister: true }); // actual noninteractive default
    assert.equal(
      readFileSync(
        join(f.env.XDG_CONFIG_HOME, "jared-local/config.json"),
        "utf8",
      ),
      initial,
    );
    await setup(
      { noLogin: true, noRegister: true, usePiAuth: true },
      { login: async () => assert.fail("reuse logged in") },
    );
    const c = loadLocalConfig();
    assert.deepEqual(c.pi, {
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      authSource: { kind: "pi", path },
    });
    assert(
      !existsSync(
        join(f.env.XDG_CONFIG_HOME, "jared-local/codex-auth/auth.json"),
      ),
    );
    assert.equal(readFileSync(path, "utf8"), data);
    doctor();
    assert.equal(readFileSync(path, "utf8"), data);
    assert.equal(
      readFileSync(join(f.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"),
      '{"sentinel":"do-not-change"}\n',
    );
  });
});

test("empty 0.2.0 dedicated configuration offers shared reuse, valid dedicated choices are never overwritten", async () => {
  await isolatedSetup(async (f) => {
    const old = bootstrap();
    assert.equal(old.pi.provider, "openai-codex");
    writeFileSync(
      piAuthPath(),
      JSON.stringify({ "openai-codex": credential, openai: other }),
      { mode: 0o600 },
    );
    let asked = false;
    await setup(
      { noLogin: false, noRegister: true },
      {
        ask: async (message) => {
          asked = true;
          assert.match(
            message,
            /^Reuse your Pi login for .*shared.*unrelated provider/,
          );
          return true;
        },
      },
    );
    assert(asked);
    assert.equal(
      loadLocalConfig().pi.provider === "openai-codex" &&
        (loadLocalConfig().pi as { authSource?: { kind: string } }).authSource
          ?.kind,
      "pi",
    );
    // Restore a valid legacy dedicated config to exercise preservation independently.
    writeFileSync(
      join(f.env.XDG_CONFIG_HOME, "jared-local/config.json"),
      JSON.stringify(old),
    );
    if (old.pi.provider !== "openai-codex") assert.fail();
    writeFileSync(
      join(old.pi.oauthDir!, "auth.json"),
      JSON.stringify({ "openai-codex": credential }),
      { mode: 0o600 },
    );
    const before = readFileSync(
      join(f.env.XDG_CONFIG_HOME, "jared-local/config.json"),
      "utf8",
    );
    await setup(
      { noLogin: false, noRegister: true, usePiAuth: true },
      { ask: async () => assert.fail("valid setup prompted") },
    );
    assert.equal(
      readFileSync(
        join(f.env.XDG_CONFIG_HOME, "jared-local/config.json"),
        "utf8",
      ),
      before,
    );
  });
});

test("missing selected auth prepares bundled shared login once, dedicated remains optional; no real provider login", async () => {
  for (const dedicated of [false, true])
    await isolatedSetup(async (f) => {
      unlinkSync(piAuthPath());
      let logins = 0;
      await setup(
        { noLogin: false, noRegister: true, dedicated },
        {
          ask: async (message) => {
            assert.match(message, /bundled Pi SDK/);
            return true;
          },
          login: async (path) => {
            logins++;
            assert.equal(
              path,
              dedicated
                ? join(
                    f.env.XDG_CONFIG_HOME,
                    "jared-local/codex-auth/auth.json",
                  )
                : piAuthPath(),
            );
            writeFileSync(
              path,
              JSON.stringify({ "openai-codex": credential, openai: other }),
              { mode: 0o600 },
            );
          },
        },
      );
      assert.equal(logins, 1);
      const c = loadLocalConfig();
      assert(c.pi.provider === "openai-codex");
      assert.equal(c.pi.authSource?.kind, dedicated ? "dedicated" : "pi");
    });
});

test("dedicated reuse consent names the existing dedicated Codex login, not the shared Pi login", async () => {
  await isolatedSetup(async (f) => {
    const c = bootstrap();
    assert(c.pi.provider === "openai-codex");
    const path = join(c.pi.oauthDir!, "auth.json");
    const data = JSON.stringify({ "openai-codex": credential });
    writeFileSync(path, data, { mode: 0o600 });
    const configFile = join(f.env.XDG_CONFIG_HOME, "jared-local/config.json");
    const config = JSON.stringify({
      ...c,
      pi: {
        provider: c.pi.provider,
        model: c.pi.model,
        authSource: { kind: "pi", path: piAuthPath() },
      },
    });
    writeFileSync(configFile, config);
    let asked = false;
    await setup(
      { noLogin: false, noRegister: true, dedicated: true },
      {
        ask: async (message) => {
          asked = true;
          assert.match(
            message,
            /^Reuse your existing dedicated Codex login for /,
          );
          assert(message.includes(JSON.stringify(path)));
          assert.match(message, /same dedicated file/);
          return false;
        },
      },
    );
    assert(asked);
    assert.equal(readFileSync(configFile, "utf8"), config);
    assert.equal(readFileSync(path, "utf8"), data);
  });
});

test("blocked API-key setup names the selected provider credential instead of Pi login", async () => {
  for (const provider of ["openai", "anthropic"] as const)
    await isolatedSetup(async (f, output) => {
      const directory = join(f.root, "credentials");
      mkdirSync(directory, { mode: 0o700 });
      const credentialFile = join(directory, "key");
      writeFileSync(credentialFile, "SETUP-SYNTHETIC-KEY", { mode: 0o600 });
      bootstrap({ provider, model: "synthetic-model", credentialFile });
      unlinkSync(credentialFile);
      await setup(
        { noLogin: false, noRegister: true },
        { ask: async () => assert.fail("API-key repair prompted for OAuth") },
      );
      const blocked = output.find((line) => line.startsWith("Audits BLOCKED:"));
      assert(blocked);
      assert(blocked.includes(`credentialFile for ${provider}/`));
      assert(
        blocked.includes(
          provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
        ),
      );
      assert(!blocked.includes("Pi login"));
      assert(!output.join("\n").includes("SETUP-SYNTHETIC-KEY"));
    });
});

test("auth pointer changes fail while owned worker lock is held, without killing or resetting anything", async () => {
  await isolatedSetup(async (f) => {
    const c = bootstrap();
    writeFileSync(
      piAuthPath(),
      JSON.stringify({ "openai-codex": credential }),
      { mode: 0o600 },
    );
    const file = join(f.env.XDG_CONFIG_HOME, "jared-local/config.json");
    const before = readFileSync(file, "utf8");
    const release = await ownerLock(c.stateDir);
    try {
      await assert.rejects(
        setup({ noLogin: true, noRegister: true, usePiAuth: true }),
        /active_worker_auth_change_blocked/,
      );
    } finally {
      await release();
    }
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("doctor describes expired selected OAuth without refreshing and default Pi path honors isolated HOME", async () => {
  await isolatedSetup(async (f, output) => {
    const path = piAuthPath();
    const data = JSON.stringify({
      "openai-codex": { ...credential, expires: 1 },
      openai: other,
    });
    writeFileSync(path, data, { mode: 0o600 });
    await setup({ noLogin: true, noRegister: true, usePiAuth: true });
    doctor();
    assert.match(
      output.join("\n"),
      /expired or needs-refresh.*NOT live verified/,
    );
    assert.equal(readFileSync(path, "utf8"), data);
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(piAuthPath(), join(f.env.HOME, ".pi/agent/auth.json"));
  });
});
