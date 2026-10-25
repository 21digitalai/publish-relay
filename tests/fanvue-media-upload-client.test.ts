import { describe, expect, it, vi } from 'vitest';

import { FanvueMediaUploadClient } from '../src/modules/providers/fanvue-media-upload-client.js';

const mediaUuid = '0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d';

describe('Fanvue multipart media transport', () => {
  it('opens, signs, uploads and completes without sending bearer auth to the signed URL', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((url, options) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (path.endsWith('/media/uploads') && options?.method === 'POST')
        return Promise.resolve(
          new Response(
            JSON.stringify({
              mediaUuid,
              uploadId: '2~session',
              partSize: 6,
              maxParts: 256,
              totalParts: 1,
            }),
          ),
        );
      if (path.includes('/parts/urls'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              partSize: 6,
              parts: [
                { partNumber: 1, url: 'https://uploads.example.test/part?signature=private' },
              ],
            }),
          ),
        );
      if (path.includes('uploads.example.test'))
        return Promise.resolve(new Response(null, { status: 200, headers: { ETag: '"etag"' } }));
      if (path.includes('/media/uploads/') && options?.method === 'PATCH')
        return Promise.resolve(new Response(JSON.stringify({ status: 'processing' })));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uuid: mediaUuid,
            status: 'ready',
            variants: [{ url: 'https://expiring.example' }],
          }),
        ),
      );
    });
    const client = new FanvueMediaUploadClient(request);
    await expect(
      client.createSession('token', {
        name: 'Clip',
        filename: 'clip.mp4',
        mediaType: 'video',
        sizeBytes: 6,
      }),
    ).resolves.toMatchObject({ mediaUuid });
    const signed = await client.signParts('token', '2~session', 1, 1);
    expect(signed.parts[0]?.partNumber).toBe(1);
    const etag = await client.putPart(signed.parts[0]?.url ?? '', Buffer.from('clip01'));
    expect(etag).toBe('"etag"');
    await expect(
      client.completeSession('token', '2~session', [{ PartNumber: 1, ETag: etag }]),
    ).resolves.toMatchObject({ status: 'processing' });
    await expect(client.getStatus('token', mediaUuid)).resolves.toEqual({
      uuid: mediaUuid,
      status: 'ready',
    });
    expect(request.mock.calls[2]?.[1]?.headers).toBeUndefined();
    expect(request.mock.calls[2]?.[1]?.method).toBe('PUT');
    expect(request.mock.calls[3]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('rejects oversize documents and non-HTTPS signed URLs before any request', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new FanvueMediaUploadClient(request);
    expect(() =>
      client.createSession('token', {
        name: 'Doc',
        filename: 'doc.pdf',
        mediaType: 'document',
        sizeBytes: 104_857_601,
      }),
    ).toThrow();
    await expect(
      client.putPart('http://uploads.example.test/part', Buffer.from('x')),
    ).rejects.toThrow('Invalid Fanvue signed part URL');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [1, [{ partNumber: 2, url: 'https://uploads.example.test/2' }]],
    [2, [{ partNumber: 1, url: 'https://uploads.example.test/1' }]],
    [
      2,
      [
        { partNumber: 1, url: 'https://uploads.example.test/1' },
        { partNumber: 1, url: 'https://uploads.example.test/again' },
      ],
    ],
  ])('rejects mismatched signed part ranges ending at %i', async (end, parts) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ partSize: 6, parts }));
    await expect(
      new FanvueMediaUploadClient(request).signParts('token', 'session', 1, end),
    ).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it('classifies transport loss and malformed provider responses without leaking bodies', async () => {
    const lost = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('private signed URL'));
    const lostClient = new FanvueMediaUploadClient(lost);
    await expect(
      lostClient.putPart('https://uploads.example.test/part', Buffer.from('x')),
    ).rejects.toMatchObject({
      status: 502,
      code: 'transport_failure',
    });
    await expect(lostClient.getStatus('token', mediaUuid)).rejects.toMatchObject({
      status: 502,
      code: 'transport_failure',
    });
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private malformed body'));
    await expect(
      new FanvueMediaUploadClient(malformed).getStatus('token', mediaUuid),
    ).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
    });
    const noEtag = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(
      new FanvueMediaUploadClient(noEtag).putPart(
        'https://uploads.example.test/part',
        Buffer.from('x'),
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
    });
  });
});
