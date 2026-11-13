import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  unlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  supportedPlatform,
  parseDarwinProcess,
  parseProcessGroups,
} from "../src/platform.js";
import { ownerLock, receipt, sameProcess } from "../src/safety.js";

test("Linux and macOS are accepted, Windows is refused", () => {
  assert.doesNotThrow(() => supportedPlatform("linux"));
  assert.doesNotThrow(() => supportedPlatform("darwin"));
  assert.throws(() => supportedPlatform("win32"), /unsupported_platform/);
});
test("Darwin ps identity parsing retains start time, group and zombie state", () => {
  assert.deepEqual(
    parseDarwinProcess("  Mon Nov  9 12:34:56 2026   123 SZ+\n"),
    {
      start: "Mon Nov 9 12:34:56 2026",
      group: 123,
      state: "S",
    },
  );
  assert.equal(parseDarwinProcess("Mon Nov 9 12:34:56 2026 123 Z")?.state, "Z");
  assert.equal(parseDarwinProcess(""), undefined);
  assert.throws(
    () => parseDarwinProcess("unexpected output"),
    /process_inspection_failed/,
  );
  assert.equal(parseProcessGroups(" 123 Z\n 456 S\n", 123), false);
  assert.equal(parseProcessGroups(" 123 Z\n 123 S+\n", 123), true);
  assert.throws(
    () => parseProcessGroups("bad output", 123),
    /process_inspection_failed/,
  );
});
test("receipts distinguish altered identities without signalling them", () => {
  const r = receipt(process.pid);
  assert.equal(sameProcess(r), true);
  assert.equal(sameProcess({ ...r, boot: "different boot" }), false);
  assert.equal(sameProcess({ ...r, start: "different process" }), false);
});
test("ownership lock excludes contenders and releases explicitly", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jared-owner-")));
  try {
    const release = await ownerLock(root);
    try {
      await assert.rejects(ownerLock(root), /service_already_owned/);
    } finally {
      await release();
    }
    const again = await ownerLock(root);
    await again();
    await again();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("ownership lock rejects symlinks and hardlinks", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jared-owner-path-")));
  try {
    writeFileSync(join(root, "target"), "");
    symlinkSync(join(root, "target"), join(root, "owner.sqlite"));
    await assert.rejects(ownerLock(root), /symlink_forbidden/);
    unlinkSync(join(root, "owner.sqlite"));
    linkSync(join(root, "target"), join(root, "owner.sqlite"));
    await assert.rejects(ownerLock(root), /unsafe_owner_lock_file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("kernel ownership lock releases after owner SIGKILL", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jared-owner-crash-")));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import {ownerLock} from ${JSON.stringify(new URL("../src/safety.ts", import.meta.url).href)};
    await ownerLock(process.argv[1]);
    console.log('locked');
    setInterval(()=>{},1000);
  `,
      root,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  try {
    const ready = await Promise.race([
      once(child.stdout, "data").then(([data]) => String(data)),
      closed.then(() => {
        throw new Error("lock owner exited before ready");
      }),
    ]);
    assert.match(ready, /locked/);
    await assert.rejects(ownerLock(root), /service_already_owned/);
    child.kill("SIGKILL");
    await closed;
    const release = await ownerLock(root);
    await release();
  } finally {
    child.kill("SIGKILL");
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
