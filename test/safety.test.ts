import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { readBounded, owned } from "../src/safety.js";
import { Store } from "../src/store.js";
test("canonical artifact containment rejects lexical traversal, symlinks, hardlinks and oversized files", () => {
  const base = mkdtempSync(join(tmpdir(), "jared-paths-")),
    root = join(base, "owned");
  mkdirSync(root, { mode: 0o700 });
  const external = join(base, "outside.json");
  writeFileSync(external, '{"secret":"outside-owned-root"}');
  assert.throws(
    () => readBounded(root, root + "/../outside.json"),
    /outside_owned_root/,
  );
  symlinkSync(external, join(root, "link.json"));
  assert.throws(
    () => readBounded(root, join(root, "link.json")),
    /symlink_forbidden/,
  );
  linkSync(external, join(root, "hardlink.json"));
  assert.throws(
    () => readBounded(root, join(root, "hardlink.json")),
    /invalid_artifact_size_or_type/,
  );
  writeFileSync(join(root, "large.json"), "x".repeat(20));
  assert.throws(
    () => readBounded(root, join(root, "large.json"), 10),
    /invalid_artifact_size_or_type/,
  );
  writeFileSync(join(root, "report.json"), "{}");
  assert.equal(readBounded(root, join(root, "report.json")), "{}");
  assert.throws(
    () => owned(root, root + "/./report.json"),
    /outside_owned_root/,
  );
});
test("dangling SQLite symlink is denied before SQLite can create its external target", () => {
  const root = mkdtempSync(join(tmpdir(), "jared-db-path-"));
  symlinkSync(join(root, "not-a-db"), join(root, "service.sqlite"));
  assert.throws(() => new Store(root), /symlink_forbidden/);
});
