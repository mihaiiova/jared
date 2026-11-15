import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { packagedSearchTools } from "../src/search-tools.js";
import { repositoryRoot } from "../src/config.js";

/** Real Pi tools, no model/session/download; also exercises an installed SDK. */
export function nativeSearchProbe(cwd: string, packageRoot = repositoryRoot()) {
  const tools = packagedSearchTools(packageRoot);
  const sdkPackage = findPackageJSON(
    "@earendil-works/pi-coding-agent",
    pathToFileURL(join(packageRoot, "package.json")),
  );
  assert(sdkPackage);
  const sdk = join(dirname(sdkPackage), "dist/index.js");
  mkdirSync(join(cwd, "home"), { mode: 0o700, recursive: true });
  mkdirSync(join(cwd, "pi"), { mode: 0o700, recursive: true });
  writeFileSync(join(cwd, "jared-search-probe.txt"), "JARED_SEARCH_PROBE\n", {
    flag: "wx",
    mode: 0o600,
  });
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    globalThis.fetch=()=>{throw new Error('network_forbidden')};
    const {createFindToolDefinition,createGrepToolDefinition}=await import(${JSON.stringify(pathToFileURL(sdk).href)});
    const cwd=process.cwd(), ctx={cwd}, signal=AbortSignal.timeout(10000);
    for(const [tool,args] of [[createFindToolDefinition(cwd),{pattern:'jared-search-probe.txt'}],[createGrepToolDefinition(cwd),{pattern:'JARED_SEARCH_PROBE',glob:'jared-search-probe.txt'}]]) {
      const result=await tool.execute('probe',args,signal,undefined,ctx);
      if(!result.content.some(c=>c.type==='text'&&c.text.includes('jared-search-probe.txt'))) throw new Error('native_search_failed');
    }
    console.log('native find + grep OK');
  `,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 8192,
      env: {
        PATH: `${tools.bin}:/usr/bin:/bin`,
        HOME: join(cwd, "home"),
        PI_CODING_AGENT_DIR: join(cwd, "pi"),
        PI_OFFLINE: "1",
        LANG: "C",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native find \+ grep OK/);
}
