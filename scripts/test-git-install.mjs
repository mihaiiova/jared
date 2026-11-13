import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Real Git-dependency installation, not a tarball or symlink install. Uses only
// the existing npm cache; no login, network, user-prefix install or setup.
const source = fileURLToPath(new URL("../", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "jared-git-install-")));
const repo = join(root, "source");
const home = join(root, "home");
const prefix = join(root, "prefix");
mkdirSync(repo);
mkdirSync(home);
writeFileSync(join(home, ".npmrc"), `prefix=${prefix}\n`);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: root,
  npm_config_cache: process.env.npm_config_cache || join(homedir(), ".npm"),
  CI: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
function run(command, args, cwd = root, timeout = 300_000) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  const log = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error || result.status !== 0) {
    writeFileSync(join(root, "failure.log"), log);
    throw new Error(
      `${command} failed (${result.error?.code || result.status}); evidence: ${root}/failure.log\n${log.slice(-2500)}`,
    );
  }
  return result.stdout.trim();
}
for (const file of [
  "package.json",
  "npm-shrinkwrap.json",
  "tsconfig.json",
  "README.md",
  "src",
  "test",
  "scripts",
  "agent",
  "docs",
  "dist/src",
]) {
  cpSync(join(source, file), join(repo, file), { recursive: true });
}
run("git", ["init", "-q"], repo);
run("git", ["add", "."], repo);
run(
  "git",
  [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "Git-install regression fixture",
  ],
  repo,
);
const commit = run("git", ["rev-parse", "HEAD"], repo);
console.log(`Git-install evidence: ${root}`);
const target =
  process.argv[2] ||
  `${pathToFileURL(repo).href.replace("file:", "git+file:")}#${commit}`;
if (process.argv[2]) {
  assert.match(
    target,
    /^git\+https:\/\/github\.com\/mihaiiova\/jared\.git#[A-Za-z0-9_./-]+$/,
    "remote validation must name an explicit Jared ref",
  );
}
run("npm", [
  "install",
  "--global",
  "--offline",
  "--no-audit",
  "--no-fund",
  target,
]);
const installed = join(prefix, "lib/node_modules/@jared-local/cli");
assert(
  existsSync(join(installed, "dist/src/main.js")),
  "Git installation must include the prebuilt CLI",
);
assert(
  !existsSync(join(installed, "node_modules/typescript")),
  "build-only TypeScript must not become a runtime dependency",
);
assert(
  !existsSync(join(installed, "src")),
  "unpacked development source is not a runtime dependency",
);
assert(!existsSync(join(installed, "test")), "tests must not ship");
const help = run(join(prefix, "bin/jared"), ["--help"]);
assert.match(help, /Jared/);
assert.match(help, /jared mcp/);
const manifest = JSON.parse(
  readFileSync(join(installed, "package.json"), "utf8"),
);
assert.equal(manifest.bin.jared, "dist/src/main.js");
// Resolve real runtime modules too: --help intentionally has no dependencies.
run(process.execPath, [
  "--input-type=module",
  "-e",
  `await import(${JSON.stringify(pathToFileURL(join(installed, "dist/src/mcp.js")).href)}); console.log('runtime imports ready');`,
]);
console.log(
  "PASS: global Git install included prebuilt CLI, excluded dev-only files/dependencies, and loaded MCP runtime.",
);
