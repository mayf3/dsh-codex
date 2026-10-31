import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER, OpenAICodexReauthRequiredError } from '../src/store.ts'
import { isOpenAICodexReauthRequiredError, readOpenAICodexRateLimits } from '../src/usage.ts'
import { OpenAICodexWebAuth } from '../src/auth-routes.ts'

const gate = vi.hoisted(() => ({ filename: '', hook: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const value = await fs.readFile(...args)
    if (String(args[0]) === gate.filename && gate.hook !== undefined) {
      const hook = gate.hook
      gate.hook = undefined
      await hook()
    }
    return value
  } }
})

let root: string | undefined
afterEach(async () => { gate.hook = undefined; vi.unstubAllGlobals(); if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined })
async function fixture(): Promise<OpenAICodexCredentialStore> {
  root = await mkdtemp(join(await realpath(tmpdir()), 'consumer-r2-'))
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  await store.modify(OPENAI_CODEX_PROVIDER, async () => ({ type: 'oauth', access: 'fixture-access-secret', refresh: 'fixture-refresh-secret', accountId: 'fixture-account', expires: Date.now() - 60_000 }))
  return store
}
async function pending(store: OpenAICodexCredentialStore): Promise<void> {
  const info = await lstat(store.filename)
  await writeFile(store.refreshIntentFilename, JSON.stringify({ version: 1, generationId: `fs:${String(info.dev)}:${String(info.ino)}`, state: 'pending', startedAt: new Date().toISOString() }), { mode: 0o600 })
}

it('exposes the actual store fence through real pi-ai getAuth without network dispatch', async () => {
  const store = await fixture()
  await pending(store)
  const network = vi.fn(() => { throw new Error('network forbidden') })
  vi.stubGlobal('fetch', network)
  const error: unknown = await readOpenAICodexRateLimits(store).catch(error => error)
  expect(error).toBeInstanceOf(OpenAICodexReauthRequiredError)
  expect(isOpenAICodexReauthRequiredError(error)).toBe(true)
  for (const discriminant of ['REFRESH_OUTCOME = UNKNOWN', 'AUTO_REFRESH_RETRY = FORBIDDEN', 'OLD_REFRESH_TOKEN_REUSE = FORBIDDEN']) expect(String(error)).toContain(discriminant)
  expect(network).not.toHaveBeenCalled()
  expect(String(error)).not.toMatch(/fixture-(access|refresh)-secret/)
})

it('fences a pending intent that is published while the canonical read is in flight', async () => {
  const store = await fixture()
  gate.filename = store.filename
  gate.hook = () => pending(store)
  await expect(store.read(OPENAI_CODEX_PROVIDER)).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
  expect(await readFile(store.refreshIntentFilename, 'utf8')).toContain('pending')
})

it('preserves non-reauth stored-status failures instead of reporting signed-in quota fallback', async () => {
  const store = await fixture()
  await writeFile(store.filename, '{invalid-json', { mode: 0o600 })
  const web = new OpenAICodexWebAuth(store)
  await expect(web.status()).rejects.toThrow(/not valid JSON/)
  await web.dispose()
})
