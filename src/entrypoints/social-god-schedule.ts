import { readFile } from 'node:fs/promises';

import {
  scheduleSocialGodSnapshot,
  type SocialGodRelayTarget,
} from '../modules/parity/social-god.js';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: social-god-schedule <snapshot.json>');
const target = (process.env.PUBLISH_RELAY_SCHEDULER_TARGET ?? 'dry-run') as SocialGodRelayTarget;
if (!['dry-run', 'publish-relay'].includes(target))
  throw new Error('PUBLISH_RELAY_SCHEDULER_TARGET must be dry-run or publish-relay');

const snapshot = JSON.parse(await readFile(inputPath, 'utf8')) as unknown;
const result = await scheduleSocialGodSnapshot(snapshot, {
  target,
  ...(process.env.PUBLISH_RELAY_BASE_URL ? { baseUrl: process.env.PUBLISH_RELAY_BASE_URL } : {}),
  ...(process.env.PUBLISH_RELAY_WORKSPACE
    ? { workspace: process.env.PUBLISH_RELAY_WORKSPACE }
    : {}),
  ...(process.env.PUBLISH_RELAY_API_KEY ? { apiKey: process.env.PUBLISH_RELAY_API_KEY } : {}),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
