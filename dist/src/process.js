import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { groupAlive, receipt } from "./safety.js";
import { requireThat } from "./contracts.js";
export class OwnedProcess {
    terminationGraceMs;
    child;
    group;
    exited;
    constructor(command, args, cwd, env, observe, terminationGraceMs = 200) {
        this.terminationGraceMs = terminationGraceMs;
        this.child = spawn(command, args, {
            cwd,
            env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        // A child may exit before a graceful-abort write. Stream errors are asynchronous,
        // not caught by write() try/catch; they must not crash the service.
        this.child.stdin.on("error", () => { });
        this.exited = new Promise((resolve, reject) => {
            this.child.once("error", reject);
            this.child.once("close", (code, signal) => resolve({ code, signal }));
        });
        // Avoid an unhandled rejection while startup callers attach their listeners.
        void this.exited.catch(() => { });
        requireThat(this.child.pid, "spawn_failed");
        try {
            this.group = receipt(this.child.pid);
            observe(this.group);
        }
        catch (error) {
            // Inspection/persistence may fail after spawn (especially external ps on
            // macOS). Never abandon an unobserved child. It has not been reaped while
            // this synchronous constructor runs, so its PID cannot yet be reused.
            try {
                process.kill(-this.child.pid, "SIGKILL");
            }
            catch { }
            this.child.kill("SIGKILL");
            this.child.stdout.resume();
            this.child.stderr.resume();
            throw error;
        }
    }
    stopping;
    stop(graceful) {
        return (this.stopping ??= this.stopOwned(graceful));
    }
    async stopOwned(graceful) {
        graceful?.();
        await delay(80);
        const signal = (s) => {
            try {
                process.kill(-this.group.pid, s);
            }
            catch (e) {
                if (e.code !== "ESRCH")
                    throw e;
            }
        };
        signal("SIGTERM");
        for (let i = 0; i < Math.ceil(this.terminationGraceMs / 20) && groupAlive(this.group.pid); i++)
            await delay(20);
        if (groupAlive(this.group.pid))
            signal("SIGKILL");
        for (let i = 0; i < 50 && groupAlive(this.group.pid); i++)
            await delay(20);
        requireThat(!groupAlive(this.group.pid), "process_stop_unconfirmed");
        await this.exited;
    }
}
