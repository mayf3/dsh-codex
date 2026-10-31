import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { loginOpenAICodex } from '../src/auth.ts'
import { openaiCodexProvider, refreshOpenAICodexCredential } from '../src/oauth-provider.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'

const { login } = vi.hoisted(() => ({ login: vi.fn() }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-ai/providers/openai-codex')>()
  return { openaiCodexProvider: () => {
    const provider = original.openaiCodexProvider()
    return { ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth!, login } } }
  } }
})

const jwt = (email?: string) => `header.${Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600,
  'https://api.openai.com/auth': { chatgpt_account_id: 'account' },
  ...(email ? { email } : {}),
})).toString('base64url')}.signature`
const old = { type: 'oauth' as const, access: jwt(), refresh: 'old-refresh', expires: 1, accountId: 'account' }
const response = () => ({ access_token: jwt(), refresh_token: 'new-refresh', id_token: jwt('new@example.invalid'), expires_in: 3600 })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
let directory: string | undefined
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
  vi.clearAllMocks()
})

describe('complete Codex OAuth refresh', () => {
  it('uses the refresh grant and retains the returned identity token and email', async () => {
    const data = response()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data))
    const signal = new AbortController().signal
    const updated = await refreshOpenAICodexCredential(old, signal, fetch)
    expect(updated).toMatchObject({ access: data.access_token, refresh: data.refresh_token, idToken: data.id_token, email: 'new@example.invalid', accountId: 'account' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://auth.openai.com/oauth/token')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal })
    expect(new URLSearchParams(init!.body as URLSearchParams).get('refresh_token')).toBe('old-refresh')
  })

  it('lets pi-ai schedule refresh and atomically persists all fields in CPA format', async () => {
    directory = await mkdtemp(join(await realpath(tmpdir()), 'dsh-complete-oauth-'))
    const filename = join(directory, 'auth.json')
    await writeFile(filename, JSON.stringify({ type: 'codex', access_token: old.access, refresh_token: old.refresh, account_id: 'account', id_token: 'old-id', expired: new Date(1).toISOString(), email: 'old@example.invalid', disabled: false }), { mode: 0o600 })
    const store = new OpenAICodexCredentialStore(filename)
    const data = response()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data))
    const models = createModels({ credentials: store })
    models.setProvider(openaiCodexProvider(fetch))
    expect((await models.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey).toBe(data.access_token)
    expect(JSON.parse(await readFile(filename, 'utf8'))).toMatchObject({ access_token: data.access_token, refresh_token: data.refresh_token, id_token: data.id_token, email: 'new@example.invalid', disabled: false })
    await models.getAuth(OPENAI_CODEX_PROVIDER)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('completes pi-ai login with one full refresh before returning credentials', async () => {
    login.mockResolvedValue(old)
    const data = response()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(data))
    vi.stubGlobal('fetch', fetch)
    const interaction = { signal: new AbortController().signal, prompt: vi.fn(async () => 'browser'), notify: vi.fn() } as AuthInteraction & { signal: AbortSignal }
    const credential = await openaiCodexProvider().auth.oauth!.login(interaction)
    expect(login).toHaveBeenCalledOnce()
    expect(credential).toMatchObject({ refresh: data.refresh_token, idToken: data.id_token })
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('routes the entire device-code exchange through the supplied Codex fetch', async () => {
    const data = response()
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/deviceauth/usercode'))
        return Response.json({ device_auth_id: 'device-id', user_code: 'ABCD-EFGH', interval: 0 })
      if (url.endsWith('/deviceauth/token'))
        return Response.json({ authorization_code: 'approval', code_verifier: 'verifier' })
      if (url.endsWith('/oauth/token')) {
        const grant = new URLSearchParams(init?.body as URLSearchParams).get('grant_type')
        return Response.json(grant === 'authorization_code'
          ? { access_token: jwt(), refresh_token: 'first-refresh', expires_in: 3600 }
          : data)
      }
      throw new Error(`unexpected OAuth URL: ${url}`)
    })
    const notify = vi.fn()
    const interaction = { signal: new AbortController().signal, prompt: vi.fn(async () => 'device_code'), notify }
    const credential = await openaiCodexProvider(fetch).auth.oauth!.login(interaction)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://auth.openai.com/codex/device',
    }))
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
      'https://auth.openai.com/api/accounts/deviceauth/token',
      'https://auth.openai.com/oauth/token',
      'https://auth.openai.com/oauth/token',
    ])
    expect(credential).toMatchObject({ idToken: data.id_token, refresh: data.refresh_token })
    expect(login).not.toHaveBeenCalled()
  })

  it('lets a local browser callback finish while token exchange uses Codex fetch', async () => {
    const data = response()
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const grant = new URLSearchParams(init?.body as URLSearchParams).get('grant_type')
      return Response.json(grant === 'authorization_code'
        ? { access_token: jwt(), refresh_token: 'first-refresh', expires_in: 3600 }
        : data)
    })
    const callback = deferred<void>()
    const interaction = {
      signal: new AbortController().signal,
      prompt: (prompt: { type: string; signal?: AbortSignal }) => prompt.type === 'select'
        ? Promise.resolve('browser')
        : new Promise<string>((_resolve, reject) => {
            prompt.signal?.addEventListener('abort', () => reject(new Error('manual prompt closed')), { once: true })
          }),
      notify: (event: { type: string; url?: string }) => {
        if (event.type !== 'auth_url' || event.url === undefined) return
        const state = new URL(event.url).searchParams.get('state')
        get(`http://127.0.0.1:1455/auth/callback?code=approval&state=${state}`, res => {
          res.resume()
          res.on('end', () => callback.resolve())
        }).on('error', callback.reject)
      },
    }
    const credential = await openaiCodexProvider(fetch).auth.oauth!.login(interaction)
    await callback.promise
    expect(credential).toMatchObject({ idToken: data.id_token })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as URLSearchParams).get('grant_type')).toBe('authorization_code')
  })

  it('rejects missing ID tokens and hides failed response bodies', async () => {
    const { id_token: _, ...incomplete } = response()
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(incomplete))
      .mockResolvedValueOnce(new Response('secret-response', { status: 401 }))
    const signal = new AbortController().signal
    await expect(refreshOpenAICodexCredential(old, signal, fetch)).rejects.toThrow('missing id_token')
    await expect(refreshOpenAICodexCredential(old, signal, fetch)).rejects.toThrow('failed (401)')
  })

  it('does not send an already cancelled request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(refreshOpenAICodexCredential(old, AbortSignal.abort(), fetch)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})


describe('explicit login recovery seam', () => {
  it('replaces an unknown generation through real Models.login and preserves supplied transport', async () => {
    directory = await mkdtemp(join(await realpath(tmpdir()), 'dsh-owner-login-'))
    const store = new OpenAICodexCredentialStore(join(directory, 'auth.json'))
    await store.modify(OPENAI_CODEX_PROVIDER, async () => old)
    const info = await stat(store.filename)
    await writeFile(`${store.filename}.refresh-intent.json`, JSON.stringify({ version: 1, generationId: `fs:${info.dev}:${info.ino}`, state: 'pending', startedAt: new Date().toISOString() }), { mode: 0o600 })
    await writeFile(store.filename, '{fixture-malformed-private-document', { mode: 0o600 })
    const data = response()
    const transport = vi.fn<typeof fetch>(async input => {
      const url = String(input)
      if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'fixture-device', user_code: 'FIXTURE', interval: 0 })
      if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'fixture-approval', code_verifier: 'fixture-verifier' })
      if (url.endsWith('/oauth/token')) return Response.json(data)
      throw new Error('unexpected fixture URL')
    })
    await loginOpenAICodex({ signal: new AbortController().signal, prompt: async () => 'device_code', notify: () => {} }, store, transport)
    expect(await store.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: data.access_token, idToken: data.id_token })
    await expect(stat(`${store.filename}.refresh-intent.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(transport).toHaveBeenCalledTimes(4)
  })
})
