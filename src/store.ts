/**
 * Owner-only persistent OAuth credential storage for the OpenAI Codex bundle.
 * @module dsh-codex/store
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { lstat, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { decodeCredentialDocument } from './credential-document.ts'

/** Provider route and pi-ai provider id owned by this bundle. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex'

/** Basename of the OAuth document inside the Harness home. */
export const OPENAI_CODEX_AUTH_FILENAME = '.openai-codex-auth.json'

/** Current on-disk format; pre-release readers reject every other version. */
const AUTH_FORMAT_VERSION = 1

export const OPENAI_CODEX_REAUTH_REQUIRED = 'OPENAI_CODEX_REAUTH_REQUIRED'
export const OPENAI_CODEX_REFRESH_IN_PROGRESS = 'OPENAI_CODEX_REFRESH_IN_PROGRESS'
const WAIT_TIMEOUT_MS = 30_000
const WAIT_INTERVAL_MS = 25

/** Shared public identity for HTTP rejection and persistent unknown outcome. */
export class OpenAICodexReauthRequiredError extends Error {
  readonly code = OPENAI_CODEX_REAUTH_REQUIRED
  constructor(message = 'OpenAI Codex authorization must be renewed') {
    super(message)
    this.name = 'OpenAICodexReauthRequiredError'
  }
}

export class OpenAICodexRefreshInProgressError extends Error {
  readonly code = OPENAI_CODEX_REFRESH_IN_PROGRESS
  constructor() {
    super('openai-codex: canonical credential refresh remains in progress')
    this.name = 'OpenAICodexRefreshInProgressError'
  }
}

interface IntentDocument { version: 1, generationId: string, state: 'pending', startedAt: string }
class SharedLockBusyError extends Error {}
class CredentialDecodeError extends Error {}

interface AuthDocument {
  version: typeof AUTH_FORMAT_VERSION
  credential: OAuthCredential
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Reject a credential document readable by another POSIX user. */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  /* v8 ignore next -- native Windows coverage takes the mode-less branch */
  if (process.platform === 'win32') return
  /* v8 ignore start -- POSIX tests cover this branch; Windows cannot express it */
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `openai-codex: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
  /* v8 ignore stop */
}

async function lstatOptional(filename: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  // Darwin can return an inode whose last link disappeared during lstat.
  // Re-resolve the pathname rather than mistaking that stale snapshot for a hardlink.
  for (let attempt = 0; ; attempt++) {
    try {
      const info = await lstat(filename)
      if (info.nlink === 0 && attempt < 5) continue
      return info
    } catch (error) { if (isENOENT(error)) return undefined; throw error }
  }
}

async function assertNoSymlinkComponents(filename: string): Promise<void> {
  const root = parse(filename).root
  let current = root
  for (const component of filename.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    const info = await lstatOptional(current)
    if (info === undefined) return
    if (info.isSymbolicLink()) throw new Error('openai-codex: shared credential path component is a symlink')
  }
}

async function assertPrivateFile(filename: string): Promise<void> {
  const info = await lstatOptional(filename)
  if (info === undefined) return
  if (!info.isFile() || info.nlink !== 1) throw new Error('openai-codex: shared credential must be a regular file with link count 1')
  if (process.platform !== 'win32' && ((Number(info.mode) & 0o777) !== 0o600 || info.uid !== process.getuid?.()))
    throw new Error('openai-codex: shared credential must be owner-owned and private (0600); readable beyond its owner or unsafe owner mode')
}

async function syncDirectory(filename: string): Promise<void> {
  const handle = await open(dirname(filename), 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function syncFileAndDirectory(filename: string): Promise<void> {
  const handle = await open(filename, 'r')
  try { await handle.sync() } finally { await handle.close() }
  await syncDirectory(filename)
}

function generation(info: Awaited<ReturnType<typeof stat>>): string { return `fs:${info.dev}:${info.ino}` }
function unknownOutcome(): OpenAICodexReauthRequiredError {
  return new OpenAICodexReauthRequiredError('openai-codex: REFRESH_OUTCOME=UNKNOWN; AUTO_REFRESH_RETRY=FORBIDDEN; OLD_REFRESH_TOKEN_REUSE=FORBIDDEN; Owner reauth is required')
}
function parseIntent(text: string): IntentDocument {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw unknownOutcome() }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unknownOutcome()
  const document = value as Record<string, unknown>
  if (Object.keys(document).sort().join(',') !== 'generationId,startedAt,state,version'
    || document['version'] !== 1 || document['state'] !== 'pending'
    || typeof document['generationId'] !== 'string' || !/^fs:[0-9]+:[0-9]+$/.test(document['generationId'])
    || typeof document['startedAt'] !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(document['startedAt'])
    || Number.isNaN(Date.parse(document['startedAt']))) throw unknownOutcome()
  return document as unknown as IntentDocument
}

/** Validate the strict JSON document without quoting token-bearing input. */
function parseDocument(text: string, filename: string): AuthDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`openai-codex: ${filename} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`openai-codex: ${filename} must contain an object`)
  }
  const document = value as Record<string, unknown>
  if (document['version'] !== AUTH_FORMAT_VERSION) {
    throw new Error(`openai-codex: ${filename} has unsupported auth format version`)
  }
  if (Object.keys(document).some(key => key !== 'version' && key !== 'credential')) {
    throw new Error(`openai-codex: ${filename} contains an unknown top-level field`)
  }
  const raw = document['credential']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`openai-codex: ${filename} credential must be an object`)
  }
  const credential = raw as Record<string, unknown>
  if (Object.keys(credential).some(key => !['type', 'access', 'refresh', 'expires', 'accountId', 'idToken', 'email'].includes(key))) {
    throw new Error(`openai-codex: ${filename} credential contains an unknown field`)
  }
  if (credential['type'] !== 'oauth') throw new Error(`openai-codex: ${filename} credential type must be oauth`)
  for (const key of ['access', 'refresh', 'accountId'] as const) {
    if (typeof credential[key] !== 'string' || credential[key].length === 0) {
      throw new Error(`openai-codex: ${filename} credential ${key} must be a non-empty string`)
    }
  }
  if (typeof credential['expires'] !== 'number' || !Number.isFinite(credential['expires']) || credential['expires'] <= 0) {
    throw new Error(`openai-codex: ${filename} credential expires must be a positive finite number`)
  }
  for (const key of ['idToken', 'email']) {
    if (credential[key] !== undefined && (typeof credential[key] !== 'string' || !credential[key]))
      throw new Error(`openai-codex: invalid credential ${key}`)
  }
  return { version: AUTH_FORMAT_VERSION, credential: credential as unknown as OAuthCredential }
}

