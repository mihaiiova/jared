import { startWorker } from "./worker.js";
import { loadLocalConfig } from "./local-config.js";
process.umask(0o077);
try {
  const worker = await startWorker(loadLocalConfig());
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void worker.close().catch(() => {
        process.exitCode = 1;
      });
    });
} catch {
  process.exitCode = 1;
}
