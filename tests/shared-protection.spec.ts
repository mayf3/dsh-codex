import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { loginOpenAICodex } from '../src/auth.ts'
import { OpenAICodexWebAuth } from '../src/auth-routes.ts'
import * as publicApi from '../src/index.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER, OpenAICodexReauthRequiredError } from '../src/store.ts'
import { isOpenAICodexReauthRequiredError, readOpenAICodexRateLimits } from '../src/usage.ts'

const fixture = vi.hoisted(() => ({ loginFailure: undefined as Error | undefined }))
vi.mock('@earendil-works/pi-ai', async original => ({
  ...await original<typeof import('@earendil-works/pi-ai')>(),
  createModels: (options: { credentials: OpenAICodexCredentialStore }) => ({
    setProvider: () => {},
    getAuth: async () => { await options.credentials.read('openai-codex'); return undefined },
    login: async () => {
      if (fixture.loginFailure !== undefined) throw fixture.loginFailure
      await options.credentials.modify('openai-codex', async () => credential('owner', Date.now() + 60_000))
    },
  }),
}))

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fixture.loginFailure = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
function credential(name = 'old', expires = Date.now() - 60_000): OAuthCredential {
  return { type: 'oauth', access: `access-${name}-secret`, refresh: `refresh-${name}-secret`, accountId: 'account-fixture', expires }
}
async function store(): Promise<OpenAICodexCredentialStore> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'protection-r2-'))
  roots.push(root)
  const value = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  await value.modify(OPENAI_CODEX_PROVIDER, async () => credential())
  return value
}
async function pending(value: OpenAICodexCredentialStore): Promise<void> {
  const info = await lstat(value.filename)
  await writeFile(`${value.filename}.refresh-intent.json`, JSON.stringify({ version: 1, generationId: `fs:${String(info.dev)}:${String(info.ino)}`, state: 'pending', startedAt: new Date().toISOString() }), { mode: 0o600 })
}

