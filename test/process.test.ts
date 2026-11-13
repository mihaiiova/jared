import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { OwnedProcess } from "../src/process.js";
import { groupAlive, procInfo } from "../src/safety.js";
import { waitFor } from "./helpers.js";

test("failed receipt persistence stops the newly spawned unobserved group", async () => {
  let pid = 0;
  assert.throws(
    () =>
      new OwnedProcess(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        tmpdir(),
        { PATH: "/usr/bin:/bin" },
        (group) => {
          pid = group.pid;
          throw new Error("receipt_write_failed");
        },
      ),
    /receipt_write_failed/,
  );
  assert(pid > 0);
  await waitFor(() => !groupAlive(pid));
});

test("owned process group: graceful abort then TERM/KILL terminates spawned descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "jared-process-"));
  const abortFile = join(root, "abort-received");
  const script = join(root, "tree.cjs");
  writeFileSync(
    script,
    `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});process.stdout.write(JSON.stringify({parent:process.pid,descendant:c.pid})+'\\n');process.stdin.on('data',()=>fs.writeFileSync(${JSON.stringify(abortFile)},'abort'));setInterval(()=>{},1000);`,
  );
  const receipts = [];
  const processTree = new OwnedProcess(
    process.execPath,
    [script],
    root,
    { PATH: "/usr/bin:/bin" },
    (g) => receipts.push(g),
  );
  let output = "";
  processTree.child.stdout.on("data", (b) => (output += b.toString()));
  processTree.child.stderr.resume();
  await waitFor(() => output.includes("\n"));
  const ids = JSON.parse(output.trim());
  assert.equal(receipts.length, 1);
  assert(groupAlive(ids.parent));
  await processTree.stop(() =>
    processTree.child.stdin.write('{"type":"abort"}\n'),
  );
  assert.equal(readFileSync(abortFile, "utf8"), "abort");
  assert(!groupAlive(ids.parent));
  assert(!procInfo(ids.descendant) || procInfo(ids.descendant)?.state === "Z");
});

test("owned process: graceful abort write after child exit cannot crash the service", async () => {
  const root = mkdtempSync(join(tmpdir(), "jared-closed-pipe-"));
  const p = new OwnedProcess(
    process.execPath,
    ["-e", ""],
    root,
    { PATH: "/usr/bin:/bin" },
    () => {},
  );
  p.child.stdout.resume();
  p.child.stderr.resume();
  await p.exited;
  await p.stop(() => p.child.stdin.write('{"type":"abort"}\n'));
  assert(!groupAlive(p.group.pid));
  assert(p.child.stdin.listenerCount("error") > 0);
});
