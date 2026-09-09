import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as OAuthApi from '@/app/oauth/oauth-api'
import { OAuthConsentPage } from '@/app/oauth/oauth-consent-page'
import { render, screen } from '@/test/test-utils'

type OAuthApiModule = typeof OAuthApi

const SIGNED_QUERY =
  'client_id=chatgpt&scope=openid+profile+email+spliit%3Agroups%3Aread+spliit%3Aexpenses%3Amanage'

const { clientMock, searchState, submitConsentMock } = vi.hoisted(() => ({
  clientMock: vi.fn(),
  searchState: {
    oauth_query: '' as string,
  },
  submitConsentMock: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({
    useSearch: () => searchState,
  }),
}))

vi.mock('@/lib/auth', () => ({
  authClient: {
    useSession: () => ({
      data: {
        user: {
          id: 'account-1',
          name: 'Antonio Example',
          email: 'antonio@example.com',
          image: null,
        },
      },
      isPending: false,
    }),
  },
}))

// Only the network calls are stubbed. `readOAuthRequest` and
// `resolveOAuthQuery` are pure parsing, and the point of these tests is that
// the page reads its client and scopes from the signed request.
vi.mock('@/app/oauth/oauth-api', async (importOriginal) => ({
  ...(await importOriginal<OAuthApiModule>()),
  getOAuthPublicClient: clientMock,
  submitConsent: submitConsentMock,
}))

