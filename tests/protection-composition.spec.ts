import { chmod, link, lstat, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'
import { OpenAICodexWebAuth } from '../src/auth-routes.ts'
import { openAICodexAuthStatus } from '../src/auth.ts'
import { isOpenAICodexReauthRequiredError, OpenAICodexReauthRequiredError, readOpenAICodexRateLimits } from '../src/usage.ts'
import * as rootExports from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const credential = (expires = Date.now() + 60_000) => ({ type: 'oauth' as const, access: 'fixture-access', refresh: 'fixture-refresh', expires, accountId: 'fixture-account', idToken: 'fixture-id', email: 'fixture@example.invalid' })
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-main-protection-')); roots.push(root)
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  await store.modify(OPENAI_CODEX_PROVIDER, async () => credential(1))
  return { root, store }
}
async function pending(store: OpenAICodexCredentialStore) {
  const info = await stat(store.filename)
  await writeFile(`${store.filename}.refresh-intent.json`, JSON.stringify({ version: 1, generationId: `fs:${info.dev}:${info.ino}`, state: 'pending', startedAt: new Date().toISOString() }), { mode: 0o600 })
}

describe('main protection composition', () => {
  it('rejects component symlinks and nonprivate parents before callbacks or filesystem mutation', async () => {
    const { root, store } = await fixture()
    const alias = join(root, 'alias'); await symlink(root, alias)
    const fn = vi.fn(async () => credential())
    await expect(new OpenAICodexCredentialStore(join(alias, 'new', 'auth.json')).modify(OPENAI_CODEX_PROVIDER, fn)).rejects.toThrow(/symlink/)
    await expect(stat(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
    await chmod(root, 0o755)
    await expect(store.modify(OPENAI_CODEX_PROVIDER, fn)).rejects.toThrow(/private directory/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('publishes exact private intent before callback and preserves identity fields and unrelated providers', async () => {
    const { store } = await fixture()
    await writeFile(store.filename, JSON.stringify({ 'openai-codex': credential(1), other: { value: 'keep' } }), { mode: 0o600 })
    const info = await stat(store.filename)
    await store.modify(OPENAI_CODEX_PROVIDER, async () => {
      expect(JSON.parse(await readFile(`${store.filename}.refresh-intent.json`, 'utf8'))).toEqual({ version: 1, generationId: `fs:${info.dev}:${info.ino}`, state: 'pending', startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) })
      expect((await stat(`${store.filename}.refresh-intent.json`)).mode & 0o777).toBe(0o600)
      expect((await stat(`${store.filename}.lock`)).mode & 0o777).toBe(0o600)
      for (const path of [store.filename, `${store.filename}.refresh-intent.json`, `${store.filename}.lock`]) expect((await stat(path)).uid).toBe(process.getuid?.())
      return credential()
    })
    expect(JSON.parse(await readFile(store.filename, 'utf8'))).toMatchObject({ 'openai-codex': { idToken: 'fixture-id', email: 'fixture@example.invalid' }, other: { value: 'keep' } })
    await expect(stat(`${store.filename}.refresh-intent.json`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains evidence and redacts actual callback and candidate-validation failures after intent', async () => {
    for (const fail of [async () => { throw new Error('fixture-access fixture-refresh') }, async () => ({ ...credential(), refresh: '' })]) {
      const { store } = await fixture()
      const error = await store.modify(OPENAI_CODEX_PROVIDER, fail).catch(error => error)
      expect(isOpenAICodexReauthRequiredError(error)).toBe(true)
      expect(String(error)).not.toMatch(/fixture-access|fixture-refresh/)
      expect(await readFile(`${store.filename}.refresh-intent.json`, 'utf8')).toContain('pending')
      let retries = 0
      await expect(store.modify(OPENAI_CODEX_PROVIDER, async () => { retries++; return credential() })).rejects.toBeInstanceOf(OpenAICodexReauthRequiredError)
      expect(retries).toBe(0)
    }
  })

  it('returns the same redacted reauth identity through actual status, usage and root exports without network', async () => {
    const { store } = await fixture(); await pending(store)
    const request = vi.fn<typeof fetch>()
    for (const operation of [() => store.read(OPENAI_CODEX_PROVIDER), () => openAICodexAuthStatus(store), () => readOpenAICodexRateLimits(store, request)]) {
      const error = await operation().catch(error => error)
      expect(error).toBeInstanceOf(rootExports.OpenAICodexReauthRequiredError)
      expect(isOpenAICodexReauthRequiredError(error)).toBe(true)
      expect(error.code).toBe('OPENAI_CODEX_REAUTH_REQUIRED')
      expect(String(error)).not.toMatch(/fixture-access|fixture-refresh/)
    }
    expect(request).not.toHaveBeenCalled()
    await expect(new OpenAICodexWebAuth(store, { requestFetch: request }).status()).resolves.toMatchObject({ status: 'reauth-required' })
  })

  it('retains pending evidence when a replacement document or mode is invalid', async () => {
    for (const invalid of ['malformed', 'mode', 'hardlink']) {
      const { root, store } = await fixture(); await pending(store)
      const next = join(root, 'next.json')
      await writeFile(next, invalid === 'malformed' ? '{fixture-secret' : JSON.stringify({ version: 1, credential: credential() }), { mode: invalid === 'mode' ? 0o644 : 0o600 })
      if (invalid === 'hardlink') await link(next, join(root, 'other.json'))
      await rename(next, store.filename)
      const error = await store.read(OPENAI_CODEX_PROVIDER).catch(error => error)
      expect(isOpenAICodexReauthRequiredError(error)).toBe(true)
      expect(String(error)).not.toContain('fixture-secret')
      expect(await readFile(`${store.filename}.refresh-intent.json`, 'utf8')).toContain('pending')
    }
  })

  it('exposes bounded wait exhaustion and never clears unknown evidence through delete', async () => {
    const { store } = await fixture(); await pending(store)
    await expect(store.delete(OPENAI_CODEX_PROVIDER)).rejects.toBeInstanceOf(OpenAICodexReauthRequiredError)
    expect(await readFile(`${store.filename}.refresh-intent.json`, 'utf8')).toContain('pending')
    await writeFile(`${store.filename}.lock`, `${process.pid}\n`, { mode: 0o600 })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 30_001)
    try {
      await expect(store.read(OPENAI_CODEX_PROVIDER)).rejects.toMatchObject({ code: 'OPENAI_CODEX_REFRESH_IN_PROGRESS' })
    } finally { clock.mockRestore() }
    expect(await readFile(`${store.filename}.refresh-intent.json`, 'utf8')).toContain('pending')
  })

  it('never echoes arbitrary credential field names in diagnostics', async () => {
    const { store } = await fixture()
    await writeFile(store.filename, JSON.stringify({ 'openai-codex': { ...credential(), 'fixture-access-secret-as-key': 'value' } }), { mode: 0o600 })
    const error = await store.read(OPENAI_CODEX_PROVIDER).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('fixture-access-secret-as-key')
  })

  for (const kind of ['symlink', 'hardlink', 'broad-mode'] as const) {
    it(`rejects an unsafe ${kind} intent before an explicit Owner callback`, async () => {
      const { root, store } = await fixture()
      await writeFile(store.filename, JSON.stringify({ version: 1, credential: credential() }), { mode: 0o600 })
      await pending(store)
      const intentPath = `${store.filename}.refresh-intent.json`
      const evidencePath = join(root, 'intent-evidence.json')
      if (kind === 'symlink') { await rename(intentPath, evidencePath); await symlink(evidencePath, intentPath) }
      else if (kind === 'hardlink') await link(intentPath, evidencePath)
      else await chmod(intentPath, 0o644)
      const original = await readFile(store.filename, 'utf8')
      const evidence = await readFile(intentPath, 'utf8')
      const before = await lstat(intentPath)
      const callback = vi.fn(async () => ({ ...credential(), access: 'fixture-owner-new' }))
      await expect(store.withOwnerReauth(() => store.modify(OPENAI_CODEX_PROVIDER, callback)))
        .rejects.toBeInstanceOf(OpenAICodexReauthRequiredError)
      expect(callback).not.toHaveBeenCalled()
      expect(await readFile(store.filename, 'utf8')).toBe(original)
      expect(await readFile(intentPath, 'utf8')).toBe(evidence)
      const after = await lstat(intentPath)
      expect({ ino: after.ino, dev: after.dev, mode: after.mode, nlink: after.nlink }).toEqual({ ino: before.ino, dev: before.dev, mode: before.mode, nlink: before.nlink })
      expect(after.isSymbolicLink()).toBe(kind === 'symlink')
    })
  }

  it('propagates non-reauth stored-status errors instead of reporting a signed-in account', async () => {
    const { store } = await fixture()
    await writeFile(store.filename, '{fixture-invalid-private-json', { mode: 0o600 })
    const request = vi.fn<typeof fetch>()
    await expect(new OpenAICodexWebAuth(store, { requestFetch: request }).status()).rejects.toThrow(/not valid JSON/)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects non-RFC3339 intent timestamps and never removes an orphan lock merely because its pid is gone', async () => {
    const { store } = await fixture(); await pending(store)
    const intentPath = `${store.filename}.refresh-intent.json`
    const value = JSON.parse(await readFile(intentPath, 'utf8')); value.startedAt = '2026-10-31'
    await writeFile(intentPath, JSON.stringify(value), { mode: 0o600 })
    await expect(store.read(OPENAI_CODEX_PROVIDER)).rejects.toBeInstanceOf(OpenAICodexReauthRequiredError)
    await writeFile(`${store.filename}.lock`, '2147483647\n', { mode: 0o600 })
    await expect(store.modify(OPENAI_CODEX_PROVIDER, async () => credential())).rejects.toBeInstanceOf(OpenAICodexReauthRequiredError)
    expect(await readFile(`${store.filename}.lock`, 'utf8')).toBe('2147483647\n')
  })
})
