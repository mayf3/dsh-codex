/** Codex browser authorization with a provider-local fetch transport. */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE = 'https://auth.openai.com'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'

function authorizationCode(input: string, expectedState: string): string {
  const value = input.trim()
  try {
    const url = new URL(value)
    const state = url.searchParams.get('state')
    if (state !== null && state !== expectedState) throw new Error('OpenAI Codex OAuth state mismatch')
    return url.searchParams.get('code') || ''
  } catch (error) {
    if (error instanceof Error && error.message === 'OpenAI Codex OAuth state mismatch') throw error
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    if (state !== expectedState) throw new Error('OpenAI Codex OAuth state mismatch')
    return code ?? ''
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    const state = params.get('state')
    if (state !== null && state !== expectedState) throw new Error('OpenAI Codex OAuth state mismatch')
    return params.get('code') || ''
  }
  return value
}

/** Preserve pi-ai's callback URI while routing token exchange through Codex fetch. */
export async function loginOpenAICodexBrowser(
  interaction: ProviderAuthInteraction,
  requestFetch: typeof globalThis.fetch,
): Promise<OAuthCredential> {
  const signal = interaction.signal
  signal.throwIfAborted()
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  const url = new URL(`${AUTH_BASE}/oauth/authorize`)
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: 'openid profile email offline_access', code_challenge: challenge,
    code_challenge_method: 'S256', state, id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true', originator: 'pi',
  })) url.searchParams.set(key, value)

  let resolveCallback!: (code: string) => void
  let rejectCallback!: (reason: unknown) => void
  const callback = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  const server = createServer((req, res) => {
    let received: URL
    try {
      received = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (received.pathname !== '/auth/callback' || received.searchParams.get('state') !== state ||
        !received.searchParams.get('code')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('OpenAI Codex authorization callback was invalid.')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('OpenAI authentication completed. You can close this window.')
    resolveCallback(received.searchParams.get('code')!)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(1455, process.env.PI_OAUTH_CALLBACK_HOST || '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const onAbort = () => rejectCallback(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    const manualAbort = new AbortController()
    try {
      interaction.notify({ type: 'auth_url', url: url.href })
      const manual = interaction.prompt({
        type: 'manual_code',
        message: 'Paste the authorization code or redirect URL:',
        placeholder: REDIRECT_URI,
        signal: manualAbort.signal,
      }).then(input => authorizationCode(input, state))
      const code = await Promise.race([callback, manual])
      if (!code) throw new Error('OpenAI Codex authorization code was missing')
      const response = await requestFetch(`${AUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: CLIENT_ID, code,
          code_verifier: verifier, redirect_uri: REDIRECT_URI,
        }),
        signal,
      })
      if (!response.ok) throw new Error(`OpenAI Codex token exchange failed (${response.status})`)
      const raw: unknown = await response.json()
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('OpenAI Codex token exchange returned invalid JSON')
      const token = raw as Record<string, unknown>
      if (typeof token.access_token !== 'string' || !token.access_token ||
          typeof token.refresh_token !== 'string' || !token.refresh_token ||
          typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0)
        throw new Error('OpenAI Codex token exchange returned invalid fields')
      return {
        type: 'oauth', access: token.access_token, refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000,
      }
    } finally {
      manualAbort.abort()
      signal.removeEventListener('abort', onAbort)
    }
  } finally {
    if (server.listening) server.close()
  }
}
