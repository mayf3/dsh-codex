import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'

const observation = vi.hoisted(() => ({ events: [] as string[], unlinkedOnce: '', unlinkedAfter: 0, failSyncOnce: '' }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const info = await fs.lstat(...args)
      if (String(args[0]) === observation.unlinkedOnce && --observation.unlinkedAfter === 0) {
        observation.unlinkedOnce = ''
        return new Proxy(info, { get: (target, key) => key === 'nlink' ? 0 : Reflect.get(target, key) })
      }
      return info
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync') return async () => {
            if (String(args[0]) === observation.failSyncOnce) { observation.failSyncOnce = ''; throw new Error('fixture-sync-failure') }
            await target.sync()
            observation.events.push(`sync:${String(args[0])}`)
          }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await fs.rm(...args)
      observation.events.push(`rm:${String(args[0])}`)
    },
  }
})

let root: string | undefined
afterEach(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined })
it('syncs intent and its parent before dispatch and commit before durable intent removal', async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'durability-r2-'))
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  const credential = { type: 'oauth' as const, access: 'access-fixture', refresh: 'refresh-fixture', accountId: 'account-fixture', expires: Date.now() - 60_000 }
  await store.modify(OPENAI_CODEX_PROVIDER, async () => credential)
  observation.events = []
  await store.modify(OPENAI_CODEX_PROVIDER, async () => {
    observation.events.push('dispatch')
    const info = await lstat(store.filename)
    expect(info.uid).toBe(process.getuid?.())
    expect((await lstat(dirname(store.filename))).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await readFile(store.refreshIntentFilename, 'utf8'))).toMatchObject({ state: 'pending' })
    for (const filename of [store.filename, store.refreshIntentFilename, `${store.filename}.lock`]) {
      const metadata = await lstat(filename)
      expect(metadata.mode & 0o777).toBe(0o600)
      expect(metadata.uid).toBe(process.getuid?.())
    }
    return { ...credential, expires: Date.now() + 60_000 }
  })
  expect(observation.events.filter(event => event !== `rm:${store.filename}.lock`)).toEqual([
    `sync:${store.refreshIntentFilename}`, `sync:${root}`, 'dispatch',
    `sync:${store.filename}`, `sync:${root}`, `rm:${store.refreshIntentFilename}`, `sync:${root}`,
  ])
  const final = await lstat(store.filename)
  expect(final.mode & 0o777).toBe(0o600)
  expect(final.uid).toBe(process.getuid?.())
})

it('re-resolves a detached lock metadata snapshot during live-owner turnover', async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'lock-turnover-r2-'))
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  const credential = { type: 'oauth' as const, access: 'fixture', refresh: 'fixture', accountId: 'fixture', expires: 1 }
  await store.modify(OPENAI_CODEX_PROVIDER, async () => credential)
  const info = await lstat(store.filename)
  await writeFile(store.refreshIntentFilename, JSON.stringify({ version: 1, generationId: `fs:${String(info.dev)}:${String(info.ino)}`, state: 'pending', startedAt: new Date().toISOString() }), { mode: 0o600 })
  await writeFile(`${store.filename}.lock`, `${String(process.pid)}\n`, { mode: 0o600 })
  observation.unlinkedOnce = `${store.filename}.lock`
  observation.unlinkedAfter = 2
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 30_001)
  try { await expect(store.read(OPENAI_CODEX_PROVIDER)).rejects.toMatchObject({ code: 'OPENAI_CODEX_REFRESH_IN_PROGRESS' }) }
  finally { clock.mockRestore(); observation.unlinkedOnce = '' }
})

it('retains intent on commit durability failure and durably recovers a valid replacement', async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'write-failure-r2-'))
  const store = new OpenAICodexCredentialStore(join(root, 'auth.json'))
  const credential = { type: 'oauth' as const, access: 'fixture-old', refresh: 'fixture-refresh', accountId: 'fixture', expires: 1 }
  await store.modify(OPENAI_CODEX_PROVIDER, async () => credential)
  observation.failSyncOnce = store.filename
  let calls = 0
  await expect(store.modify(OPENAI_CODEX_PROVIDER, async () => { calls++; return { ...credential, access: 'fixture-new', expires: Date.now() + 60_000 } })).rejects.toMatchObject({ code: 'OPENAI_CODEX_REAUTH_REQUIRED' })
  expect(await readFile(store.refreshIntentFilename, 'utf8')).toContain('pending')
  observation.events = []
  expect(await store.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ access: 'fixture-new' })
  expect(calls).toBe(1)
  expect(observation.events.filter(event => event !== `rm:${store.filename}.lock`)).toEqual([
    `sync:${store.filename}`, `sync:${root}`, `rm:${store.refreshIntentFilename}`, `sync:${root}`,
  ])
})
