import { readFile, readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import { claimDueJobs } from '../src/modules/scheduler/job.repository.js';
import {
  getExposedPageCalendarJob,
  getExposedPageCalendarMedia,
} from '../src/modules/content/calendar-mirror.repository.js';
import { listFacebookPageOccupancy } from '../src/modules/content/page-occupancy.repository.js';
import {
  getBrowserJobDetail,
  getJobDetail,
  listBrowserJobSummaries,
} from '../src/modules/content/post-read.repository.js';
import { editFacebookPageExposure } from '../src/modules/credentials/provider-account-exposure.service.js';
import { listFacebookPageExposureTargets } from '../src/modules/credentials/provider-account-exposure.service.js';
import { setExposedPageCalendarVisibility } from '../src/modules/credentials/provider-account-exposure.service.js';
import {
  createPost,
  createPostInTransaction,
  editPost,
  validatePostCandidate,
} from '../src/modules/content/post.service.js';
import { executeIdempotentMutation } from '../src/modules/api/idempotency.repository.js';
import { disconnectProviderSubject } from '../src/modules/credentials/provider-subject.service.js';
import { revokeMetaConnection } from '../src/modules/providers/meta-oauth.service.js';
import {
  listProviderAccounts,
  listProviderAccountsPage,
} from '../src/modules/credentials/provider-account.service.js';

const origin = '00000000-0000-4000-8000-000000000101';
const target = '00000000-0000-4000-8000-000000000102';
const account = '00000000-0000-4000-8000-000000000103';
const user = '00000000-0000-4000-8000-000000000104';
const connection = '00000000-0000-4000-8000-000000000105';
const post = '00000000-0000-4000-8000-000000000106';
const revision = '00000000-0000-4000-8000-000000000107';
const credential = '00000000-0000-4000-8000-000000000108';
const nonOwner = '00000000-0000-4000-8000-000000000109';
const outsider = '00000000-0000-4000-8000-000000000110';
const apiKey = '00000000-0000-4000-8000-000000000111';
const delegatedGrant = '00000000-0000-4000-8000-000000000112';

describe('provider account exposure migration', () => {
  it('grants only to a shared owner, guards active jobs, and preserves a revoked row', async () => {
    const database = new PGlite();
    try {
      const folder = new URL('../migrations/', import.meta.url);
      const names = (await readdir(folder)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      for (const name of names) await database.exec(await readFile(new URL(name, folder), 'utf8'));
      await database.exec(`
        CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
        GRANT USAGE ON SCHEMA public TO publish_relay_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.edit_facebook_page_exposure(uuid, uuid, uuid, boolean, text)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.provider_account_has_active_jobs(uuid, uuid)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.resolve_exposed_post_accounts(uuid, uuid[], boolean)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.list_visible_exposed_facebook_pages(uuid)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.list_visible_exposed_facebook_pages_page(uuid, text, uuid, integer)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.list_facebook_page_exposure_targets(uuid, uuid, uuid, integer)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.resolve_browser_job_account(uuid, uuid)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.list_exposed_page_calendar_jobs(
          uuid, timestamptz, timestamptz, timestamptz, uuid, integer)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.list_facebook_page_occupancy(
          uuid, uuid, timestamptz, timestamptz, timestamptz, integer)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.set_exposed_page_calendar_visibility(uuid, uuid, boolean)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.get_exposed_page_calendar_job(uuid, uuid)
          TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.get_exposed_page_calendar_media(uuid, uuid, uuid)
          TO publish_relay_app;
        INSERT INTO users (id, display_name, email, password_hash)
          VALUES ('${user}', 'Owner', 'owner@example.test', 'hash'),
            ('${nonOwner}', 'Editor', 'editor@example.test', 'hash'),
            ('${outsider}', 'Outsider', 'outsider@example.test', 'hash');
        INSERT INTO workspaces (id, name, slug) VALUES
          ('${origin}', 'Origin', 'origin'), ('${target}', 'Target', 'target');
        INSERT INTO memberships (workspace_id, user_id, role) VALUES
          ('${origin}', '${user}', 'owner'), ('${target}', '${user}', 'owner'),
          ('${origin}', '${nonOwner}', 'editor'), ('${target}', '${nonOwner}', 'owner');
        INSERT INTO api_keys
          (id, workspace_id, created_by_user_id, label, prefix, secret_hash, capabilities)
          VALUES ('${apiKey}', '${target}', '${outsider}', 'Machine', 'machine-test', 'hash',
            ARRAY['schedules:read', 'schedules:write']);
        INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
          VALUES ('test-client', 'Test', 'public', ARRAY['https://example.test/callback'],
            ARRAY['schedules:read', 'schedules:write']);
        INSERT INTO delegated_grants (id, workspace_id, user_id, client_id, scopes)
          VALUES ('${delegatedGrant}', '${target}', '${outsider}', 'test-client',
            ARRAY['schedules:read', 'schedules:write']);
        INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
          wrapped_key_tag, ciphertext, nonce, tag)
          VALUES ('${credential}', '${origin}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status, scopes)
          VALUES ('${connection}', '${origin}', 'meta', '${credential}', 'active', '["pages_manage_posts"]');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name, adapter_defaults)
          VALUES ('${account}', '${origin}', '${connection}', 'page', 'facebook_page', 'page', 'Page', '{"originOnly":true}');
        SELECT set_config('app.workspace_id', '${origin}', false);
        SET ROLE publish_relay_app;
      `);
      const edit = (expose: boolean) =>
        database.query<{ result: string }>(
          `SELECT public.edit_facebook_page_exposure('${origin}', '${target}', '${account}', ${String(expose)}, 'test-request') AS result`,
        );
      expect((await edit(true)).rows[0]?.result).toBe('unavailable');
      await database.exec(`SELECT set_config('app.user_id', '${nonOwner}', false)`);
      expect((await edit(true)).rows[0]?.result).toBe('unavailable');
      const scheduleIn = (workspaceId: string, userId: string) =>
        createPost(drizzle(database) as unknown as NodePgDatabase, {
          workspaceId,
          userId,
          providerAccountIds: [account],
          mediaIds: [],
          content: { kind: 'link', text: 'Cross-workspace Page', linkUrl: 'https://example.test/' },
          scheduledAt: new Date('2026-10-19T10:00:00Z'),
        });
      const targetPost = (userId: string) => scheduleIn(target, userId);
      await expect(targetPost(user)).rejects.toThrow('do not belong to the workspace');
      expect(
        await editFacebookPageExposure(drizzle(database) as unknown as NodePgDatabase, {
          originWorkspaceId: origin,
          targetWorkspaceId: target,
          accountId: account,
          userId: user,
          requestId: 'service-request',
          expose: true,
        }),
      ).toBe('updated');
      expect(
        await listFacebookPageExposureTargets(drizzle(database) as unknown as NodePgDatabase, {
          originWorkspaceId: origin,
          accountId: account,
          userId: user,
        }),
      ).toEqual({ workspaceIds: [target], nextCursor: null });
      expect(
        await listFacebookPageExposureTargets(drizzle(database) as unknown as NodePgDatabase, {
          originWorkspaceId: origin,
          accountId: account,
          userId: outsider,
        }),
      ).toEqual({ workspaceIds: [], nextCursor: null });
      await database.exec(`SELECT set_config('app.user_id', '${user}', false)`);
      expect((await edit(true)).rows[0]?.result).toBe('unchanged');
      await database.exec(`SELECT set_config('app.workspace_id', '${target}', false)`);
      await database.exec(`SELECT set_config('app.user_id', '', false)`);
      const machineCandidate = {
        workspaceId: target,
        providerAccountIds: [account],
        mediaIds: [],
        content: { kind: 'link', text: 'Machine shared Page', linkUrl: 'https://example.test/' },
        scheduledAt: new Date('2026-10-19T09:00:00Z'),
      };
      for (const actor of [
        { type: 'api-key' as const, id: apiKey },
        { type: 'delegated' as const, id: delegatedGrant },
      ]) {
        const machineActor = { ...actor, capability: 'schedules:read' as const };
        const validation = await validatePostCandidate(
          drizzle(database) as unknown as NodePgDatabase,
          { ...machineCandidate, machineActor },
        );
        expect(validation.valid).toBe(true);
        const result = await executeIdempotentMutation(
          drizzle(database) as unknown as NodePgDatabase,
          {
            workspaceId: target,
            actor,
            operation: 'posts.create',
            idempotencyKey: `machine-${actor.type}`,
            requestFingerprint: `fingerprint-${actor.type}`,
            machineCapability: 'schedules:write',
          },
          async (transaction) => {
            const created = await createPostInTransaction(transaction, {
              ...machineCandidate,
              userId: outsider,
              actor,
            });
            return { statusCode: 201, body: created };
          },
        );
        expect(result.kind).toBe('executed');
      }
      const browserDb = drizzle(database) as unknown as NodePgDatabase;
      const targetJobs = await listBrowserJobSummaries(browserDb, {
        workspaceId: target,
        userId: user,
        limit: 10,
      });
      expect(targetJobs).toHaveLength(2);
      expect(targetJobs[0]?.providerAccount).toMatchObject({
        id: account,
        displayName: 'Page',
        provider: 'meta',
        originWorkspaceName: 'Origin',
        handle: null,
      });
      const firstTargetJob = targetJobs[0];
      if (!firstTargetJob) throw new Error('Expected a target-owned Page job');
      expect(await getBrowserJobDetail(browserDb, target, firstTargetJob.id, user)).toMatchObject({
        id: firstTargetJob.id,
        providerAccount: { id: account },
      });
      expect(
        await listBrowserJobSummaries(browserDb, {
          workspaceId: target,
          userId: outsider,
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        await listBrowserJobSummaries(browserDb, {
          workspaceId: target,
          limit: 10,
        }),
      ).toEqual([]);
      for (const actor of [
        { type: 'api-key' as const, id: apiKey },
        { type: 'delegated' as const, id: delegatedGrant },
      ]) {
        const detail = await getJobDetail(browserDb, target, firstTargetJob.id, {
          ...actor,
          capability: 'schedules:read',
        });
        expect(detail?.providerAccount).toMatchObject({
          id: account,
          originWorkspaceName: 'Origin',
          handle: null,
        });
        expect(JSON.stringify(detail)).not.toMatch(/credentialId|remoteAccountId|accessToken/);
      }
      expect(
        await getJobDetail(browserDb, target, firstTargetJob.id, {
          type: 'api-key',
          id: outsider,
          capability: 'schedules:read',
        }),
      ).toBeNull();
      for (const actor of [
        { type: 'api-key' as const, id: outsider },
        { type: 'delegated' as const, id: outsider },
      ]) {
        await expect(
          validatePostCandidate(drizzle(database) as unknown as NodePgDatabase, {
            ...machineCandidate,
            machineActor: { ...actor, capability: 'schedules:read' },
          }),
        ).resolves.toMatchObject({ valid: false });
        await expect(
          executeIdempotentMutation(
            drizzle(database) as unknown as NodePgDatabase,
            {
              workspaceId: target,
              actor,
              operation: 'posts.create',
              idempotencyKey: `invalid-${actor.type}`,
              requestFingerprint: `invalid-${actor.type}`,
              machineCapability: 'schedules:write',
            },
            async (transaction) => ({
              statusCode: 201,
              body: await createPostInTransaction(transaction, {
                ...machineCandidate,
                userId: outsider,
                actor,
              }),
            }),
          ),
        ).rejects.toThrow('do not belong to the workspace');
      }
      await database.exec(`SELECT set_config('app.user_id', '${user}', false)`);
      const projection = await database.query<{ scopes: unknown; adapter_defaults: unknown }>(
        `SELECT scopes, adapter_defaults FROM public.resolve_exposed_post_accounts(
          '${target}', ARRAY['${account}']::uuid[], false)`,
      );
      expect(projection.rows).toEqual([{ scopes: [], adapter_defaults: {} }]);
      const visible = await listProviderAccounts(
        drizzle(database) as unknown as NodePgDatabase,
        target,
        user,
      );
      expect(visible).toEqual([
        expect.objectContaining({
          id: account,
          destinationProvider: 'facebook_page',
          originWorkspaceName: 'Origin',
          isExposed: true,
        }),
      ]);
      expect(JSON.stringify(visible)).not.toContain('pages_manage_posts');
      expect(JSON.stringify(visible)).not.toContain('originOnly');
      await expect(targetPost(outsider)).rejects.toThrow('do not belong to the workspace');
      const scheduled = await targetPost(user);
      expect(scheduled.jobIds).toHaveLength(1);
      const revised = await editPost(drizzle(database) as unknown as NodePgDatabase, {
        workspaceId: target,
        userId: user,
        postId: scheduled.postId,
        providerAccountIds: [account],
        mediaIds: [],
        content: { kind: 'link', text: 'Revised shared Page', linkUrl: 'https://example.test/' },
        scheduledAt: new Date('2026-10-19T11:00:00Z'),
      });
      expect(revised.supersededJobIds).toEqual(scheduled.jobIds);
      expect(revised.jobIds).toHaveLength(1);
      const originScheduled = await scheduleIn(origin, user);
      expect(originScheduled.jobIds).toHaveLength(1);
      const originJobId = originScheduled.jobIds[0];
      if (!originJobId) throw new Error('Expected origin job');
      const mirroredMediaId = '00000000-0000-4000-8000-000000000599';
      await database.exec('RESET ROLE');
      const originRevision = await database.query<{ revision_id: string }>(`
        SELECT revision_id FROM publication_jobs WHERE id = '${originJobId}'`);
      if (!originRevision.rows[0]) throw new Error('Expected origin revision');
      await database.exec(`INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${mirroredMediaId}', '${origin}', 'origin/private.jpg', 'test-hash', 'image/jpeg', 10, 'ready');
        INSERT INTO revision_media (workspace_id, revision_id, media_id, position)
        VALUES ('${origin}', '${originRevision.rows[0].revision_id}', '${mirroredMediaId}', 0);
        SET ROLE publish_relay_app;`);
      await database.exec(`SELECT set_config('app.workspace_id', '${target}', false)`);
      const mirror = (startsAt = '2026-10-19T00:00:00Z') =>
        database
          .query<{ id: string; provider_account_id: string; origin_workspace_name: string }>(
            `
          SELECT id, provider_account_id, origin_workspace_name
          FROM public.list_exposed_page_calendar_jobs(
            '${target}', '${startsAt}', '2026-10-20T00:00:00Z', NULL, NULL, 100)
        `,
          )
          .then((result) => result.rows);
      await database.exec(`SELECT set_config('app.user_id', '${user}', false)`);
      expect(await mirror()).toEqual([
        {
          id: originScheduled.jobIds[0],
          provider_account_id: account,
          origin_workspace_name: 'Origin',
        },
      ]);
      const mirroredDetail = () =>
        getExposedPageCalendarJob(browserDb, {
          workspaceId: target,
          userId: user,
          jobId: originScheduled.jobIds[0] ?? '',
        });
      expect(await mirroredDetail()).toMatchObject({
        id: originScheduled.jobIds[0],
        originWorkspaceName: 'Origin',
        providerAccountId: account,
        caption: 'Cross-workspace Page',
        media: [{ id: mirroredMediaId, mimeType: 'image/jpeg', byteSize: 10, ready: true }],
      });
      expect(JSON.stringify(await mirroredDetail())).not.toMatch(
        /credential|storageKey|remoteAccount/,
      );
      const mirroredMedia = () =>
        getExposedPageCalendarMedia(browserDb, {
          workspaceId: target,
          userId: user,
          jobId: originScheduled.jobIds[0] ?? '',
          mediaId: mirroredMediaId,
        });
      expect(await mirroredMedia()).toEqual({
        storageKey: 'origin/private.jpg',
        mimeType: 'image/jpeg',
        byteSize: 10,
      });
      const occupancy = (viewer: string, workspaceId = target) =>
        listFacebookPageOccupancy(browserDb, {
          workspaceId,
          userId: viewer,
          accountId: account,
          startsAt: new Date('2026-10-19T00:00:00Z'),
          endsAt: new Date('2026-10-20T00:00:00Z'),
          limit: 100,
        });
      const targetOccupancy = await occupancy(user);
      expect(targetOccupancy).toEqual(
        expect.arrayContaining([
          { scheduledAt: new Date('2026-10-19T10:00:00Z'), jobCount: 1 },
          { scheduledAt: new Date('2026-10-19T11:00:00Z'), jobCount: 1 },
        ]),
      );
      expect(await occupancy(user, origin)).toEqual(targetOccupancy);
      expect(JSON.stringify(targetOccupancy)).not.toMatch(/jobId|workspaceId|caption|credential/);
      const firstOccupancyPage = await listFacebookPageOccupancy(browserDb, {
        workspaceId: target,
        userId: user,
        accountId: account,
        startsAt: new Date('2026-10-19T00:00:00Z'),
        endsAt: new Date('2026-10-20T00:00:00Z'),
        limit: 1,
      });
      expect(firstOccupancyPage).toHaveLength(1);
      const firstOccupiedInstant = firstOccupancyPage[0];
      if (!firstOccupiedInstant) throw new Error('Expected Page occupancy');
      const nextOccupancyPage = await listFacebookPageOccupancy(browserDb, {
        workspaceId: target,
        userId: user,
        accountId: account,
        startsAt: new Date('2026-10-19T00:00:00Z'),
        endsAt: new Date('2026-10-20T00:00:00Z'),
        beforeScheduledAt: firstOccupiedInstant.scheduledAt,
        limit: 1,
      });
      expect(nextOccupancyPage).toHaveLength(1);
      expect(nextOccupancyPage[0]?.scheduledAt.getTime()).toBeLessThan(
        firstOccupancyPage[0]?.scheduledAt.getTime() ?? 0,
      );
      expect(
        await listFacebookPageOccupancy(browserDb, {
          workspaceId: target,
          userId: user,
          accountId: apiKey,
          startsAt: new Date('2026-10-19T00:00:00Z'),
          endsAt: new Date('2026-10-20T00:00:00Z'),
          limit: 100,
        }),
      ).toEqual([]);
      expect(
        await getExposedPageCalendarMedia(browserDb, {
          workspaceId: target,
          userId: user,
          jobId: firstTargetJob.id,
          mediaId: mirroredMediaId,
        }),
      ).toBeNull();
      await database.exec(`SELECT set_config('app.user_id', '${nonOwner}', false)`);
      expect(await mirror()).toHaveLength(1);
      expect(await occupancy(nonOwner)).toEqual(targetOccupancy);
      await database.exec(`SELECT set_config('app.user_id', '${outsider}', false)`);
      expect(await mirror()).toEqual([]);
      expect(await occupancy(outsider)).toEqual([]);
      expect(
        await getExposedPageCalendarJob(browserDb, {
          workspaceId: target,
          userId: outsider,
          jobId: originScheduled.jobIds[0] ?? '',
        }),
      ).toBeNull();
      expect(
        await getExposedPageCalendarMedia(browserDb, {
          workspaceId: target,
          userId: outsider,
          jobId: originScheduled.jobIds[0] ?? '',
          mediaId: mirroredMediaId,
        }),
      ).toBeNull();
      await database.exec(`SELECT set_config('app.user_id', '${user}', false)`);
      expect(await mirror('2026-10-19T11:00:00Z')).toEqual([]);
      const setVisibility = (viewer: string, showPosts: boolean) =>
        setExposedPageCalendarVisibility(browserDb, {
          workspaceId: target,
          userId: viewer,
          accountId: account,
          showPosts,
        });
      expect(await setVisibility(outsider, false)).toBe(false);
      expect(await setVisibility(user, false)).toBe(true);
      expect(await mirror()).toEqual([]);
      expect(await occupancy(user)).toEqual(targetOccupancy);
      expect(await mirroredDetail()).toBeNull();
      expect(await mirroredMedia()).toBeNull();
      expect(
        (await listProviderAccountsPage(browserDb, target, user)).accounts.find(
          (item) => item.id === account,
        )?.showOtherWorkspacePosts,
      ).toBe(false);
      expect(await setVisibility(user, true)).toBe(true);
      expect(await mirror()).toHaveLength(1);
      expect(
        (await database.query('SELECT provider_account_id FROM provider_account_exposures')).rows,
      ).toEqual([{ provider_account_id: account }]);
      await database.exec(`SELECT set_config('app.workspace_id', '${origin}', false)`);
      const activeJobs = () =>
        database.query<{ active: boolean }>(
          `SELECT public.provider_account_has_active_jobs('${origin}', '${account}') AS active`,
        );
      expect((await activeJobs()).rows[0]?.active).toBe(true);
      expect((await edit(false)).rows[0]?.result).toBe('active_jobs');
      await expect(
        revokeMetaConnection(
          drizzle(database) as unknown as NodePgDatabase,
          {} as never,
          {} as never,
          { workspaceId: origin, userId: user, accountId: account, requestId: 'revoke-test' },
        ),
      ).rejects.toThrow('Cancel or resolve scheduled publications');
      const subject = await database.query<{ external_subject_id: string }>(
        `SELECT external_subject_id FROM provider_connections WHERE id = '${connection}'`,
      );
      if (!subject.rows[0]) throw new Error('Connection fixture missing');
      await expect(
        disconnectProviderSubject(drizzle(database) as unknown as NodePgDatabase, {
          workspaceId: origin,
          userId: user,
          provider: 'meta',
          externalSubjectId: subject.rows[0].external_subject_id,
          requestId: 'disconnect-test',
        }),
      ).rejects.toThrow('Scheduled publications must be resolved');
      await database.exec(`RESET ROLE;
        UPDATE publication_jobs SET state = 'published'
          WHERE workspace_id IN ('${target}', '${origin}');
        SET ROLE publish_relay_app;`);
      expect((await activeJobs()).rows[0]?.active).toBe(false);
      expect((await edit(false)).rows[0]?.result).toBe('updated');
      await database.exec(`SELECT set_config('app.workspace_id', '${target}', false)`);
      expect(await mirror()).toEqual([]);
      expect(await mirroredDetail()).toBeNull();
      expect(await mirroredMedia()).toBeNull();
      await database.exec(`SELECT set_config('app.workspace_id', '${origin}', false)`);
      expect(
        await listProviderAccounts(drizzle(database) as unknown as NodePgDatabase, target, user),
      ).toEqual([]);
      await expect(targetPost(user)).rejects.toThrow('do not belong to the workspace');
      await expect(
        editPost(drizzle(database) as unknown as NodePgDatabase, {
          workspaceId: target,
          userId: user,
          postId: scheduled.postId,
          providerAccountIds: [account],
          mediaIds: [],
          content: { kind: 'link', text: 'Denied revision', linkUrl: 'https://example.test/' },
          scheduledAt: new Date('2026-10-19T12:00:00Z'),
        }),
      ).rejects.toThrow('do not belong to the workspace');
      expect((await edit(true)).rows[0]?.result).toBe('updated');
      await database.exec('RESET ROLE');
      const rows = await database.query<{ count: number; preference: boolean }>(
        `SELECT count(*)::int AS count, bool_and(show_other_workspace_posts) AS preference
         FROM provider_account_exposures WHERE workspace_id = '${target}'`,
      );
      expect(rows.rows).toEqual([{ count: 1, preference: true }]);
      await database.exec(`
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider,
            remote_account_id, display_name)
        SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
          '${origin}', '${connection}', 'page-' || g, 'facebook_page', 'page-' || g,
          'Page ' || lpad(g::text, 3, '0')
        FROM generate_series(200, 300) AS g;
        INSERT INTO provider_account_exposures (workspace_id, provider_account_id)
        SELECT '${target}', ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid
        FROM generate_series(200, 300) AS g;
        SET ROLE publish_relay_app;
      `);
      const pagedDb = drizzle(database) as unknown as NodePgDatabase;
      const first = await listProviderAccountsPage(pagedDb, target, user);
      expect(first.accounts).toHaveLength(100);
      if (!first.nextCursor) throw new Error('Expected a second account page');
      const second = await listProviderAccountsPage(pagedDb, target, user, first.nextCursor);
      expect(second.accounts).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.accounts, ...second.accounts].map((item) => item.id)).size).toBe(
        102,
      );
      expect((await listProviderAccountsPage(pagedDb, target, outsider)).accounts).toEqual([]);
      expect(JSON.stringify([...first.accounts, ...second.accounts])).not.toContain(
        'pages_manage_posts',
      );
      await database.exec(`
        RESET ROLE;
        INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
          wrapped_key_tag, ciphertext, nonce, tag)
          VALUES ('00000000-0000-4000-8000-000000000501', '${target}', 'v1',
            '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
          VALUES ('00000000-0000-4000-8000-000000000502', '${target}', 'x',
            '00000000-0000-4000-8000-000000000501');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider,
            remote_account_id, display_name)
        SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
          '${target}', '00000000-0000-4000-8000-000000000502', 'local-' || g, 'x',
          'local-' || g, 'Local ' || lpad(g::text, 3, '0')
        FROM generate_series(400, 500) AS g;
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id, member_urn)
          VALUES ('00000000-0000-4000-8000-000000000503', '${target}', 'linkedin',
            '00000000-0000-4000-8000-000000000501', 'urn:li:person:late');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider,
            remote_account_id, display_name)
          VALUES ('00000000-0000-4000-8000-000000000504', '${target}',
            '00000000-0000-4000-8000-000000000503', 'linkedin-member', 'linkedin',
            'linkedin-member', 'Late LinkedIn');
        SET ROLE publish_relay_app;
      `);
      const pages = [];
      let cursor: string | null = null;
      do {
        const batch = await listProviderAccountsPage(pagedDb, target, user, cursor ?? undefined);
        expect(batch.accounts.length).toBeLessThanOrEqual(100);
        pages.push(...batch.accounts);
        cursor = batch.nextCursor;
      } while (cursor);
      expect(pages).toHaveLength(204);
      expect(new Set(pages.map((item) => item.id)).size).toBe(204);
      const linkedInPage = await listProviderAccountsPage(
        pagedDb,
        target,
        user,
        undefined,
        'linkedin',
      );
      expect(linkedInPage.accounts.map((item) => item.displayName)).toEqual(['Late LinkedIn']);
      expect(linkedInPage.nextCursor).toBeNull();
    } finally {
      await database.close();
    }
  });

  it('backfills an existing account and its historical job without changing their IDs', async () => {
    const database = new PGlite();
    try {
      const folder = new URL('../migrations/', import.meta.url);
      const names = (await readdir(folder))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) < 59)
        .sort();
      for (const name of names) await database.exec(await readFile(new URL(name, folder), 'utf8'));
      await database.exec(`
        INSERT INTO users (id, display_name, email, password_hash)
          VALUES ('${user}', 'Owner', 'owner@example.test', 'hash');
        INSERT INTO workspaces (id, name, slug) VALUES ('${origin}', 'Origin', 'origin');
        INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
          wrapped_key_tag, ciphertext, nonce, tag)
          VALUES ('${credential}', '${origin}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status)
          VALUES ('${connection}', '${origin}', 'meta', '${credential}', 'active');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
          VALUES ('${account}', '${origin}', '${connection}', 'page', 'facebook_page', 'page', 'Page');
        INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${post}', '${origin}', '${user}');
        INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
          VALUES ('${revision}', '${origin}', '${post}', 1, '{"kind":"text","text":"hello"}');
        INSERT INTO publication_jobs (workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
          VALUES ('${origin}', '${post}', '${revision}', '${account}', '2026-10-19T10:00:00Z');
      `);
      await database.exec(
        await readFile(
          new URL('../migrations/0059_provider_account_exposures.sql', import.meta.url),
          'utf8',
        ),
      );
      const rows = await database.query<{
        workspace_id: string;
        provider_account_id: string;
        show_other_workspace_posts: boolean;
      }>(
        'SELECT workspace_id, provider_account_id, show_other_workspace_posts FROM provider_account_exposures',
      );
      expect(rows.rows).toEqual([
        { workspace_id: origin, provider_account_id: account, show_other_workspace_posts: true },
      ]);
      expect(
        (await database.query('SELECT provider_account_id FROM publication_jobs')).rows,
      ).toEqual([{ provider_account_id: account }]);
    } finally {
      await database.close();
    }
  });

  it('keeps one origin account, admits a target-owned job, and hides the origin under RLS', async () => {
    const database = new PGlite();
    try {
      const folder = new URL('../migrations/', import.meta.url);
      const names = (await readdir(folder)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      for (const name of names) await database.exec(await readFile(new URL(name, folder), 'utf8'));
      await database.exec(`
        CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
        GRANT USAGE ON SCHEMA public TO publish_relay_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
        INSERT INTO users (id, display_name, email, password_hash)
          VALUES ('${user}', 'Owner', 'owner@example.test', 'hash');
        INSERT INTO workspaces (id, name, slug) VALUES
          ('${origin}', 'Origin', 'origin'), ('${target}', 'Target', 'target');
        INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
          wrapped_key_tag, ciphertext, nonce, tag)
          VALUES ('${credential}', '${origin}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status)
          VALUES ('${connection}', '${origin}', 'meta', '${credential}', 'active');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
          VALUES ('${account}', '${origin}', '${connection}', 'page', 'facebook_page', 'page', 'Page');
        INSERT INTO provider_account_exposures (workspace_id, provider_account_id)
          VALUES ('${target}', '${account}');
        INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${post}', '${target}', '${user}');
        INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
          VALUES ('${revision}', '${target}', '${post}', 1, '{"kind":"text","text":"hello"}');
        SELECT set_config('app.workspace_id', '${target}', false);
        SET ROLE publish_relay_app;
        INSERT INTO publication_jobs (workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
          VALUES ('${target}', '${post}', '${revision}', '${account}', '2026-10-19T10:00:00Z');
      `);
      const exposures = await database.query<{
        workspace_id: string;
        show_other_workspace_posts: boolean;
      }>(
        'SELECT workspace_id, show_other_workspace_posts FROM provider_account_exposures ORDER BY workspace_id',
      );
      expect(exposures.rows).toEqual([{ workspace_id: target, show_other_workspace_posts: true }]);
      expect((await database.query('SELECT id FROM provider_accounts')).rows).toEqual([]);
      expect((await database.query('SELECT id FROM publication_jobs')).rows).toHaveLength(1);
      await database.exec('RESET ROLE');
      const claimed = await claimDueJobs(drizzle(database) as unknown as NodePgDatabase, {
        workerId: 'exposure-test',
        now: new Date('2026-10-20T10:00:00Z'),
        leaseMs: 30_000,
        limit: 1,
        destinationProvider: 'facebook_page',
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.workspaceId).toBe(target);
      await database.exec('SET ROLE publish_relay_app');
      await expect(
        database.exec(`INSERT INTO provider_account_exposures
        (workspace_id, provider_account_id) VALUES ('${target}', '${account}')`),
      ).rejects.toThrow();
      await database.exec(`RESET ROLE;
        UPDATE provider_account_exposures SET revoked_at = now()
          WHERE workspace_id = '${target}' AND provider_account_id = '${account}';
        UPDATE publication_jobs SET state = 'scheduled', lease_owner = NULL, lease_expires_at = NULL
          WHERE workspace_id = '${target}';
        SET ROLE publish_relay_app;`);
      expect((await database.query('SELECT id FROM publication_jobs')).rows).toHaveLength(1);
      await database.exec('RESET ROLE');
      const revokedClaims = await claimDueJobs(drizzle(database) as unknown as NodePgDatabase, {
        workerId: 'exposure-test-again',
        now: new Date('2026-10-20T10:00:00Z'),
        leaseMs: 30_000,
        limit: 1,
        destinationProvider: 'facebook_page',
      });
      expect(revokedClaims).toEqual([]);
    } finally {
      await database.close();
    }
  });
});
