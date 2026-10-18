import { readFile, readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { expect, it } from 'vitest';

import {
  getExposedPageCalendarJob,
  listExposedPageCalendarJobs,
} from '../src/modules/content/calendar-mirror.repository.js';
import { getBrowserJobDetail } from '../src/modules/content/post-read.repository.js';
import { setExposedPageCalendarVisibility } from '../src/modules/credentials/provider-account-exposure.service.js';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const a = id(801);
const b = id(802);
const c = id(803);
const account = id(804);
const owner = id(805);
const member = id(806);
const outsider = id(807);
const credential = id(808);
const connection = id(809);
const aJob = id(811);
const bJob = id(812);

it('projects one Page job across A/B/C with independent preferences and origin-only mutation', async () => {
  const database = new PGlite();
  try {
    const folder = new URL('../migrations/', import.meta.url);
    const names = (await readdir(folder)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const name of names) await database.exec(await readFile(new URL(name, folder), 'utf8'));
    await database.exec(`
      CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO publish_relay_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
      GRANT EXECUTE ON FUNCTION public.list_exposed_page_calendar_jobs(
        uuid, timestamptz, timestamptz, timestamptz, uuid, integer) TO publish_relay_app;
      GRANT EXECUTE ON FUNCTION public.get_exposed_page_calendar_job(uuid, uuid)
        TO publish_relay_app;
      GRANT EXECUTE ON FUNCTION public.set_exposed_page_calendar_visibility(uuid, uuid, boolean)
        TO publish_relay_app;
      INSERT INTO users (id, display_name, email, password_hash) VALUES
        ('${owner}', 'Owner', 'owner-matrix@example.test', 'hash'),
        ('${member}', 'Member', 'member-matrix@example.test', 'hash'),
        ('${outsider}', 'Outsider', 'outsider-matrix@example.test', 'hash');
      INSERT INTO workspaces (id, name, slug) VALUES
        ('${a}', 'A', 'a-matrix'), ('${b}', 'B', 'b-matrix'), ('${c}', 'C', 'c-matrix');
      INSERT INTO memberships (workspace_id, user_id, role) VALUES
        ('${a}', '${owner}', 'owner'), ('${b}', '${owner}', 'owner'),
        ('${c}', '${owner}', 'owner'), ('${b}', '${member}', 'editor');
      INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
        wrapped_key_tag, ciphertext, nonce, tag) VALUES
        ('${credential}', '${a}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
      INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status)
        VALUES ('${connection}', '${a}', 'meta', '${credential}', 'active');
      INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id,
        destination_provider, remote_account_id, display_name)
        VALUES ('${account}', '${a}', '${connection}', 'page', 'facebook_page', 'page', 'Page');
      INSERT INTO provider_account_exposures (workspace_id, provider_account_id)
        VALUES ('${b}', '${account}'), ('${c}', '${account}');
    `);
    for (const [workspace, job, content] of [
      [a, aJob, 'A post'],
      [b, bJob, 'B post'],
    ] as const) {
      await database.exec(`
        INSERT INTO posts (id, workspace_id, created_by_user_id)
          VALUES ('${id(Number(job.slice(-12)) + 10)}', '${workspace}', '${owner}');
        INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
          VALUES ('${id(Number(job.slice(-12)) + 20)}', '${workspace}',
            '${id(Number(job.slice(-12)) + 10)}', 1, '{"kind":"link","text":"${content}","linkUrl":"https://example.test/"}');
        INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id,
          provider_account_id, scheduled_at)
          VALUES ('${job}', '${workspace}', '${id(Number(job.slice(-12)) + 10)}',
            '${id(Number(job.slice(-12)) + 20)}', '${account}', '2026-10-25T01:30:00Z');
      `);
    }
    const db = drizzle(database) as unknown as NodePgDatabase;
    const mirrored = async (workspaceId: string, userId = owner) =>
      (
        await listExposedPageCalendarJobs(db, {
          workspaceId,
          userId,
          startsAt: new Date('2026-10-25T00:00:00Z'),
          endsAt: new Date('2026-10-26T00:00:00Z'),
          limit: 100,
        })
      ).map((job) => ({ id: job.id, origin: job.originWorkspaceName }));
    const visibility = (workspaceId: string, showPosts: boolean, userId = owner) =>
      setExposedPageCalendarVisibility(db, {
        workspaceId,
        userId,
        accountId: account,
        showPosts,
      });

    expect(await mirrored(a)).toEqual([{ id: bJob, origin: 'B' }]);
    expect(await mirrored(b)).toEqual([{ id: aJob, origin: 'A' }]);
    expect(await mirrored(c)).toEqual([
      { id: aJob, origin: 'A' },
      { id: bJob, origin: 'B' },
    ]);
    expect(await mirrored(b, member)).toEqual([{ id: aJob, origin: 'A' }]);
    expect(await mirrored(c, member)).toEqual([]);
    expect(await mirrored(b, outsider)).toEqual([]);
    expect(
      await getExposedPageCalendarJob(db, { workspaceId: c, userId: member, jobId: aJob }),
    ).toBeNull();
    expect(await getBrowserJobDetail(db, b, aJob, owner)).toBeNull();
    expect(await getBrowserJobDetail(db, b, bJob, owner)).toMatchObject({ id: bJob });
    expect(await visibility(a, false)).toBe(true);
    expect(await visibility(b, false, member)).toBe(false);
    expect(await visibility(b, false)).toBe(true);
    expect(await mirrored(a)).toEqual([]);
    expect(await mirrored(b)).toEqual([]);
    expect(await mirrored(c)).toHaveLength(2);
    expect(
      await getExposedPageCalendarJob(db, { workspaceId: a, userId: owner, jobId: bJob }),
    ).toBeNull();
    expect(await getBrowserJobDetail(db, a, aJob, owner)).toMatchObject({ id: aJob });
    expect(await getBrowserJobDetail(db, b, bJob, owner)).toMatchObject({ id: bJob });
    expect(await visibility(a, true)).toBe(true);
    expect(await visibility(b, true)).toBe(true);
    expect(await mirrored(a)).toHaveLength(1);
    expect(await mirrored(b)).toHaveLength(1);

    await database.exec(`UPDATE provider_account_exposures SET revoked_at = now()
      WHERE workspace_id = '${c}' AND provider_account_id = '${account}'`);
    expect(await mirrored(c)).toEqual([]);
    expect(
      await getExposedPageCalendarJob(db, { workspaceId: c, userId: owner, jobId: aJob }),
    ).toBeNull();
    expect(await mirrored(a)).toHaveLength(1);
    expect(await mirrored(b)).toHaveLength(1);
    expect((await database.query('SELECT id FROM provider_accounts')).rows).toHaveLength(1);
    expect((await database.query('SELECT id FROM publication_jobs')).rows).toHaveLength(2);
  } finally {
    await database.close();
  }
});
