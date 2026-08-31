import { loadRuntimeConfig } from '../config/runtime-config.js';

const config = loadRuntimeConfig();
const shutdownController = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdownController.abort();
  });
}

while (!shutdownController.signal.aborted) {
  await new Promise<void>((resolve) => setTimeout(resolve, config.WORKER_POLL_INTERVAL_MS));
}
