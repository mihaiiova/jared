import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { groupAlive, receipt } from "./safety.js";
import { requireThat, type GroupReceipt } from "./contracts.js";
export type ProcessObserver = (receipt: GroupReceipt) => void;
export class OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly group: GroupReceipt;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    observe: ProcessObserver,
    private readonly terminationGraceMs = 200,
  ) {
    this.child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A child may exit before a graceful-abort write. Stream errors are asynchronous,
    // not caught by write() try/catch; they must not crash the service.
    this.child.stdin.on("error", () => {});
    this.exited = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Avoid an unhandled rejection while startup callers attach their listeners.
    void this.exited.catch(() => {});
    requireThat(this.child.pid, "spawn_failed");
    try {
      this.group = receipt(this.child.pid);
      observe(this.group);
    } catch (error) {
      // Inspection/persistence may fail after spawn (especially external ps on
      // macOS). Never abandon an unobserved child. It has not been reaped while
      // this synchronous constructor runs, so its PID cannot yet be reused.
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {}
      this.child.kill("SIGKILL");
      this.child.stdout.resume();
      this.child.stderr.resume();
      throw error;
    }
  }
  private stopping?: Promise<void>;
  stop(graceful?: () => void): Promise<void> {
    return (this.stopping ??= this.stopOwned(graceful));
  }
  private async stopOwned(graceful?: () => void): Promise<void> {
    graceful?.();
    await delay(80);
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-this.group.pid, s);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    };
    signal("SIGTERM");
    for (
      let i = 0;
      i < Math.ceil(this.terminationGraceMs / 20) && groupAlive(this.group.pid);
      i++
    )
      await delay(20);
    if (groupAlive(this.group.pid)) signal("SIGKILL");
    for (let i = 0; i < 50 && groupAlive(this.group.pid); i++) await delay(20);
    requireThat(!groupAlive(this.group.pid), "process_stop_unconfirmed");
    await this.exited;
  }
}
