import { createApplication } from '../application/create-application.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';

const config = loadRuntimeConfig();
const application = createApplication(config);

await application.listen({ host: config.HOST, port: config.PORT });
