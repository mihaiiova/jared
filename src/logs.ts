import { setTimeout as delay } from "node:timers/promises";
import { jobLogsSchema } from "./contracts.js";
import { loadLocalConfig } from "./local-config.js";
import { Store } from "./store.js";

/** Observe retained state only: no worker launch, reconciliation, provider or retry. */
export async function logs(input: unknown, follow = false) {
  const args = jobLogsSchema.parse(input);
  const store = new Store(loadLocalConfig().stateDir, true);
  let after = args.after,
    lastStatus = 0;
  try {
    for (;;) {
      const page = store.jobLogs({ ...args, after });
      const active = ["queued", "running"].includes(page.execution);
      if (Date.now() - lastStatus >= 5000 || !active) {
        const { events: _events, ...status } = page;
        console.log(
          JSON.stringify({
            type: "status",
            observedAt: new Date().toISOString(),
            ...status,
          }),
        );
        lastStatus = Date.now();
      }
      for (const event of page.events)
        console.log(JSON.stringify({ type: "event", ...event }));
      after = page.nextCursor;
      if (!follow) return;
      if (page.hasMore) continue;
      if (!active) return; // stop_unconfirmed is displayed, never described as confirmed stop.
      await delay(1000);
    }
  } finally {
    store.close();
  }
}
