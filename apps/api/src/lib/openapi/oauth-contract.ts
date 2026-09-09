import type { OpenAPIV3_1 } from 'openapi-types'

const PUBLIC_AUTH_PATHS = new Set([
  '/auth/sign-up/email',
  '/auth/sign-in/email',
  '/auth/sign-in/magic-link',
  '/auth/magic-link/verify',
  '/auth/sign-in/social',
  '/auth/callback/{id}',
  '/auth/request-password-reset',
  '/auth/reset-password',
  '/auth/reset-password/{token}',
  '/auth/verify-email',
  '/auth/ok',
  '/auth/error',
  '/auth/refresh-token',
  '/auth/delete-user/callback',
  '/auth/oauth2/register',
  '/auth/oauth2/authorize',
  '/auth/oauth2/token',
  '/auth/oauth2/introspect',
  '/auth/oauth2/revoke',
  '/auth/jwks',
])

type OperationMethod = 'get' | 'post' | 'put' | 'delete' | 'patch'

const authorizationParameters: OpenAPIV3_1.ParameterObject[] = [
  {
    name: 'response_type',
    in: 'query',
    required: true,
    schema: { type: 'string', enum: ['code'] },
    description: 'OAuth response type. Spliit supports the code flow.',
  },
  {
    name: 'client_id',
    in: 'query',
    required: true,
    schema: { type: 'string', minLength: 1 },
    description: 'Registered OAuth client identifier.',
  },
  {
    name: 'redirect_uri',
    in: 'query',
    required: true,
    schema: { type: 'string', format: 'uri' },
    description: 'Redirect URI registered for the client.',
  },
  {
    name: 'scope',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Space-separated OAuth scopes.',
  },
  {
    name: 'state',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Opaque state returned to the client.',
  },
  {
    name: 'request_uri',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'Pushed Authorization Request URI, when configured.',
  },
  {
    name: 'code_challenge',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'PKCE code challenge. Required for public clients.',
  },
  {
    name: 'code_challenge_method',
    in: 'query',
    required: false,
    schema: { type: 'string', enum: ['S256'] },
    description: 'PKCE method. Required with code_challenge.',
  },
  {
    name: 'nonce',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'OpenID Connect nonce.',
  },
  {
    name: 'max_age',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 0 },
    description: 'Maximum authentication age in seconds.',
  },
  {
    name: 'resource',
    in: 'query',
    required: false,
    style: 'form',
    explode: true,
    schema: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', format: 'uri' },
    },
    description:
      'Protected resource URI. Repeat the parameter to request multiple resources.',
  },
  {
    name: 'prompt',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description:
      'Space-separated values: login, consent, create, select_account, or none.',
  },
]

function buildAuthorizationRequestBody(): OpenAPIV3_1.RequestBodyObject {
  const properties = Object.fromEntries(
    authorizationParameters.map(({ name, schema, description }) => [
      name,
      { ...schema, description },
    ]),
  )

  return {
    required: true,
    description:
      'The same authorization parameters accepted by GET, encoded as an HTML form.',
    content: {
      'application/x-www-form-urlencoded': {
        schema: {
          type: 'object',
          properties,
          required: ['response_type', 'client_id', 'redirect_uri'],
        },
        encoding: {
          resource: { style: 'form', explode: true },
        },
      },
    },
  }
}

function buildTokenAdministrationRequestBody(
  endpoint: 'introspection' | 'revocation',
): OpenAPIV3_1.RequestBodyObject {
  const authenticationDescription =
    endpoint === 'introspection'
      ? 'A confidential client must authenticate with HTTP Basic, client_id plus client_secret, or private_key_jwt.'
      : 'A public client identifies itself with client_id. A confidential client authenticates with HTTP Basic, client_id plus client_secret, or private_key_jwt.'

  return {
    required: true,
    description: authenticationDescription,
    content: {
      'application/x-www-form-urlencoded': {
        schema: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description: `Access or refresh token to ${endpoint === 'introspection' ? 'introspect' : 'revoke'}.`,
            },
            token_type_hint: {
              type: 'string',
              enum: ['access_token', 'refresh_token'],
            },
            client_id: {
              type: 'string',
              description:
                'OAuth client identifier. Omit when HTTP Basic or the client assertion supplies it.',
            },
            client_secret: {
              type: 'string',
              format: 'password',
              writeOnly: true,
              description: 'Client secret for client_secret_post.',
            },
            client_assertion: {
              type: 'string',
              description: 'Signed assertion for private_key_jwt.',
            },
            client_assertion_type: {
              type: 'string',
              enum: ['urn:ietf:params:oauth:client-assertion-type:jwt-bearer'],
            },
          },
          required: ['token'],
        },
      },
    },
  }
}

