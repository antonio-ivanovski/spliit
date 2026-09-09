import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import './test/mocks'
import {
  app,
  clientRateLimitMiddleware,
  requestWithTrustedProxyHeaders,
} from './app'

describe('proxy header trust', () => {
  it('removes client-supplied IP headers when proxy trust is disabled', () => {
    const request = new Request('https://api.example.test/auth/get-session', {
      headers: {
        'cf-connecting-ip': '203.0.113.1',
        'x-forwarded-for': '203.0.113.2',
        'x-real-ip': '203.0.113.3',
        'x-request-id': 'keep-me',
      },
    })

    const sanitized = requestWithTrustedProxyHeaders(request)

    expect(sanitized.headers.get('cf-connecting-ip')).toBeNull()
    expect(sanitized.headers.get('x-forwarded-for')).toBeNull()
    expect(sanitized.headers.get('x-real-ip')).toBeNull()
    expect(sanitized.headers.get('x-request-id')).toBe('keep-me')
  })

  it('skips IP rate limiting when no proxy is trusted', async () => {
    const testApp = new Hono()
    testApp.use(
      '/limited',
      clientRateLimitMiddleware({
        policy: 'test-untrusted-proxy',
        limit: 1,
        windowMs: 60_000,
        trustProxy: false,
      }),
    )
    testApp.get('/limited', (c) => c.text('ok'))

    for (let count = 0; count < 3; count += 1) {
      const response = await testApp.request('/limited', {
        headers: { 'cf-connecting-ip': `203.0.113.${count + 1}` },
      })
      expect(response.status).toBe(200)
    }
  })

  it('applies per-IP rate limiting when the proxy is trusted', async () => {
    const testApp = new Hono()
    testApp.use(
      '/limited',
      clientRateLimitMiddleware({
        policy: 'test-trusted-proxy',
        limit: 1,
        windowMs: 60_000,
        trustProxy: true,
      }),
    )
    testApp.get('/limited', (c) => c.text('ok'))

    const headers = { 'cf-connecting-ip': '203.0.113.10' }
    expect((await testApp.request('/limited', { headers })).status).toBe(200)
    expect((await testApp.request('/limited', { headers })).status).toBe(429)
  })
})

describe('tRPC body limit', () => {
  it('rejects oversize tRPC payloads with 413', async () => {
    // hono/body-limit short-circuits on the content-length header before
    // reading the body, so spoof the header to prove the middleware is wired
    // without allocating 25MB in the test.
    const response = await app.request('/trpc/groups.create?batch=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(26 * 1024 * 1024),
      },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(413)
  })

  it('passes normal-size tRPC payloads through to the router', async () => {
    const response = await app.request('/trpc/groups.create?batch=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    // Unauthenticated, but must NOT be a body-limit rejection.
    expect(response.status).not.toBe(413)
  })
})
