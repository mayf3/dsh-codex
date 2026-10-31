/** Codex device authorization with a provider-local fetch transport. */

import type { OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE = 'https://auth.openai.com'
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OpenAI Codex authorization returned invalid JSON')
  return value as Record<string, unknown>
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`OpenAI Codex authorization returned invalid ${name}`)
  return value
}

async function postJson(
  url: string,
  body: unknown,
  signal: AbortSignal,
  requestFetch: typeof globalThis.fetch,
): Promise<Response> {
  return requestFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Keep device-code requests in the same scoped proxy as other Codex requests. */
export async function loginOpenAICodexDeviceCode(
  interaction: ProviderAuthInteraction,
  requestFetch: typeof globalThis.fetch,
): Promise<OAuthCredential> {
  const signal = interaction.signal
  const codeResponse = await postJson(
    `${AUTH_BASE}/api/accounts/deviceauth/usercode`,
    { client_id: CLIENT_ID }, signal, requestFetch,
  )
  if (!codeResponse.ok)
    throw new Error(`OpenAI Codex device code request failed (${codeResponse.status})`)
  const code = object(await codeResponse.json())
  const deviceAuthId = required(code.device_auth_id, 'device_auth_id')
  const userCode = required(code.user_code, 'user_code')
  const rawInterval = typeof code.interval === 'string' ? Number(code.interval.trim()) : code.interval
  if (typeof rawInterval !== 'number' || !Number.isFinite(rawInterval) || rawInterval < 0)
    throw new Error('OpenAI Codex authorization returned invalid interval')
  interaction.notify({
    type: 'device_code',
    userCode,
    verificationUri: `${AUTH_BASE}/codex/device`,
    intervalSeconds: rawInterval,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_MS / 1000,
  })

  let intervalMs = Math.max(1000, rawInterval * 1000)
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_MS
  while (Date.now() < deadline) {
    await wait(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal)
    signal.throwIfAborted()
    const pollResponse = await postJson(
      `${AUTH_BASE}/api/accounts/deviceauth/token`,
      { device_auth_id: deviceAuthId, user_code: userCode }, signal, requestFetch,
    )
    if (pollResponse.ok) {
      const result = object(await pollResponse.json())
      const exchangeResponse = await requestFetch(`${AUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code: required(result.authorization_code, 'authorization_code'),
          code_verifier: required(result.code_verifier, 'code_verifier'),
          redirect_uri: DEVICE_REDIRECT_URI,
        }),
        signal,
      })
      if (!exchangeResponse.ok)
        throw new Error(`OpenAI Codex token exchange failed (${exchangeResponse.status})`)
      const token = object(await exchangeResponse.json())
      const expiresIn = token.expires_in
      if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0)
        throw new Error('OpenAI Codex token exchange returned invalid expiry')
      return {
        type: 'oauth',
        access: required(token.access_token, 'access_token'),
        refresh: required(token.refresh_token, 'refresh_token'),
        expires: Date.now() + expiresIn * 1000,
      }
    }
    let errorCode: string | undefined
    try {
      const body = object(await pollResponse.json())
      const error = body.error
      errorCode = typeof error === 'string' ? error
        : error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : undefined
    } catch { /* Some pending responses have no JSON body. */ }
    if (errorCode === 'slow_down') {
      intervalMs += 5000
      continue
    }
    if (errorCode === 'deviceauth_authorization_pending' ||
        (errorCode === undefined && (pollResponse.status === 403 || pollResponse.status === 404)))
      continue
    throw new Error(`OpenAI Codex device authorization failed (${pollResponse.status}${errorCode ? `: ${errorCode}` : ''})`)
  }
  throw new Error('OpenAI Codex device code expired')
}
