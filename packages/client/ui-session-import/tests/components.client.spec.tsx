// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionImportSection } from '../src/client/SessionImportSection.tsx'
import type {
  SessionImportSectionInjected,
  SessionImportSectionProps,
} from '../src/client/SessionImportSection.tsx'
import { en, type SessionImportLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: SessionImportLocaleKey): string => en[key]) as SessionImportSectionProps['t']

function props(overrides: Partial<SessionImportSectionInjected> = {}): SessionImportSectionProps {
  return {
    t,
    close: vi.fn(),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
    options: vi.fn(async () => ({
      ok: true,
      value: {
        sourceKinds: ['codex'],
        workspaces: [{ id: 'workspace', title: 'Project', path: '/tmp/project' }],
        presets: [{ id: 'preset', name: 'Default' }],
      },
    })),
    discover: vi.fn(async () => ({
      ok: true,
      value: {
        items: [{
          sourceKind: 'codex',
          sourceSessionId: '11111111-1111-4111-8111-111111111111',
          sizeBytes: 1024,
          modifiedAt: 1_786_665_600_000,
        }],
      },
    })),
    capture: vi.fn(async () => ({
      ok: true,
      value: {
        reservationId: 'opaque-reservation',
        sourceKind: 'codex',
        sourceSessionId: '11111111-1111-4111-8111-111111111111',
        capturedAt: 1_786_665_600_000,
        capturedBytes: 1024,
        contextBytes: 512,
        messageCount: 2,
        toolCount: 1,
        cwdHint: '/tmp/project',
        trailingPartialRecordIgnored: false,
      },
    })),
    commit: vi.fn(async () => ({
      ok: true,
      value: { sessionId: 'imported-session', existing: false, workspaceAttached: true },
    })),
    discard: vi.fn(async () => ({ ok: true, value: { discarded: true } })),
    openImported: vi.fn(async () => {}),
    ...overrides,
  } as unknown as SessionImportSectionProps
}

async function capturePreview(value: SessionImportSectionProps): Promise<void> {
  render(<SessionImportSection {...value} />)
  await screen.findByRole('button', { name: en.scan })
  fireEvent.click(screen.getByRole('button', { name: en.scan }))
  await screen.findByText('11111111-1111-4111-8111-111111111111')
  fireEvent.click(screen.getByRole('button', { name: en.capture }))
  await screen.findByRole('heading', { name: en.captured })
}

describe('SessionImportSection', () => {
  it('requires explicit target confirmation and renders metadata only', async () => {
    const value = props()
    await capturePreview(value)

    const publish = screen.getByRole('button', { name: en.import }) as HTMLButtonElement
    expect(publish.disabled).toBe(true)
    expect(screen.getByText('/tmp/project')).toBeTruthy()
    expect(document.body.textContent).not.toContain('sk-never-render-this-1234567890')
    expect(value.commit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: en.confirm }))
    expect(publish.disabled).toBe(false)
    fireEvent.click(publish)

    await waitFor(() => { expect(value.commit).toHaveBeenCalledOnce() })
    expect(value.commit).toHaveBeenCalledWith({
      reservationId: 'opaque-reservation',
      workspaceId: 'workspace',
      agentPreset: 'preset',
    }, expect.any(AbortSignal))
    await waitFor(() => { expect(value.openImported).toHaveBeenCalledWith('imported-session') })
    expect(value.close).toHaveBeenCalledOnce()
  })

  it('cancels an in-flight selected capture through AbortSignal', async () => {
    let observed: AbortSignal | undefined
    const capture = vi.fn((_request, signal: AbortSignal) => {
      observed = signal
      return new Promise<Awaited<ReturnType<SessionImportSectionInjected['capture']>>>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ ok: false, error: { code: 'cancelled', message: 'cancelled' } })
        }, { once: true })
      })
    })
    const value = props({ capture })
    render(<SessionImportSection {...value} />)
    await screen.findByRole('button', { name: en.scan })
    fireEvent.click(screen.getByRole('button', { name: en.scan }))
    await screen.findByText('11111111-1111-4111-8111-111111111111')
    fireEvent.click(screen.getByRole('button', { name: en.capture }))
    const cancel = await screen.findByRole('button', { name: en.cancel })

    await act(async () => { fireEvent.click(cancel) })

    expect(observed?.aborted).toBe(true)
    await waitFor(() => { expect(screen.queryByRole('button', { name: en.cancel })).toBeNull() })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the warning visible when post-publication workspace accounting fails', async () => {
    const value = props({
      commit: vi.fn(async () => ({
        ok: true as const,
        value: { sessionId: 'imported-session', existing: false, workspaceAttached: false },
      })),
    })
    await capturePreview(value)
    fireEvent.click(screen.getByRole('checkbox', { name: en.confirm }))
    fireEvent.click(screen.getByRole('button', { name: en.import }))

    await screen.findByText(en.workspaceAttachWarning)
    expect(value.openImported).toHaveBeenCalledWith('imported-session')
    expect(value.close).not.toHaveBeenCalled()
  })
})
