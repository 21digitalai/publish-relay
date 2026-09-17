import { createStandaloneApplication } from '../application/create-application.js';
import { createCoreRuntime } from '../application/create-runtime-options.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';

const config = loadRuntimeConfig();
const runtime = await createCoreRuntime(config);
const application = createStandaloneApplication(runtime.options);
application.addHook('onClose', async () => runtime.close());
await application.listen({ host: config.HOST, port: config.PORT });