function replaceJsonBodyWithForm(operation: OpenAPIV3_1.OperationObject): void {
  if (!operation.requestBody || '$ref' in operation.requestBody) return
  const jsonBody = operation.requestBody.content?.['application/json']
  if (!jsonBody) return
  operation.requestBody.content = {
    'application/x-www-form-urlencoded': jsonBody,
  }
}

/** Apply Spliit's real auth and media-type contract to a Better Auth operation. */
export function applyOAuthOperationContract(
  fullPath: string,
  method: OperationMethod,
  operation: OpenAPIV3_1.OperationObject,
): void {
  if (fullPath === '/auth/oauth2/userinfo') {
    operation.security = [{ oauth2: ['openid'] }]
  } else {
    operation.security = PUBLIC_AUTH_PATHS.has(fullPath)
      ? []
      : [{ session: [] }]
  }

  if (fullPath === '/auth/oauth2/authorize') {
    // A session is consumed when present; without one Better Auth redirects
    // the browser to login. OpenAPI represents optional authentication with
    // an empty requirement alternative.
    operation.security = [{}, { session: [] }]
    operation.description =
      'Starts the OAuth authorization flow. A pre-existing session is optional; Better Auth redirects an unauthenticated user to the configured login page.'
    if (method === 'get') {
      operation.parameters = structuredClone(authorizationParameters)
      delete operation.requestBody
    } else if (method === 'post') {
      delete operation.parameters
      operation.requestBody = buildAuthorizationRequestBody()
    }
    return
  }

  if (method !== 'post') return

  // Better Auth 1.7 accepts the OAuth wire format but currently emits JSON in
  // its generated schema. Introspection and revocation also omit their
  // assertion fields from that generated request body, so replace them with
  // the complete runtime contract.
  if (fullPath === '/auth/oauth2/token') {
    replaceJsonBodyWithForm(operation)
  } else if (fullPath === '/auth/oauth2/introspect') {
    operation.description =
      'Introspects an OAuth access or refresh token. Confidential OAuth client authentication is required; browser sessions and bearer access tokens do not authenticate this endpoint.'
    operation.requestBody = buildTokenAdministrationRequestBody('introspection')
  } else if (fullPath === '/auth/oauth2/revoke') {
    operation.description =
      'Revokes an OAuth access or refresh token. Public clients identify themselves with client_id; confidential clients authenticate using their registered client authentication method. Browser sessions do not authenticate this endpoint.'
    operation.requestBody = buildTokenAdministrationRequestBody('revocation')
  }
}

const oauthErrorResponses: OpenAPIV3_1.ResponsesObject = {
  '400': { description: 'OAuth protocol error.' },
  '401': { description: 'Invalid client or bearer token.' },
}

/**
 * OAuth paths that must remain in the production spec when Better Auth cannot
 * introspect its schema during a database-free container build.
 */
export function buildOAuthProtocolFallbackPaths(): Record<
  string,
  OpenAPIV3_1.PathItemObject
