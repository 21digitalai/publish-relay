import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { forward, upstreamOrigin } from './worker.mjs';

const env = { UPSTREAM: 'https://203.0.113.10', UPSTREAM_HOST: '203.0.113.10' };

test('accepts only the configured HTTPS direct origin', () => {
  assert.equal(upstreamOrigin(env.UPSTREAM, env.UPSTREAM_HOST), env.UPSTREAM);
  for (const value of [
    'http://203.0.113.10',
    'https://evil.example',
    'https://203.0.113.10:443',
    'https://203.0.113.10/other',
    'https://user@203.0.113.10',
  ]) {
    assert.throws(() => upstreamOrigin(value, env.UPSTREAM_HOST));
  }
});

test('preserves cookies and CSRF while replacing spoofed forwarding and caching', async () => {
  const request = new Request('https://review.example.workers.dev/api/example?q=1', {
    method: 'POST',
    headers: { cookie: 'session=test', 'x-csrf-token': 'csrf', 'x-forwarded-host': 'evil.test' },
    body: 'test body',
  });
  const response = await forward(request, env, async (upstream) => {
    assert.equal(upstream.url, env.UPSTREAM + '/api/example?q=1');
    assert.equal(await upstream.text(), 'test body');
    assert.equal(upstream.headers.get('cookie'), 'session=test');
    assert.equal(upstream.headers.get('x-csrf-token'), 'csrf');
    assert.equal(upstream.headers.get('x-forwarded-host'), 'review.example.workers.dev');
    return new Response(null, {
      status: 302,
      headers: { location: env.UPSTREAM + '/login', 'set-cookie': 'new=value; Secure; HttpOnly' },
    });
  });
  assert.equal(response.headers.get('location'), 'https://review.example.workers.dev/login');
  assert.match(response.headers.get('set-cookie'), /Secure/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('invalid configuration fails closed', async () => {
  const response = await worker.fetch(new Request('https://review.example.workers.dev/'), {
    UPSTREAM: 'https://evil.example',
    UPSTREAM_HOST: '203.0.113.10',
  });
  assert.equal(response.status, 503);
});
