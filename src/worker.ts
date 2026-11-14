import { createServer, createConnection, type Socket } from "node:net";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { AuditService } from "./service.js";
import { PiExecutor, type Executor } from "./executor.js";
import { searchToolPath } from "./search-tools.js";
import { bundledAgent } from "./config.js";
import {
  executionConfig,
  loadLocalConfig,
  socketPath,
  type LocalConfig,
} from "./local-config.js";
import { createMcpServer } from "./mcp.js";
import { noSymlinks, pathExists } from "./safety.js";
import { ServiceError, requireThat } from "./contracts.js";

export { socketPath } from "./local-config.js";
/** Test injection is a function argument only, never a CLI flag, config or environment switch. */
export async function startWorker(c: LocalConfig, executor?: Executor) {
  const path = socketPath(c);
  const service = await AuditService.open({
    root: c.stateDir,
    executor: executor ?? new PiExecutor({ ...c.pi, jaredDir: bundledAgent() }),
    checkReady: executor
      ? undefined
      : () => {
          const current = loadLocalConfig();
          executionConfig(current);
          try {
            searchToolPath();
          } catch {
            throw new ServiceError(
              "packaged_search_tools_unavailable_reinstall_jared",
            );
          }
        },
  });
  const sockets = new Set<Socket>();
  let closing = false;
  let idleSince = Date.now();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    const handle = serveStdio(() => createMcpServer(service), {
      transport: new StdioServerTransport(socket, socket, {
        maxBufferSize: 64 * 1024,
      }),
      onerror: () => {},
    });
    socket.once("close", () => {
      sockets.delete(socket);
      idleSince = Date.now();
      void handle.close();
    });
  });
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    try {
      if (pathExists(path)) unlinkSync(path);
    } finally {
      await service.close();
    }
  };
  const timer = setInterval(() => {
    if (sockets.size || !service.isIdle()) idleSince = Date.now();
    else if (Date.now() - idleSince > 1500) void close();
  }, 250);
  try {
    if (pathExists(path)) {
      noSymlinks(path);
      const st = lstatSync(path);
      requireThat(
        st.isSocket() && st.uid === process.getuid?.(),
        "unsafe_worker_socket",
      );
      // Only the kernel-locked owner may remove a stale socket.
      unlinkSync(path);
    }
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(path, () => yes());
    });
    chmodSync(path, 0o600);
    return { service, close };
  } catch (e) {
    clearInterval(timer);
    await service.close();
    throw e;
  }
}
async function connect(path: string) {
  noSymlinks(path);
  const st = lstatSync(path);
  requireThat(
    st.isSocket() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0,
    "unsafe_worker_socket",
  );
  return new Promise<Socket>((yes, no) => {
    const socket = createConnection(path);
    socket.once("connect", () => yes(socket));
    socket.once("error", (e) => {
      socket.destroy();
      no(e);
    });
  });
}
export async function connectWorker(c: LocalConfig) {
  const path = socketPath(c);
  try {
    return await connect(path);
  } catch {
    /* Racing starters lose the kernel lock and exit; retry after that exit. */
  }
  const js = fileURLToPath(new URL("./worker-main.js", import.meta.url));
  let starting = false;
  let lastExit = "socket_unavailable";
  let nextSpawn = 0;
  const start = () => {
    starting = true;
    nextSpawn = Date.now() + 500;
    const child = spawn(process.execPath, [js], {
      detached: true,
      stdio: "ignore",
      cwd: c.stateDir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      },
    });
    child.once("error", () => {
      starting = false;
      lastExit = "spawn_error";
    });
    child.once("exit", (code, signal) => {
      starting = false;
      lastExit = signal ? `signal_${signal}` : `exit_${code}`;
    });
    child.unref();
  };
  start();
  for (let n = 0; n < 100; n++) {
    await delay(100);
    try {
      return await connect(path);
    } catch {
      /* Do not duplicate a slow live starter, but recover from lock races. */
      if (!starting && Date.now() >= nextSpawn && n < 99) start();
    }
  }
  throw new Error(`local_worker_start_failed_${lastExit}_run_jared_doctor`);
}
