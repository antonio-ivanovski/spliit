import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import './test/mocks'
import {
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

  it('can apply a shared limit when no proxy is trusted', async () => {
    const testApp = new Hono()
    testApp.use(
      '/limited',
      clientRateLimitMiddleware({
        policy: 'test-untrusted-fallback',
        limit: 1,
        windowMs: 60_000,
        trustProxy: false,
        untrustedFallbackIdentity: 'all-direct-clients',
      }),
    )
    testApp.get('/limited', (c) => c.text('ok'))

    expect(
      (
        await testApp.request('/limited', {
          headers: { 'cf-connecting-ip': '203.0.113.1' },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await testApp.request('/limited', {
          headers: { 'cf-connecting-ip': '203.0.113.2' },
        })
      ).status,
    ).toBe(429)
  })
})
