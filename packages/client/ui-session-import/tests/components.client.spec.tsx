// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionImportSection } from '../src/client/SessionImportSection.tsx'
import type {
  SessionImportSectionInjected,
  SessionImportSectionProps,
} from '../src/client/SessionImportSection.tsx'
import { en, type SessionImportLocaleKey } from '../src/client/locales.ts'
import { apply as applyClient } from '../src/client/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'
import { apply as applyRoot } from '../src/index.ts'

afterEach(cleanup)

const t = ((key: SessionImportLocaleKey): string => en[key]) as SessionImportSectionProps['t']

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

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
        models: [{
          provider: 'provider', model: 'model', name: 'Import model',
          contextWindow: 128_000, usableImportTokens: 106_906,
        }],
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
      provider: 'provider',
      model: 'model',
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

  it('renders empty discovery and provider failures with safe retryable status', async () => {
    const empty = props({ discover: vi.fn(async () => ({ ok: true as const, value: { items: [] } })) })
    render(<SessionImportSection {...empty} />)
    await screen.findByRole('button', { name: en.scan })
    fireEvent.click(screen.getByRole('button', { name: en.scan }))
    await screen.findByText(en.noSources)
    cleanup()

    const failed = props({ discover: vi.fn(async () => ({
      ok: false as const, error: { code: 'internal' as const, message: '' },
    })) })
    render(<SessionImportSection {...failed} />)
    await screen.findByRole('button', { name: en.scan })
    fireEvent.click(screen.getByRole('button', { name: en.scan }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toBe(en.genericFailed)
  })

  it('formats byte, kibibyte, and mebibyte source sizes and allows a different source selection', async () => {
    const value = props({
      discover: vi.fn(async () => ({
        ok: true as const,
        value: {
          items: [
            { sourceKind: 'codex' as const, sourceSessionId: 'bytes', sizeBytes: 5, modifiedAt: 1 },
            { sourceKind: 'codex' as const, sourceSessionId: 'mebibytes', sizeBytes: 2 * 1024 * 1024, modifiedAt: 2 },
          ],
        },
      })),
    })
    render(<SessionImportSection {...value} />)
    await screen.findByRole('button', { name: en.scan })
    fireEvent.click(screen.getByRole('button', { name: en.scan }))
    expect(await screen.findByText(`${en.sourceSize}: 5 B`)).toBeTruthy()
    expect(screen.getByText(`${en.sourceSize}: 2.0 MiB`)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /mebibytes/u }))
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /mebibytes/u }).checked).toBe(true)
  })

  it('handles option rejection, selected capture rejection, and thrown operations', async () => {
    render(<SessionImportSection {...props({ options: vi.fn(async () => {
      throw new Error('private transport detail')
    }) })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.loadFailed)
    cleanup()

    const captureFailed = props({ capture: vi.fn(async () => ({
      ok: false as const, error: { code: 'source-corrupt' as const, message: 'Safe capture failure' },
    })) })
    render(<SessionImportSection {...captureFailed} />)
    await screen.findByRole('button', { name: en.scan })
    fireEvent.click(screen.getByRole('button', { name: en.scan }))
    await screen.findByText('11111111-1111-4111-8111-111111111111')
    fireEvent.click(screen.getByRole('button', { name: en.capture }))
    expect((await screen.findByRole('alert')).textContent).toBe('Safe capture failure')
    cleanup()

    const thrown = props({ discover: vi.fn(async () => { throw new Error('private') }) })
    render(<SessionImportSection {...thrown} />)
    await screen.findByRole('button', { name: en.scan })
    fireEvent.click(screen.getByRole('button', { name: en.scan }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.genericFailed)
  })

  it('renders a safe unsupported-version diagnosis without the untrusted version value', async () => {
    const unsafeVersion = 'Bearer sk-ui-version-secret-1234567890'
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = props({ capture: vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'unsupported-version' as const,
        sourceKind: 'codex' as const,
        record: 1,
        message: 'codex version at record 1 is unsupported',
        unsafeVersion,
      },
    })) })
    try {
      render(<SessionImportSection {...value} />)
      await screen.findByRole('button', { name: en.scan })
      fireEvent.click(screen.getByRole('button', { name: en.scan }))
      await screen.findByText('11111111-1111-4111-8111-111111111111')
      fireEvent.click(screen.getByRole('button', { name: en.capture }))
      expect((await screen.findByRole('alert')).textContent)
        .toBe('codex version at record 1 is unsupported')
      expect(document.body.textContent).not.toContain(unsafeVersion)
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('handles rejected and empty option sets without inventing target choices', async () => {
    render(<SessionImportSection {...props({ options: vi.fn(async () => ({
      ok: false as const, error: { code: 'internal' as const, message: '' },
    })) })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.loadFailed)
    cleanup()

    render(<SessionImportSection {...props({ options: vi.fn(async () => ({
      ok: true as const,
      value: { sourceKinds: [], workspaces: [], presets: [], models: [] },
    })) })} />)
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en.scan }).disabled).toBe(false)
    })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
  })

  it('drops settled option and operation results after unmount or supersession', async () => {
    const lateOptions = deferred<Awaited<ReturnType<SessionImportSectionInjected['options']>>>()
    const mounted = render(<SessionImportSection {...props({ options: vi.fn(() => lateOptions.promise) })} />)
    mounted.unmount()
    await act(async () => {
      lateOptions.resolve({
        ok: true,
        value: { sourceKinds: ['codex'], workspaces: [], presets: [], models: [] },
      })
      await lateOptions.promise
    })

    const rejectedOptions = deferred<Awaited<ReturnType<SessionImportSectionInjected['options']>>>()
    const rejected = render(<SessionImportSection {...props({ options: vi.fn(() => rejectedOptions.promise) })} />)
    rejected.unmount()
    await act(async () => {
      rejectedOptions.reject(new Error('late'))
      await rejectedOptions.promise.catch(() => {})
    })

    const first = deferred<Awaited<ReturnType<SessionImportSectionInjected['discover']>>>()
    const second = deferred<Awaited<ReturnType<SessionImportSectionInjected['discover']>>>()
    const discover = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    render(<SessionImportSection {...props({ discover })} />)
    const scan = await screen.findByRole('button', { name: en.scan })
    fireEvent.click(scan)
    fireEvent.click(scan)
    await act(async () => {
      first.resolve({ ok: true, value: { items: [] } })
      second.resolve({ ok: true, value: { items: [] } })
      await Promise.all([first.promise, second.promise])
    })
    expect(await screen.findByText(en.noSources)).toBeTruthy()
  })

  it('suppresses an aborted operation rejection after a replacement starts', async () => {
    let calls = 0
    const discover = vi.fn((_request, signal: AbortSignal) => {
      calls += 1
      if (calls === 2) return Promise.resolve({ ok: true as const, value: { items: [] } })
      return new Promise<Awaited<ReturnType<SessionImportSectionInjected['discover']>>>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new DOMException('cancelled', 'AbortError')) }, { once: true })
      })
    })
    render(<SessionImportSection {...props({ discover })} />)
    const scan = await screen.findByRole('button', { name: en.scan })
    fireEvent.click(scan)
    fireEvent.click(scan)
    expect(await screen.findByText(en.noSources)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('suppresses an operation rejection caused by unmount cancellation', async () => {
    const discover = vi.fn((_request, signal: AbortSignal) =>
      new Promise<Awaited<ReturnType<SessionImportSectionInjected['discover']>>>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new DOMException('cancelled', 'AbortError')) }, { once: true })
      }))
    const mounted = render(<SessionImportSection {...props({ discover })} />)
    const scan = await screen.findByRole('button', { name: en.scan })
    fireEvent.click(scan)
    await act(async () => { mounted.unmount() })
    expect(discover).toHaveBeenCalledOnce()
  })

  it('resets confirmation when a target changes and discards on reselection and unmount', async () => {
    const value = props({
      options: vi.fn(async () => ({
        ok: true as const,
        value: {
          sourceKinds: ['codex', 'claude-code'] as const,
          workspaces: [
            { id: 'workspace', title: 'Project', path: '/tmp/project' },
            { id: 'other', title: 'Other', path: '/tmp/other' },
          ],
          presets: [{ id: 'preset', name: 'Default' }, { id: 'other-preset', name: 'Other' }],
          models: [
            { provider: 'provider', model: 'model', name: 'Import model', contextWindow: 128_000, usableImportTokens: 100_000 },
            { provider: 'provider', model: 'other', name: 'Other model', contextWindow: 64_000, usableImportTokens: 50_000 },
          ],
        },
      })),
      capture: vi.fn(async () => ({
        ok: true as const,
        value: {
          reservationId: 'reservation-change', sourceKind: 'codex' as const,
          sourceSessionId: '11111111-1111-4111-8111-111111111111', capturedAt: 1,
          capturedBytes: 10, contextBytes: 10, messageCount: 1, toolCount: 0,
          trailingPartialRecordIgnored: true,
        },
      })),
    })
    const rendered = render(<SessionImportSection {...value} />)
    await screen.findByRole('button', { name: en.scan })
    fireEvent.click(screen.getByRole('radio', { name: en.claudeCode }))
    fireEvent.click(screen.getByRole('radio', { name: en.codex }))
    fireEvent.click(screen.getByRole('button', { name: en.scan }))
    await screen.findByText('11111111-1111-4111-8111-111111111111')
    fireEvent.click(screen.getByRole('button', { name: en.capture }))
    await screen.findByRole('heading', { name: en.captured })
    expect(screen.getByText(en.partialTail)).toBeTruthy()
    expect(screen.getByText(en.noCwdHint)).toBeTruthy()
    const selects = screen.getAllByRole('combobox')
    fireEvent.click(screen.getByRole('checkbox', { name: en.confirm }))
    fireEvent.change(selects[0]!, { target: { value: 'other' } })
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.confirm }).checked).toBe(false)
    fireEvent.change(selects[1]!, { target: { value: 'other-preset' } })
    fireEvent.change(selects[2]!, { target: { value: 'provider\0other' } })
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    await waitFor(() => { expect(value.discard).toHaveBeenCalledWith('reservation-change') })
    rendered.unmount()
  })

  it('shows commit failures and keeps an imported session open failure actionable', async () => {
    const failed = props({ commit: vi.fn(async () => ({
      ok: false as const, error: { code: 'context-too-large' as const, message: 'Choose another model or cancel.' },
    })) })
    await capturePreview(failed)
    fireEvent.click(screen.getByRole('checkbox', { name: en.confirm }))
    fireEvent.click(screen.getByRole('button', { name: en.import }))
    expect((await screen.findByRole('alert')).textContent).toBe('Choose another model or cancel.')
    cleanup()

    const openFailed = props({ openImported: vi.fn(async () => { throw new Error('navigation') }) })
    await capturePreview(openFailed)
    fireEvent.click(screen.getByRole('checkbox', { name: en.confirm }))
    fireEvent.click(screen.getByRole('button', { name: en.import }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.genericFailed)
  })
})