describe('OAuthConsentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchState.oauth_query = SIGNED_QUERY
    clientMock.mockResolvedValue({
      client_id: 'chatgpt',
      client_name: 'ChatGPT',
      client_uri: 'https://chatgpt.example/connect',
      policy_uri: 'https://chatgpt.example/privacy',
    })
    submitConsentMock.mockResolvedValue(undefined)
  })

  it('explains the account, client, shared data and light risk', async () => {
    render(<OAuthConsentPage />)

    expect(await screen.findByText('Connect Spliit to ChatGPT?')).toBeVisible()
    expect(screen.getByText('Antonio Example')).toBeVisible()
    expect(screen.getByText('antonio@example.com')).toBeVisible()
    expect(screen.getByText('chatgpt')).toBeVisible()
    expect(
      screen.getByRole('link', {
        name: 'Application website (chatgpt.example)',
      }),
    ).toHaveAttribute('href', 'https://chatgpt.example/connect')
    expect(
      screen.getByRole('link', { name: 'Privacy policy' }),
    ).toHaveAttribute('href', 'https://chatgpt.example/privacy')
    expect(screen.getByText('What will be shared')).toBeVisible()
    expect(screen.getByText('A quick privacy note')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Allow and connect' }),
    ).toBeEnabled()
  })

  it('renders one permission per requested scope', async () => {
    render(<OAuthConsentPage />)

    expect(await screen.findByText('Group and spending context')).toBeVisible()
    expect(screen.getByText('Read expenses')).toBeVisible()
    expect(screen.getByText('Create and edit expenses')).toBeVisible()
    // Not requested, so not shown.
    expect(screen.queryByText('Delete expenses')).toBeNull()
    expect(screen.queryByText('Create and edit groups')).toBeNull()
  })

  it('reads the client and scopes from the signed request, not search params', async () => {
    // A wrapped link could otherwise name one client while authorizing the
    // scopes of another.
    searchState.oauth_query =
      'client_id=other-app&scope=openid+spliit%3Aexpenses%3Adelete'

    render(<OAuthConsentPage />)

    expect(await screen.findByText('Delete expenses')).toBeVisible()
    expect(screen.getByText('Read expenses')).toBeVisible()
    expect(clientMock).toHaveBeenCalledWith('other-app')
  })

  it('refuses to approve a scope it cannot name', async () => {
    searchState.oauth_query = 'client_id=chatgpt&scope=openid+spliit%3Aevil'

    render(<OAuthConsentPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('spliit:evil')
    expect(
      screen.getByRole('button', { name: 'Allow and connect' }),
    ).toBeDisabled()
  })

  it('explains when the application identity cannot be verified', async () => {
    clientMock.mockRejectedValueOnce(new Error('network failed'))

    render(<OAuthConsentPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Spliit could not verify this application',
    )
    expect(
      screen.getByRole('button', { name: 'Allow and connect' }),
    ).toBeDisabled()
  })

  it('does not turn non-HTTP client metadata into links', async () => {
    clientMock.mockResolvedValueOnce({
      client_id: 'chatgpt',
      client_name: 'ChatGPT',
      client_uri: 'javascript:alert(1)',
      policy_uri: 'data:text/html,not-a-policy',
    })

    render(<OAuthConsentPage />)

    expect(await screen.findByText('ChatGPT')).toBeVisible()
    expect(
      screen.queryByRole('link', { name: /Application website/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Privacy policy' }),
    ).not.toBeInTheDocument()
  })

  it('reports a missing signed request without naming an assistant', () => {
    searchState.oauth_query = ''

    render(<OAuthConsentPage />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Return to the application and start the connection again',
    )
    expect(screen.queryByText(/assistant/i)).not.toBeInTheDocument()
    expect(clientMock).not.toHaveBeenCalled()
  })

  it('submits the exact signed OAuth request when allowed', async () => {
    const { user } = render(<OAuthConsentPage />)

    const allow = await screen.findByRole('button', {
      name: 'Allow and connect',
    })
    await user.click(allow)

    expect(submitConsentMock).toHaveBeenCalledWith({
      accept: true,
      oauthQuery: SIGNED_QUERY,
    })
  })

  it('shows the redirect destination host from the signed request', async () => {
    searchState.oauth_query =
      'client_id=chatgpt&scope=openid+spliit%3Agroups%3Aread&redirect_uri=' +
      encodeURIComponent('https://chatgpt.example/oauth/callback')

    render(<OAuthConsentPage />)

    // The host is prominent; the full URI stays available on hover.
    const destination = await screen.findByTitle(
      'https://chatgpt.example/oauth/callback',
    )
    expect(destination).toBeVisible()
    expect(destination).toHaveTextContent('Redirects to chatgpt.example')
    // A regular HTTPS destination is not a local app.
    expect(
      screen.queryByTestId('oauth-loopback-warning'),
    ).not.toBeInTheDocument()
  })

  it('warns specifically for a loopback redirect and keeps the port', async () => {
    searchState.oauth_query =
      'client_id=local-agent&scope=openid+spliit%3Agroups%3Aread&redirect_uri=' +
      encodeURIComponent('http://127.0.0.1:33418/oauth/callback')

    render(<OAuthConsentPage />)

    const warning = await screen.findByTestId('oauth-loopback-warning')
    expect(warning).toBeVisible()
    expect(warning).toHaveTextContent('127.0.0.1:33418')
  })

  it('labels dynamically registered client identity as unverified', async () => {
    render(<OAuthConsentPage />)

    // Open unauthenticated DCR means client_name and client_uri are
    // self-asserted; the page must say so next to that identity.
    expect(
      await screen.findByText(
        'Unverified application: this identity is provided by the application itself.',
      ),
    ).toBeVisible()
  })

  it('keeps long account and client identities inside the connection panel', async () => {
    clientMock.mockResolvedValue({
      client_id: 'chatgpt',
      client_name:
        'A very long assistant client name used to validate constrained layouts',
    })

    render(<OAuthConsentPage />)

    expect(
      await screen.findByText(
        'A very long assistant client name used to validate constrained layouts',
      ),
    ).toBeVisible()
    const connectionPanel = screen.getByTestId('oauth-connection-panel')
    expect(connectionPanel).toHaveClass('min-w-0')
    expect(connectionPanel).toHaveClass('overflow-hidden')
  })
})