describe('shared protection composition', () => {
  it('publishes the exact non-secret private intent before the refresh callback', async () => {
    const value = await store()
    await value.modify(OPENAI_CODEX_PROVIDER, async () => {
      const info = await lstat(value.filename)
      const text = await readFile(`${value.filename}.refresh-intent.json`, 'utf8')
      expect(JSON.parse(text)).toEqual({ version: 1, generationId: `fs:${String(info.dev)}:${String(info.ino)}`, state: 'pending', startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) })
      expect(text).not.toMatch(/access-|refresh-.*secret/)
      expect((await lstat(`${value.filename}.refresh-intent.json`)).mode & 0o777).toBe(0o600)
      expect((await lstat(`${value.filename}.lock`)).mode & 0o777).toBe(0o600)
      return credential('new', Date.now() + 60_000)
    })
    await expect(lstat(`${value.filename}.refresh-intent.json`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fences callback and write failures without retry or secret-bearing errors', async () => {
    const value = await store()
    await expect(value.modify(OPENAI_CODEX_PROVIDER, async () => { throw new Error('refresh-old-secret') })).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    const error: unknown = await value.read(OPENAI_CODEX_PROVIDER).catch(error => error)
    expect(String(error)).not.toContain('refresh-old-secret')
    expect(await readFile(`${value.filename}.refresh-intent.json`, 'utf8')).toContain('pending')
    let calls = 0
    await expect(value.modify(OPENAI_CODEX_PROVIDER, async () => { calls++; return credential() })).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    expect(calls).toBe(0)
    await value.withOwnerReauth(() => value.modify(OPENAI_CODEX_PROVIDER, async () => credential()))
    await expect(value.modify(OPENAI_CODEX_PROVIDER, async () => {
      await rm(value.filename)
      await mkdir(value.filename)
      return credential('new', Date.now() + 60_000)
    })).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    expect(await readFile(`${value.filename}.refresh-intent.json`, 'utf8')).toContain('pending')
  })

  it('does not swallow ordinary callback exceptions with a valid current credential', async () => {
    const value = await store()
    await value.modify(OPENAI_CODEX_PROVIDER, async () => credential('fresh', Date.now() + 60_000))
    const failure = new Error('fixture callback failure')
    await expect(value.modify(OPENAI_CODEX_PROVIDER, async () => { throw failure })).rejects.toBe(failure)
  })

  it.each(['invalid-json', 'broad-mode', 'hardlink'])('preserves pending evidence for an invalid replacement: %s', async kind => {
    const value = await store()
    await pending(value)
    const replacement = `${value.filename}.replacement`
    await writeFile(replacement, kind === 'invalid-json' ? '{not-json access-old-secret' : JSON.stringify({ version: 1, credential: credential('new', Date.now() + 60_000) }), { mode: kind === 'broad-mode' ? 0o644 : 0o600 })
    if (kind === 'hardlink') await link(replacement, `${replacement}.link`)
    await rename(replacement, value.filename)
    await expect(value.read(OPENAI_CODEX_PROVIDER)).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    expect(await readFile(`${value.filename}.refresh-intent.json`, 'utf8')).toContain('pending')
  })

  it('rejects symlinked parent and non-private parent before a callback', async () => {
    const value = await store()
    const root = dirname(value.filename)
    const symbolic = join(root, 'alias')
    await symlink(root, symbolic)
    await expect(new OpenAICodexCredentialStore(join(symbolic, 'auth.json')).read(OPENAI_CODEX_PROVIDER)).rejects.toThrow(/symlink/)
    await chmod(root, 0o755)
    await expect(value.modify(OPENAI_CODEX_PROVIDER, async () => { throw new Error('must not dispatch') })).rejects.toThrow(/private directory/)
  })

  it('uses the common explicit login seam for Owner recovery and releases scope on cancellation', async () => {
    const value = await store()
    await pending(value)
    const cancellation = new Error('fixture cancellation')
    fixture.loginFailure = cancellation
    await expect(loginOpenAICodex({ prompt: async () => '', notify: () => {} }, value)).rejects.toBe(cancellation)
    await expect(value.read(OPENAI_CODEX_PROVIDER)).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    fixture.loginFailure = undefined
    await loginOpenAICodex({ prompt: async () => '', notify: () => {} }, value)
    expect(await value.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'access-owner-secret' })
    await pending(value)
    await expect(value.modify(OPENAI_CODEX_PROVIDER, async () => credential('bypass', Date.now() + 60_000))).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
  })

  it('recognizes real store unknown errors through root, usage and Web status', async () => {
    const value = await store()
    await pending(value)
    const error: unknown = await readOpenAICodexRateLimits(value).catch(error => error)
    expect(error).toBeInstanceOf(OpenAICodexReauthRequiredError)
    expect(error).toBeInstanceOf(publicApi.OpenAICodexReauthRequiredError)
    expect(isOpenAICodexReauthRequiredError(error)).toBe(true)
    const web = new OpenAICodexWebAuth(value)
    expect(await web.status()).toMatchObject({ status: 'reauth-required' })
    await web.dispose()
  })

  it('fails loud with the stable in-progress discriminant when the live-owner wait is exhausted', async () => {
    const value = await store()
    await pending(value)
    await writeFile(`${value.filename}.lock`, `${String(process.pid)}\n`, { mode: 0o600 })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const result = value.read(OPENAI_CODEX_PROVIDER).catch((error: unknown) => error)
    let settled = false
    void result.then(() => { settled = true })
    for (let step = 0; step < 100 && !settled; step++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(settled).toBe(true)
    expect(await result).toMatchObject({ code: 'OPENAI_CODEX_REFRESH_IN_PROGRESS' })
    expect(await readFile(`${value.filename}.refresh-intent.json`, 'utf8')).toContain('pending')
  })

  it('does not allow logout to erase same-generation unknown outcome evidence', async () => {
    const value = await store()
    await pending(value)
    await expect(value.delete(OPENAI_CODEX_PROVIDER)).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    expect(await readFile(`${value.filename}.refresh-intent.json`, 'utf8')).toContain('pending')
    expect(await readFile(value.filename, 'utf8')).toContain('access-old-secret')
  })

  it('redacts an arbitrary malformed format-version value', async () => {
    const value = await store()
    await writeFile(value.filename, JSON.stringify({ version: 'arbitrary-token-secret', credential: credential() }), { mode: 0o600 })
    const error: unknown = await value.read(OPENAI_CODEX_PROVIDER).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('arbitrary-token-secret')
  })

  it('rejects non-RFC3339 pending time without clearing the evidence', async () => {
    const value = await store()
    const info = await lstat(value.filename)
    await writeFile(`${value.filename}.refresh-intent.json`, JSON.stringify({ version: 1, generationId: `fs:${String(info.dev)}:${String(info.ino)}`, state: 'pending', startedAt: '10/31/2026' }), { mode: 0o600 })
    await expect(value.read(OPENAI_CODEX_PROVIDER)).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    expect(await readFile(`${value.filename}.refresh-intent.json`, 'utf8')).toContain('10/31/2026')
  })

  it('rejects a symlinked path before opening its pending-intent document', async () => {
    const value = await store()
    await writeFile(`${value.filename}.refresh-intent.json`, 'not-an-intent', { mode: 0o600 })
    await symlink(dirname(value.filename), join(dirname(value.filename), 'alias'))
    await expect(new OpenAICodexCredentialStore(join(dirname(value.filename), 'alias', 'auth.json')).read(OPENAI_CODEX_PROVIDER)).rejects.toThrow(/symlink/)
  })

  it('classifies invalid replacement through automatic modify and permits explicit Owner replacement', async () => {
    const value = await store()
    await pending(value)
    const replacement = `${value.filename}.replacement`
    await writeFile(replacement, 'not-json access-old-secret', { mode: 0o600 })
    await rename(replacement, value.filename)
    let calls = 0
    await expect(value.modify(OPENAI_CODEX_PROVIDER, async () => { calls++; return credential('forbidden') })).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    expect(calls).toBe(0)
    await loginOpenAICodex({ prompt: async () => '', notify: () => {} }, value)
    expect(await value.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'access-owner-secret' })
  })

  it.each(['symbolic', 'broad-mode', 'hardlink', 'pid-prefix'])('fails closed for an unsafe existing writer lock: %s', async kind => {
    const value = await store()
    await pending(value)
    const lock = `${value.filename}.lock`
    const text = kind === 'pid-prefix' ? `${String(process.pid)} trailing-data\n` : `${String(process.pid)}\n`
    if (kind === 'symbolic') {
      await writeFile(`${lock}.target`, text, { mode: 0o600 })
      await symlink(`${lock}.target`, lock)
    } else {
      await writeFile(lock, text, { mode: kind === 'broad-mode' ? 0o644 : 0o600 })
      if (kind === 'hardlink') await link(lock, `${lock}.link`)
    }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const result = value.read(OPENAI_CODEX_PROVIDER).catch((error: unknown) => error)
    let settled = false
    void result.then(() => { settled = true })
    for (let step = 0; step < 100 && !settled; step++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(settled).toBe(true)
    expect(await result).toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    expect(await lstat(lock)).toBeDefined()
  })

  it('preserves owner-only read permissions outside explicitly configured shared mode', async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'default-home-r2-'))
    roots.push(directory)
    vi.stubEnv('DSH_HOME', directory)
    const value = new OpenAICodexCredentialStore()
    await value.modify(OPENAI_CODEX_PROVIDER, async () => credential('legacy', Date.now() + 60_000))
    await chmod(value.filename, 0o400)
    expect(await value.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'access-legacy-secret' })
    await expect(new OpenAICodexCredentialStore(value.filename).read(OPENAI_CODEX_PROVIDER)).rejects.toThrow(/mode 600/)
  })

  it.each(['symbolic', 'hardlink', 'broad-mode'])('does not let explicit Owner recovery bypass intent metadata: %s', async kind => {
    const value = await store()
    await pending(value)
    const intent = value.refreshIntentFilename
    if (kind === 'symbolic') {
      await rename(intent, `${intent}.target`)
      await symlink(`${intent}.target`, intent)
    } else if (kind === 'hardlink') await link(intent, `${intent}.link`)
    else await chmod(intent, 0o644)
    let calls = 0
    await expect(value.withOwnerReauth(() => value.modify(OPENAI_CODEX_PROVIDER, async () => {
      calls++
      return credential('owner', Date.now() + 60_000)
    }))).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
    expect(calls).toBe(0)
    expect(await lstat(intent)).toBeDefined()
    expect(await readFile(value.filename, 'utf8')).toContain('access-old-secret')
  })
})