/** Do not echo arbitrary unknown credential keys into consumer diagnostics. */
function decodeSharedDocument(text: string): ReturnType<typeof decodeCredentialDocument> {
  try { return decodeCredentialDocument(text) }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('openai-codex: unsupported credential field '))
      throw new CredentialDecodeError('openai-codex: unsupported credential field')
    throw new CredentialDecodeError(error instanceof Error ? error.message : 'openai-codex: invalid credential document')
  }
}

/** Detach a credential from callers that may mutate provider-owned extras. */
function cloneCredential(credential: OAuthCredential): OAuthCredential {
  return structuredClone(credential)
}

/**
 * Resolve the default OAuth document path.
 * @param dshHome - optional Harness-home override.
 * @returns the absolute owner-only document path.
 */
export function openAICodexAuthPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), OPENAI_CODEX_AUTH_FILENAME))
}

/** File-backed pi-ai store scoped to the single OpenAI Codex provider. */
export class OpenAICodexCredentialStore implements CredentialStore {
  readonly filename: string
  readonly refreshIntentFilename: string
  private readonly shared: boolean
  private readonly ownerReauth = new AsyncLocalStorage<boolean>()

  constructor(filename?: string) {
    this.shared = filename !== undefined
    if (filename !== undefined && !isAbsolute(filename)) throw new Error('openai-codex: credentialFile must be an absolute path')
    this.filename = resolve(filename ?? openAICodexAuthPath())
    this.refreshIntentFilename = `${this.filename}.refresh-intent.json`
  }

  private async assertSharedLocation(): Promise<void> {
    if (!this.shared) return
    await assertNoSymlinkComponents(dirname(this.filename))
    const parent = await lstatOptional(dirname(this.filename))
    if (parent !== undefined && (!parent.isDirectory() || (process.platform !== 'win32'
      && ((Number(parent.mode) & 0o777) !== 0o700 || parent.uid !== process.getuid?.()))))
      throw new Error('openai-codex: shared credential directory must be an owner-owned private directory (0700)')
  }

