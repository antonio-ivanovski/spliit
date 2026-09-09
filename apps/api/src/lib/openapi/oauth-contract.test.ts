import { describe, expect, it } from 'vitest'

import {
  applyOAuthOperationContract,
  buildOAuthProtocolFallbackPaths,
} from './oauth-contract'

function requestBodyContent(operation: { requestBody?: unknown }) {
  const requestBody = operation.requestBody
  if (
    !requestBody ||
    typeof requestBody !== 'object' ||
    !('content' in requestBody)
  ) {
    return undefined
  }
  return requestBody.content
}

describe('OAuth OpenAPI contract', () => {
  it.each([
    '/auth/oauth2/register',
    '/auth/oauth2/token',
    '/auth/oauth2/introspect',
    '/auth/oauth2/revoke',
    '/auth/jwks',
  ])('does not mislabel %s as cookie-session authenticated', (path) => {
    const operation = {}
    applyOAuthOperationContract(path, 'post', operation)
    expect(operation).toMatchObject({ security: [] })
  })

  it('requires an OAuth token, rather than a cookie, for userinfo', () => {
    const operation = {}
    applyOAuthOperationContract('/auth/oauth2/userinfo', 'get', operation)
    expect(operation).toMatchObject({ security: [{ oauth2: ['openid'] }] })
  })

  it.each(['/auth/oauth2/public-client', '/auth/oauth2/consent'])(
    'keeps %s session-protected',
    (path) => {
      const operation = {}
      applyOAuthOperationContract(path, 'get', operation)
      expect(operation).toMatchObject({ security: [{ session: [] }] })
    },
  )

  it('documents GET authorize parameters and optional pre-existing session', () => {
    const operation = {
      requestBody: {
        content: {
          'application/json': { schema: { type: 'object' as const } },
        },
      },
    }
    applyOAuthOperationContract('/auth/oauth2/authorize', 'get', operation)

    expect(operation.security).toEqual([{}, { session: [] }])
    expect(operation.requestBody).toBeUndefined()
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'client_id',
          in: 'query',
          required: true,
        }),
        expect.objectContaining({
          name: 'code_challenge',
          required: false,
        }),
        expect.objectContaining({
          name: 'resource',
          schema: expect.objectContaining({ type: 'array' }),
          explode: true,
        }),
      ]),
    )
  })

  it('documents POST authorize parameters in a form body, not the query', () => {
    const operation = {
      parameters: [{ name: 'client_id', in: 'query' as const }],
      requestBody: {
        content: {
          'application/json': { schema: { type: 'object' as const } },
        },
      },
    }
    applyOAuthOperationContract('/auth/oauth2/authorize', 'post', operation)

    expect(operation.security).toEqual([{}, { session: [] }])
    expect(operation.parameters).toBeUndefined()
    expect(requestBodyContent(operation)).toHaveProperty(
      'application/x-www-form-urlencoded',
    )
    expect(
      requestBodyContent(operation)?.['application/x-www-form-urlencoded']
        ?.schema,
    ).toMatchObject({
      required: ['response_type', 'client_id', 'redirect_uri'],
      properties: {
        code_challenge: expect.any(Object),
        resource: { type: 'array' },
      },
    })
  })

  it('rewrites the generated token body to form encoding', () => {
    const operation = {
      requestBody: {
        content: {
          'application/json': { schema: { type: 'object' as const } },
        },
      },
      responses: {},
    }
    applyOAuthOperationContract('/auth/oauth2/token', 'post', operation)
    expect(operation.requestBody.content).toEqual({
      'application/x-www-form-urlencoded': {
        schema: { type: 'object' },
      },
    })
  })

  it.each([
    ['/auth/oauth2/introspect', false],
    ['/auth/oauth2/revoke', true],
  ] as const)(
    'documents the complete form and client auth contract for %s',
    (path, permitsPublicClient) => {
      const operation = {
        requestBody: {
          content: {
            'application/json': { schema: { type: 'object' as const } },
          },
        },
      }
      applyOAuthOperationContract(path, 'post', operation)

      expect(operation.security).toEqual([])
      expect(operation.description).toContain(
        permitsPublicClient ? 'Public clients' : 'Confidential OAuth client',
      )
      const mediaType =
        requestBodyContent(operation)?.['application/x-www-form-urlencoded']
      expect(mediaType?.schema).toMatchObject({
        required: ['token'],
        properties: {
          token: expect.any(Object),
          token_type_hint: {
            enum: ['access_token', 'refresh_token'],
          },
          client_id: expect.any(Object),
          client_secret: expect.any(Object),
          client_assertion: expect.any(Object),
          client_assertion_type: {
            enum: ['urn:ietf:params:oauth:client-assertion-type:jwt-bearer'],
          },
        },
      })
    },
  )

  it('keeps every OAuth protocol endpoint in the database-free fallback', () => {
    const paths = buildOAuthProtocolFallbackPaths()

    expect(paths['/auth/oauth2/register']?.post?.security).toEqual([])
    expect(paths['/auth/oauth2/authorize']).toMatchObject({
      get: { security: [{}, { session: [] }] },
      post: { security: [{}, { session: [] }] },
    })
    expect(paths['/auth/oauth2/authorize']?.post?.parameters).toBeUndefined()
    expect(
      requestBodyContent(paths['/auth/oauth2/authorize']?.post ?? {}),
    ).toHaveProperty('application/x-www-form-urlencoded')

    for (const path of [
      '/auth/oauth2/token',
      '/auth/oauth2/introspect',
      '/auth/oauth2/revoke',
    ]) {
      expect(requestBodyContent(paths[path]?.post ?? {})).toHaveProperty(
        'application/x-www-form-urlencoded',
      )
      expect(paths[path]?.post?.security).toEqual([])
    }

    expect(paths['/auth/oauth2/public-client']).toMatchObject({
      get: {
        security: [{ session: [] }],
        parameters: [
          expect.objectContaining({
            name: 'client_id',
            in: 'query',
            required: true,
          }),
        ],
      },
    })
    expect(paths['/auth/jwks']?.get?.security).toEqual([])
    expect(paths['/auth/oauth2/userinfo']?.get?.security).toEqual([
      { oauth2: ['openid'] },
    ])
  })
})
