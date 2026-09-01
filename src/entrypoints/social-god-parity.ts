#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { buildSocialGodParity } from '../modules/parity/social-god.js';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: social-god-parity <snapshot.json>');

const input: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
process.stdout.write(`${JSON.stringify(buildSocialGodParity(input), null, 2)}\n`);