  private async assertSharedBoundary(): Promise<void> {
    await this.assertSharedLocation()
    if (this.shared) {
      await assertNoSymlinkComponents(this.filename)
      await assertPrivateFile(this.filename)
    }
  }

  /** The shared lock never takes over an orphan; quiescence belongs to the Owner. */
  private async withWriterLock<T>(operation: () => Promise<T>, waitMs = 2_000): Promise<T> {
    if (!this.shared) return withFileLock(this.filename, operation)
    const lock = `${this.filename}.lock`
    const deadline = Date.now() + waitMs
    while (true) {
      try {
        const handle = await open(lock, 'wx', 0o600)
        try { await handle.writeFile(`${process.pid}\n`) } finally { await handle.close() }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await assertPrivateFile(lock)
        if (Date.now() >= deadline) throw new SharedLockBusyError()
        await new Promise(done => setTimeout(done, WAIT_INTERVAL_MS))
      }
    }
    try { return await operation() } finally { await rm(lock, { force: true }) }
  }

  private async readRaw(): Promise<OAuthCredential | undefined> {
    await this.assertSharedBoundary()
    await assertOwnerOnly(this.filename)
    try {
      const text = await readFile(this.filename, 'utf8')
      return this.shared ? decodeSharedDocument(text).credential : cloneCredential(parseDocument(text, this.filename).credential)
    } catch (error) { if (isENOENT(error)) return undefined; throw error }
  }

  private async readIntent(): Promise<IntentDocument | undefined> {
    await this.assertSharedLocation()
    try {
      await assertPrivateFile(this.refreshIntentFilename)
      return parseIntent(await readFile(this.refreshIntentFilename, 'utf8'))
    } catch (error) { if (isENOENT(error)) return undefined; throw unknownOutcome() }
  }

  private async clearIntent(): Promise<void> {
    await rm(this.refreshIntentFilename, { force: true })
    await syncDirectory(this.refreshIntentFilename)
  }

