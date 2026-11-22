function isValidOriginHost(hostname) {
  return (
    hostname.length > 0 &&
    (netIpv4(hostname) ||
      netIpv6(hostname) ||
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
        hostname,
      ))
  );
}

function netIpv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

function netIpv6(value) {
  return value.includes(':') && /^[0-9a-f:]+$/i.test(value) && value.split(':').length <= 8;
}

export function upstreamOrigin(value, expectedHost) {
  const url = new URL(value);
  const explicitPort = /:\d+(?:[/?#]|$)/.test(value.slice(value.indexOf('//') + 2));
  if (
    url.protocol !== 'https:' ||
    !isValidOriginHost(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    explicitPort ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Expected an HTTPS origin with no credentials, port, or path');
  }
  if (expectedHost && url.hostname !== expectedHost.toLowerCase())
    throw new Error('Origin host is not the configured direct origin');
  return url.origin;
}

export async function forward(request, env, fetcher = fetch) {
  const publicUrl = new URL(request.url);
  const origin = upstreamOrigin(env.UPSTREAM, env.UPSTREAM_HOST);
  const target = origin + publicUrl.pathname + publicUrl.search;
  const headers = new Headers(request.headers);
  for (const key of [
    'host',
    'forwarded',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-for',
    'cf-connecting-ip',
  ])
    headers.delete(key);
  headers.set('x-forwarded-host', publicUrl.host);
  headers.set('x-forwarded-proto', 'https');
  const upstream = await fetcher(
    new Request(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: request.body, duplex: 'half' } : {}),
    }),
  );
  const responseHeaders = new Headers(upstream.headers);
  const location = responseHeaders.get('location');
  if (location) {
    const redirected = new URL(location, target);
    if (redirected.origin === origin)
      responseHeaders.set(
        'location',
        publicUrl.origin + redirected.pathname + redirected.search + redirected.hash,
      );
  }
  responseHeaders.set('cache-control', 'no-store');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request, env) {
    try {
      return await forward(request, env);
    } catch {
      return new Response('Review service temporarily unavailable', {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }
  },
};
