import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { requireThat } from "./contracts.js";

export function supportedPlatform(platform: string = process.platform) {
  requireThat(
    platform === "linux" || platform === "darwin",
    "unsupported_platform",
  );
}
// macOS ps start times have only second resolution. Scope their identity to
// this service process too: after a crash, a new owner must NOT signal a live
// orphan using an identity that could match a reused PID. It retains the
// receipt as unconfirmed instead. Dead groups can still be reconciled.
const session = randomUUID();
function command(file: string, args: string[]) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  requireThat(
    !result.error && result.status === 0,
    "process_inspection_failed",
  );
  return result.stdout.trim();
}
export function bootIdentity() {
  supportedPlatform();
  return process.platform === "linux"
    ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    : command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
}
export type ProcessInfo = { start: string; group: number; state: string };
export function parseDarwinProcess(output: string): ProcessInfo | undefined {
  if (!output.trim()) return undefined;
  const match = output
    .trim()
    .match(
      /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+([A-Za-z+<>NEXsLWT-]+)$/,
    );
  requireThat(match, "process_inspection_failed");
  return {
    start: match[1].replace(/\s+/g, " "),
    group: Number(match[2]),
    state: match[3][0],
  };
}
export function processInfo(pid: number): ProcessInfo | undefined {
  supportedPlatform();
  requireThat(Number.isSafeInteger(pid) && pid > 0, "invalid_pid");
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return { state: fields[0], group: Number(fields[2]), start: fields[19] };
    } catch (error) {
      if (
        ["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code || "",
        )
      )
        return undefined;
      throw error;
    }
  }
  const result = spawnSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart=,pgid=,stat="],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeout: 5000,
    },
  );
  if (
    !result.error &&
    result.status === 1 &&
    !result.stdout.trim() &&
    !result.stderr.trim()
  )
    return undefined;
  requireThat(
    !result.error && result.status === 0,
    "process_inspection_failed",
  );
  const info = parseDarwinProcess(result.stdout);
  return info && { ...info, start: `${session}:${info.start}` };
}
export function parseProcessGroups(output: string, group: number): boolean {
  let alive = false;
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const match = line.trim().match(/^(\d+)\s+([A-Za-z+<>NEXsLWT-]+)$/);
    requireThat(match, "process_inspection_failed");
    if (Number(match[1]) === group && match[2][0] !== "Z") alive = true;
  }
  return alive;
}
export function processGroupAlive(pid: number): boolean {
  supportedPlatform();
  if (process.platform === "darwin") {
    return parseProcessGroups(
      command("/bin/ps", ["-A", "-o", "pgid=,stat="]),
      pid,
    );
  }
  return readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .some((p) => {
      const info = processInfo(Number(p));
      return info?.group === pid && info.state !== "Z";
    });
}