  private async lockOwnerAlive(): Promise<boolean> {
    let text: string
    try { await assertPrivateFile(`${this.filename}.lock`); text = await readFile(`${this.filename}.lock`, 'utf8') }
    catch (error) { if (isENOENT(error)) return false; throw unknownOutcome() }
    if (!/^[0-9]+\n$/.test(text)) return false
    const pid = Number(text.trim())
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false
    try { process.kill(pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }

  /** Called only under the filename lock; invalid replacements preserve evidence. */
  private async recoverPending(): Promise<OAuthCredential | undefined> {
    const intent = await this.readIntent()
    if (intent === undefined) return this.readRaw()
    try {
      const info = await lstatOptional(this.filename)
      if (info === undefined || generation(info) === intent.generationId) throw unknownOutcome()
      const current = await this.readRaw()
      if (current === undefined || current.expires <= Date.now()) throw unknownOutcome()
      await syncFileAndDirectory(this.filename)
      await this.clearIntent()
      return current
    } catch { throw unknownOutcome() }
  }

  private async resolvePendingIntent(): Promise<OAuthCredential | undefined> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    while (true) {
      const intent = await this.readIntent()
      if (intent === undefined) {
        const current = await this.readRaw()
        if (await this.readIntent() === undefined) return current
        continue
      }
      if (await this.lockOwnerAlive()) {
        if (Date.now() >= deadline) throw new OpenAICodexRefreshInProgressError()
        await new Promise(done => setTimeout(done, WAIT_INTERVAL_MS))
        continue
      }
      const info = await lstatOptional(this.filename)
      if (info === undefined || generation(info) === intent.generationId) throw unknownOutcome()
      try { return await this.withWriterLock(() => this.recoverPending(), 0) }
      catch (error) {
        if (!(error instanceof SharedLockBusyError)) throw error
        // A dead/unknown lock is retained until separately quiesced Owner recovery.
        if (!await this.lockOwnerAlive()) throw unknownOutcome()
      }
    }
  }

  private async persistIntent(): Promise<void> {
    if (await this.readIntent() !== undefined) throw unknownOutcome()
    const intent: IntentDocument = { version: 1, generationId: generation(await stat(this.filename)), state: 'pending', startedAt: new Date().toISOString() }
    await writeFileAtomic(this.refreshIntentFilename, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    await syncFileAndDirectory(this.refreshIntentFilename)
  }

  /** Scope exactly one explicitly authorized interactive login. */
  async withOwnerReauth<T>(operation: () => Promise<T>): Promise<T> {
    return this.ownerReauth.run(true, operation)
  }

  private async readCurrent(): Promise<OAuthCredential | undefined> {
    if (!this.shared) return this.readRaw()
    // Pending metadata is inspected before credential parsing, so an invalid
    // replacement still has the same public fail-closed identity.
    if (await this.readIntent() !== undefined) return this.resolvePendingIntent()
    const current = await this.readRaw()
    return await this.readIntent() === undefined ? current : this.resolvePendingIntent()
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === OPENAI_CODEX_PROVIDER ? this.readCurrent() : undefined
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return await this.readCurrent() === undefined ? [] : [{ providerId: OPENAI_CODEX_PROVIDER, type: 'oauth' }]
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    if (providerId !== OPENAI_CODEX_PROVIDER) throw new Error(`openai-codex: credential store does not own provider "${providerId}"`)
    const isOwnerReauth = this.ownerReauth.getStore() === true
    if (this.shared && !isOwnerReauth && await this.readIntent() !== undefined) await this.resolvePendingIntent()
    await this.assertSharedBoundary()
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await this.assertSharedBoundary()
    try {
      return await this.withWriterLock(async () => {
        // Owner scope may repair unknown credentials, never unsafe intent evidence.
        if (this.shared && isOwnerReauth) await this.readIntent()
        let current: OAuthCredential | undefined
        let ownerReplacesInvalidDocument = false
        try { current = this.shared && !isOwnerReauth ? await this.recoverPending() : await this.readRaw() }
        catch (error) {
          // Explicit login may repair malformed bytes, never unsafe paths/modes.
          if (!isOwnerReauth || !this.shared || !(error instanceof CredentialDecodeError) || await this.readIntent() === undefined) throw error
          ownerReplacesInvalidDocument = true
        }
        let intentPersisted = false
        if (this.shared && !isOwnerReauth && current !== undefined && current.expires <= Date.now()) {
          await this.persistIntent()
          intentPersisted = true
        }
        try {
          const candidate = await fn(current === undefined ? undefined : cloneCredential(current))
          if (candidate === undefined) {
            if (intentPersisted) throw unknownOutcome()
            return current
          }
          const document = parseDocument(JSON.stringify({ version: AUTH_FORMAT_VERSION, credential: candidate }), this.filename)
          let output: unknown = document
          if (this.shared && !ownerReplacesInvalidDocument) {
            // Keep the modern decoder/update seam, including unrelated providers.
            await this.assertSharedBoundary()
            try {
              const source = decodeSharedDocument(await readFile(this.filename, 'utf8'))
              if (JSON.stringify(source.credential) !== JSON.stringify(current))
                throw new Error('openai-codex: credential changed during update; reload before retrying')
              output = source.update(document.credential)
              decodeSharedDocument(JSON.stringify(output))
            } catch (error) {
              if (!isENOENT(error)) throw error
              if (current !== undefined) throw new Error('openai-codex: credential file was removed during update')
            }
          }
          await writeFileAtomic(this.filename, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
          if (this.shared) {
            await syncFileAndDirectory(this.filename)
            await this.clearIntent()
          }
          return cloneCredential(document.credential)
        } catch (error) { if (intentPersisted) throw unknownOutcome(); throw error }
      })
    } catch (error) {
      // Only acquisition contention can recover by observing another writer.
      if (!(error instanceof SharedLockBusyError)) throw error
      if (await this.readIntent() !== undefined) return this.resolvePendingIntent()
      throw new OpenAICodexRefreshInProgressError()
    }
  }

  async delete(providerId: string): Promise<void> {
    if (providerId !== OPENAI_CODEX_PROVIDER) return
    if (this.shared) await this.readCurrent()
    await this.assertSharedBoundary()
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    try {
      await this.withWriterLock(async () => {
        if (!this.shared) { await rm(this.filename, { force: true }); return }
        await this.recoverPending()
        let text: string
        try { text = await readFile(this.filename, 'utf8') }
        catch (error) { if (isENOENT(error)) return; throw error }
        const document = decodeSharedDocument(text)
        await writeFileAtomic(this.filename, `${JSON.stringify(document.update(undefined), null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        await syncFileAndDirectory(this.filename)
      })
    } catch (error) { if (error instanceof SharedLockBusyError) throw new OpenAICodexRefreshInProgressError(); throw error }
  }
}