> {
  const tokenResponse: OpenAPIV3_1.SchemaObject = {
    type: 'object',
    properties: {
      access_token: { type: 'string' },
      refresh_token: { type: 'string' },
      token_type: { type: 'string' },
      expires_in: { type: 'integer' },
      scope: { type: 'string' },
    },
    required: ['access_token', 'token_type'],
  }

  const introspectionResponse: OpenAPIV3_1.SchemaObject = {
    type: 'object',
    properties: {
      active: { type: 'boolean' },
      scope: { type: 'string' },
      client_id: { type: 'string' },
      username: { type: 'string' },
      token_type: { type: 'string' },
      exp: { type: 'integer' },
      iat: { type: 'integer' },
      nbf: { type: 'integer' },
      sub: { type: 'string' },
      aud: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      iss: { type: 'string', format: 'uri' },
      jti: { type: 'string' },
    },
    required: ['active'],
  }

  const publicClientResponse: OpenAPIV3_1.SchemaObject = {
    type: 'object',
    properties: {
      client_id: { type: 'string' },
      client_name: { type: 'string' },
      client_uri: { type: 'string', format: 'uri' },
      logo_uri: { type: 'string', format: 'uri' },
      contacts: { type: 'array', items: { type: 'string' } },
      tos_uri: { type: 'string', format: 'uri' },
      policy_uri: { type: 'string', format: 'uri' },
    },
    required: ['client_id'],
  }

  return {
    '/auth/oauth2/register': {
      post: {
        tags: ['oauth'],
        summary: 'Register an OAuth client',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  client_name: { type: 'string' },
                  redirect_uris: {
                    type: 'array',
                    items: { type: 'string', format: 'uri' },
                  },
                  token_endpoint_auth_method: {
                    type: 'string',
                    enum: ['none'],
                  },
                  grant_types: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  response_types: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  scope: { type: 'string' },
                  resources: {
                    type: 'array',
                    items: { type: 'string', format: 'uri' },
                  },
                },
                required: ['client_name', 'redirect_uris'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'OAuth client registered.' },
          ...oauthErrorResponses,
        },
      },
    },
    '/auth/oauth2/authorize': {
      get: {
        tags: ['oauth'],
        summary: 'Authorize an OAuth client',
        description:
          'Starts the OAuth authorization flow. A pre-existing session is optional; unauthenticated users are redirected to login.',
        security: [{}, { session: [] }],
        parameters: structuredClone(authorizationParameters),
        responses: {
          '302': { description: 'Redirect to consent or back to the client.' },
          ...oauthErrorResponses,
        },
      },
      post: {
        tags: ['oauth'],
        summary: 'Authorize an OAuth client',
        description:
          'Starts the OAuth authorization flow with form parameters. A pre-existing session is optional; unauthenticated users are redirected to login.',
        security: [{}, { session: [] }],
        requestBody: buildAuthorizationRequestBody() as never,
        responses: {
          '302': { description: 'Redirect to consent or back to the client.' },
          ...oauthErrorResponses,
        },
      },
    },
    '/auth/oauth2/token': {
      post: {
        tags: ['oauth'],
        summary: 'Exchange or refresh an OAuth token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: {
                  grant_type: { type: 'string' },
                  client_id: { type: 'string' },
                  code: { type: 'string' },
                  redirect_uri: { type: 'string', format: 'uri' },
                  code_verifier: { type: 'string' },
                  refresh_token: { type: 'string' },
                  scope: { type: 'string' },
                  resource: { type: 'string', format: 'uri' },
                },
                required: ['grant_type'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'OAuth token response.',
            content: {
              // openapi-types intersects its 3.0 and 3.1 media schema aliases;
              // this is a plain 3.1 SchemaObject at runtime.
              'application/json': { schema: tokenResponse as never },
            },
          },
          ...oauthErrorResponses,
        },
      },
    },
    '/auth/oauth2/introspect': {
      post: {
        tags: ['oauth'],
        summary: 'Introspect an OAuth token',
        description:
          'Requires confidential OAuth client authentication; a browser session or bearer access token is not accepted. Use HTTP Basic, client_secret_post, or private_key_jwt.',
        security: [],
        requestBody: buildTokenAdministrationRequestBody(
          'introspection',
        ) as never,
        responses: {
          '200': {
            description: 'RFC 7662 token introspection response.',
            content: {
              'application/json': {
                schema: introspectionResponse as never,
              },
            },
          },
          ...oauthErrorResponses,
        },
      },
    },
    '/auth/oauth2/revoke': {
      post: {
        tags: ['oauth'],
        summary: 'Revoke an OAuth token',
        description:
          'Public clients identify themselves with client_id. Confidential clients use HTTP Basic, client_secret_post, or private_key_jwt. Browser sessions do not authenticate this endpoint.',
        security: [],
        requestBody: buildTokenAdministrationRequestBody('revocation') as never,
        responses: {
          '200': { description: 'Token revoked, or an RFC 7009 no-op.' },
          ...oauthErrorResponses,
        },
      },
    },
    '/auth/oauth2/public-client': {
      get: {
        tags: ['oauth'],
        summary: 'Get public OAuth client details',
        description:
          'Returns display-safe client metadata for consent pages. Requires an active user session.',
        security: [{ session: [] }],
        parameters: [
          {
            name: 'client_id',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'Display-safe OAuth client metadata.',
            content: {
              'application/json': { schema: publicClientResponse as never },
            },
          },
          '401': { description: 'An active session is required.' },
          '404': { description: 'Client not found.' },
        },
      },
    },
    '/auth/jwks': {
      get: {
        tags: ['oauth'],
        summary: 'Get JSON Web Keys',
        security: [],
        responses: {
          '200': {
            description: 'Public signing keys.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    keys: { type: 'array', items: { type: 'object' } },
                  },
                  required: ['keys'],
                },
              },
            },
          },
        },
      },
    },
    '/auth/oauth2/userinfo': {
      get: {
        tags: ['oauth'],
        summary: 'Get OpenID Connect user information',
        security: [{ oauth2: ['openid'] }],
        responses: {
          '200': { description: 'Claims for the access token subject.' },
          ...oauthErrorResponses,
        },
      },
      post: {
        tags: ['oauth'],
        summary: 'Get OpenID Connect user information',
        security: [{ oauth2: ['openid'] }],
        responses: {
          '200': { description: 'Claims for the access token subject.' },
          ...oauthErrorResponses,
        },
      },
    },
  }
}
