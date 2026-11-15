// Developer-only refresh. Never run by npm installation or jared setup.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../vendor/tools/", import.meta.url));
const sources = [
  [
    "darwin-arm64",
    "fd",
    "10.3.0",
    "sharkdp/fd",
    "v10.3.0",
    "fd-v10.3.0-aarch64-apple-darwin",
    "0570263812089120bc2a5d84f9e65cd0c25e4a4d724c80075c357239c74ae904",
  ],
  [
    "darwin-x64",
    "fd",
    "10.3.0",
    "sharkdp/fd",
    "v10.3.0",
    "fd-v10.3.0-x86_64-apple-darwin",
    "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
  ],
  [
    "linux-arm64",
    "fd",
    "10.3.0",
    "sharkdp/fd",
    "v10.3.0",
    "fd-v10.3.0-aarch64-unknown-linux-musl",
    "996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b",
  ],
  [
    "linux-x64",
    "fd",
    "10.3.0",
    "sharkdp/fd",
    "v10.3.0",
    "fd-v10.3.0-x86_64-unknown-linux-musl",
    "2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14",
  ],
  [
    "darwin-arm64",
    "rg",
    "15.1.0",
    "BurntSushi/ripgrep",
    "15.1.0",
    "ripgrep-15.1.0-aarch64-apple-darwin",
    "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
  ],
  [
    "darwin-x64",
    "rg",
    "15.1.0",
    "BurntSushi/ripgrep",
    "15.1.0",
    "ripgrep-15.1.0-x86_64-apple-darwin",
    "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
  ],
  [
    "linux-arm64",
    "rg",
    "15.1.0",
    "BurntSushi/ripgrep",
    "15.1.0",
    "ripgrep-15.1.0-aarch64-unknown-linux-gnu",
    "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
  ],
  [
    "linux-x64",
    "rg",
    "15.1.0",
    "BurntSushi/ripgrep",
    "15.1.0",
    "ripgrep-15.1.0-x86_64-unknown-linux-musl",
    "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
  ],
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = { schemaVersion: 1, targets: {}, licenses: {} };
const temp = mkdtempSync(join(tmpdir(), "jared-vendor-"));
try {
  for (const [
    target,
    tool,
    version,
    repo,
    tag,
    directory,
    archiveSha256,
  ] of sources) {
    const url = `https://github.com/${repo}/releases/download/${tag}/${directory}.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok)
      throw new Error(`Upstream download failed (${response.status}): ${url}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (sha256(archive) !== archiveSha256)
      throw new Error(`Archive checksum mismatch: ${target}/${tool}`);
    const archivePath = join(temp, `${target}-${tool}.tar.gz`);
    writeFileSync(archivePath, archive, { flag: "wx" });
    const extract = (file) =>
      execFileSync("tar", ["-xOzf", archivePath, `${directory}/${file}`], {
        maxBuffer: 32 * 1024 * 1024,
      });
    const bytes = extract(tool);
    mkdirSync(join(root, target), { recursive: true });
    writeFileSync(join(root, target, tool), bytes, { mode: 0o755 });
    chmodSync(join(root, target, tool), 0o755);
    manifest.targets[target] ||= {};
    manifest.targets[target][tool] = {
      version,
      file: `${target}/${tool}`,
      sha256: sha256(bytes),
      archiveUrl: url,
      archiveSha256,
    };
    const entries = execFileSync("tar", ["-tzf", archivePath], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    const licenseNames = [
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "COPYING",
      "UNLICENSE",
    ].filter((name) => entries.includes(`${directory}/${name}`));
    if (!licenseNames.length)
      throw new Error(`Upstream licenses missing: ${tool}`);
    for (const name of licenseNames) {
      const license = extract(name);
      const file = `licenses/${tool}/${name}`;
      if (
        manifest.licenses[file] &&
        manifest.licenses[file] !== sha256(license)
      )
        throw new Error(`License differs between platforms: ${file}`);
      mkdirSync(join(root, "licenses", tool), { recursive: true });
      writeFileSync(join(root, file), license);
      manifest.licenses[file] = sha256(license);
    }
    console.log(
      `Verified upstream archive and packaged ${target}/${tool} ${version}`,
    );
  }
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
