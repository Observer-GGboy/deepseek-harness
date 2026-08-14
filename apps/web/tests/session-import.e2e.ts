// Real Loader + browser composition for the local-session import workflow.
// The fixture carries visible history and one historical tool call whose body
// must never execute; a keyless replayed continuation proves the imported
// session remains an ordinary usable conversation after refresh/open.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-import-local'
import {
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./session-import.overlay.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL(
  './snapshots/session-import/continued-conversation.expected.md', import.meta.url,
))
const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const HISTORICAL_USER = 'IMPORTED_HISTORY_USER'
const HISTORICAL_ASSISTANT = 'IMPORTED_HISTORY_ASSISTANT'
const CONTINUATION_USER = 'CONTINUE_AFTER_IMPORT'
const CONTINUATION_ASSISTANT = 'CONTINUED_AFTER_IMPORT_OK'

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

describe('web e2e: import and continue a local Codex session', () => {
  let browser: Browser
  let page: Page
  let scaffold: WebScaffold
  let sourceRoot: string
  let replayRoot: string
  let tripwire: ReturnType<typeof watchConsole>
  let importedSessionId: SessionId | undefined
  let originalFixtureRoot: string | undefined

  beforeAll(async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'dsh-web-import-source-'))
    replayRoot = await mkdtemp(join(tmpdir(), 'dsh-web-import-replay-'))
    originalFixtureRoot = process.env.DSH_SESSION_IMPORT_FIXTURE_ROOT
    process.env.DSH_SESSION_IMPORT_FIXTURE_ROOT = sourceRoot
    const source = join(sourceRoot, `rollout-2026-08-14T00-00-00-${SOURCE_ID}.jsonl`)
    await writeFile(source, [
      {
        type: 'session_meta', timestamp: '2026-08-14T00:00:00.000Z',
        payload: { id: SOURCE_ID, cli_version: '0.148.0' },
      },
      {
        type: 'response_item', timestamp: '2026-08-14T00:00:01.000Z',
        payload: { type: 'message', role: 'user', content: HISTORICAL_USER },
      },
      {
        type: 'response_item', timestamp: '2026-08-14T00:00:02.000Z',
        payload: {
          type: 'function_call', call_id: 'historical-call', name: 'bash',
          arguments: '{"command":"printf HISTORICAL_TOOL_MUST_NOT_EXECUTE"}',
        },
      },
      {
        type: 'response_item', timestamp: '2026-08-14T00:00:03.000Z',
        payload: { type: 'function_call_output', call_id: 'historical-call', output: 'sk-hidden-output-1234567890' },
      },
      {
        type: 'response_item', timestamp: '2026-08-14T00:00:04.000Z',
        payload: { type: 'message', role: 'assistant', content: HISTORICAL_ASSISTANT },
      },
    ].map(line).join(''))

    const replayOverride = join(replayRoot, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify([{
      kind: 'chunks',
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: CONTINUATION_ASSISTANT },
        {
          type: 'block-end', index: 0,
          block: { type: 'text', text: CONTINUATION_ASSISTANT },
        },
        { type: 'usage', usage: { inputTokens: 64, outputTokens: 8 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    }]))
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      replayFixture: join(replayRoot, 'override-only.jsonl'),
      replayOverride,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'import-target')
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await Promise.all([sourceRoot, replayRoot].filter(Boolean).map(root =>
      rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))))
    if (originalFixtureRoot === undefined) Reflect.deleteProperty(process.env, 'DSH_SESSION_IMPORT_FIXTURE_ROOT')
    else process.env.DSH_SESSION_IMPORT_FIXTURE_ROOT = originalFixtureRoot
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'session import e2e cleanup failed')
  })

  it.skipIf(MODE === 'record')('discovers, captures, confirms, opens, and continues without replaying historical tools', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-import'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Import sessions' }).click()
    await dialog.getByRole('heading', { name: 'Import a local session' }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('radio', { name: 'Codex', exact: true }).check()
    await dialog.getByRole('button', { name: 'Find sessions' }).click()
    await dialog.getByText(SOURCE_ID, { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Read selected snapshot' }).click()
    await dialog.getByRole('heading', { name: 'Snapshot ready' }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByText('2', { exact: true }).count()).toBeGreaterThan(0)
    expect(await dialog.getByText('1', { exact: true }).count()).toBeGreaterThan(0)
    await dialog.getByRole('checkbox', {
      name: /I confirm this workspace, Agent preset, and model/u,
    }).click()
    await dialog.getByRole('button', { name: 'Import and open' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: 'Settings' }).count(), { timeout: 15_000 }).toBe(0)
    await page.getByText(HISTORICAL_ASSISTANT, { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => scaffold.ctx.sessions.list().filter(session => session.id.startsWith('import-')).length)
      .toBe(1)
    importedSessionId = scaffold.ctx.sessions.list().find(session => session.id.startsWith('import-'))?.id
    expect(importedSessionId).toBeDefined()

    const composer = page.locator('textarea:enabled').last()
    await composer.fill(CONTINUATION_USER)
    const settled = scaffold.whenTurnSettled(30_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const continuedId = await settled
    expect(continuedId).toBe(importedSessionId)
    await page.getByText(CONTINUATION_ASSISTANT, { exact: true }).waitFor({ timeout: 15_000 })

    const imported = scaffold.ctx.sessions.get(continuedId)
    if (imported === undefined) throw new Error('continued imported session is not live')
    expect(imported.events.some(event => event.type === 'session/imported')).toBe(true)
    expect(imported.events.filter(event => event.type === 'tool/call')).toHaveLength(0)
    const serialized = JSON.stringify(imported.events)
    expect(serialized).toContain(HISTORICAL_USER)
    expect(serialized).toContain(HISTORICAL_ASSISTANT)
    expect(serialized).not.toContain('HISTORICAL_TOOL_MUST_NOT_EXECUTE')
    expect(serialized).not.toContain('hidden-output')
    expect(serialized).not.toContain(sourceRoot)
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .replace(/ · \{\{throughput\}\} tok\/s/gu, '')
      .replace(/ \{\{throughput\}\} tok\/s/gu, '')
    await compareOrRefreshGolden(EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