describe('client registration', () => {
  it('wires every Remote method, refresh/open path, root loader, and invariant', async () => {
    let slot: { inject: () => SessionImportSectionInjected; label: () => string } | undefined
    const opened: string[] = []
    const remote = {
      options: vi.fn(async () => ({ ok: true, value: await props().options(new AbortController().signal) })),
      discover: vi.fn(async () => ({ ok: false, error: { code: 'transport' } })),
      capture: vi.fn(async () => ({ ok: true, value: await props().capture({
        sourceKind: 'codex', sourceSessionId: 'id',
      }, new AbortController().signal) })),
      commit: vi.fn(async () => ({ ok: true, value: await props().commit({
        reservationId: 'r', workspaceId: 'w', agentPreset: 'p', provider: 'provider', model: 'model',
      }, new AbortController().signal) })),
      discard: vi.fn(async () => ({ ok: true, value: { ok: true, value: { discarded: true } } })),
    }
    const ctx = {
      effect: (factory: () => unknown) => factory(),
      locale: {
        register: vi.fn(() => () => {}),
        bind: vi.fn(() => t),
      },
      remote: { sessionImportLocal: remote },
      sessions: {
        refresh: vi.fn(async () => {}),
        open: (id: string) => { opened.push(id) },
      },
      slots: {
        inject: (_name: string, factory: () => unknown) => factory(),
        register: (definition: { inject: () => SessionImportSectionInjected; label: () => string }) => {
          slot = definition
          return () => {}
        },
      },
    }
    applyRoot()
    applyClient(ctx as never)
    if (slot === undefined) throw new Error('slot was not registered')
    const injected = slot.inject()
    expect(slot.label()).toBe(en.nav)
    await expect(injected.options(new AbortController().signal)).resolves.toMatchObject({ ok: true })
    await expect(injected.discover({ sourceKind: 'codex' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
    await expect(injected.capture({ sourceKind: 'codex', sourceSessionId: 'id' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: true })
    await expect(injected.commit({
      reservationId: 'r', workspaceId: 'w', agentPreset: 'p', provider: 'provider', model: 'model',
    }, new AbortController().signal)).resolves.toMatchObject({ ok: true })
    await expect(injected.discard('r')).resolves.toMatchObject({ ok: true })
    await injected.openImported('session')
    expect(opened).toEqual(['session'])

    const dispose = () => {}
    const register = (name: string, install: () => void): (() => void) => {
      expect(name).toBe('@deepseek-ai/dsh-client-ui-session-import')
      install()
      return dispose
    }
    await expect(applyInvariant({ invariants: { register } } as never)).resolves.toBe(dispose)
  })
})
