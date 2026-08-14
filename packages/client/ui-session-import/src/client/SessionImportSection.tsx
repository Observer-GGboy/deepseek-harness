import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SessionImportCaptureRequest,
  SessionImportCaptureValue,
  SessionImportCommitRequest,
  SessionImportCommitValue,
  SessionImportDiscoverRequest,
  SessionImportDiscoverValue,
  SessionImportDiscardValue,
  SessionImportOptionsValue,
  SessionImportResult,
} from '@deepseek-ai/dsh-session-import-local/types'
import type { SessionImportLocaleKey } from './locales.ts'
import css from './SessionImportSection.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.sessionImport': SessionImportLocaleKey
  }
}

/** Registration-side actions; Remote transport stays out of the component. */
export interface SessionImportSectionInjected {
  options: (signal: AbortSignal) => Promise<SessionImportResult<SessionImportOptionsValue>>
  discover: (
    request: SessionImportDiscoverRequest,
    signal: AbortSignal,
  ) => Promise<SessionImportResult<SessionImportDiscoverValue>>
  capture: (
    request: SessionImportCaptureRequest,
    signal: AbortSignal,
  ) => Promise<SessionImportResult<SessionImportCaptureValue>>
  commit: (
    request: SessionImportCommitRequest,
    signal: AbortSignal,
  ) => Promise<SessionImportResult<SessionImportCommitValue>>
  discard: (reservationId: string) => Promise<SessionImportResult<SessionImportDiscardValue>>
  openImported: (sessionId: string) => Promise<void>
}

export type SessionImportSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.sessionImport'>
  & InjectFace<SessionImportSectionInjected>

type Busy = 'options' | 'discover' | 'capture' | 'commit' | null

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

/** Accessible selected-source → metadata preview → explicit confirmation flow. */
export function SessionImportSection(props: SessionImportSectionProps): ReactNode {
  const { options, discover, capture, commit, discard, openImported, close, t } = props
  const sourceLegend = useId()
  const [optionValue, setOptionValue] = useState<SessionImportOptionsValue | null>(null)
  const [kind, setKind] = useState<'codex' | 'claude-code'>('codex')
  const [sources, setSources] = useState<SessionImportDiscoverValue['items']>([])
  const [selected, setSelected] = useState('')
  const [scanned, setScanned] = useState(false)
  const [snapshot, setSnapshot] = useState<SessionImportCaptureValue | null>(null)
  const [workspaceId, setWorkspaceId] = useState('')
  const [preset, setPreset] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<Busy>('options')
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const operation = useRef<AbortController | null>(null)
  const reservation = useRef<string | null>(null)

  const run = async <T,>(
    phase: Exclude<Busy, null>,
    task: (signal: AbortSignal) => Promise<SessionImportResult<T>>,
  ): Promise<T | null> => {
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setBusy(phase)
    setError(null)
    let result: SessionImportResult<T>
    try {
      result = await task(controller.signal)
    } catch {
      if (operation.current === controller) {
        operation.current = null
        setBusy(null)
        if (!controller.signal.aborted) setError(t('genericFailed'))
      }
      return null
    }
    if (operation.current !== controller) return null
    operation.current = null
    setBusy(null)
    if (!result.ok) {
      if (result.error.code !== 'cancelled') setError(result.error.message || t('genericFailed'))
      return null
    }
    return result.value
  }

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    void options(controller.signal).then((result) => {
      if (!current) return
      setBusy(null)
      if (!result.ok) {
        setError(result.error.message || t('loadFailed'))
        return
      }
      setOptionValue(result.value)
      const firstKind = result.value.sourceKinds[0]
      if (firstKind !== undefined) setKind(firstKind)
      const firstWorkspace = result.value.workspaces[0]
      const firstPreset = result.value.presets[0]
      if (firstWorkspace !== undefined) setWorkspaceId(firstWorkspace.id)
      if (firstPreset !== undefined) setPreset(firstPreset.id)
    })
    return () => {
      current = false
      controller.abort()
      operation.current?.abort()
      const id = reservation.current
      if (id !== null) void discard(id)
    }
  }, [discard, options, t])

  const clearSnapshot = (): void => {
    const id = reservation.current
    reservation.current = null
    if (id !== null) void discard(id)
    setSnapshot(null)
    setConfirmed(false)
    setWarning(null)
  }

  const scan = async (): Promise<void> => {
    clearSnapshot()
    setSources([])
    setSelected('')
    setScanned(false)
    const found = await run('discover', signal => discover({ sourceKind: kind }, signal))
    if (found === null) return
    setScanned(true)
    setSources(found.items)
    if (found.items[0] !== undefined) setSelected(found.items[0].sourceSessionId)
  }

  const readSnapshot = async (): Promise<void> => {
    if (selected === '') return
    clearSnapshot()
    const value = await run('capture', signal => capture({
      sourceKind: kind,
      sourceSessionId: selected,
    }, signal))
    if (value === null) return
    reservation.current = value.reservationId
    setSnapshot(value)
    const hinted = optionValue?.workspaces.find(workspace => workspace.path === value.cwdHint)
    if (hinted !== undefined) setWorkspaceId(hinted.id)
  }

  const publish = async (): Promise<void> => {
    if (snapshot === null || !confirmed || workspaceId === '' || preset === '') return
    const value = await run('commit', signal => commit({
      reservationId: snapshot.reservationId,
      workspaceId,
      agentPreset: preset,
    }, signal))
    if (value === null) return
    reservation.current = null
    if (!value.workspaceAttached) setWarning(t('workspaceAttachWarning'))
    try {
      await openImported(value.sessionId)
      if (value.workspaceAttached) close()
    } catch {
      setError(t('genericFailed'))
    }
  }

  const sourceRows = useMemo(() => sources.map(source => ({
    ...source,
    modified: new Date(source.modifiedAt).toLocaleString(),
  })), [sources])

  const waiting = busy !== null
  return (
    <section className={css.section} aria-busy={waiting}>
      <header className={css.header}>
        <h2>{t('title')}</h2>
        <p>{t('intro')}</p>
      </header>

      <div className={css.safety}>
        <h3>{t('safetyTitle')}</h3>
        <ul>
          <li>{t('safetySource')}</li>
          <li>{t('safetyTools')}</li>
          <li>{t('safetyTrust')}</li>
        </ul>
      </div>

      <fieldset className={css.fieldset} disabled={waiting || snapshot !== null}>
        <legend id={sourceLegend}>{t('sourceKind')}</legend>
        <div className={css.inlineChoices}>
          {optionValue?.sourceKinds.map(sourceKind => (
            <label key={sourceKind}>
              <input
                type="radio"
                name="session-import-source-kind"
                value={sourceKind}
                checked={kind === sourceKind}
                onChange={() => {
                  setKind(sourceKind)
                  setSources([])
                  setSelected('')
                  setScanned(false)
                  clearSnapshot()
                }}
              />
              <span>{t(sourceKind === 'codex' ? 'codex' : 'claudeCode')}</span>
            </label>
          ))}
        </div>
        <button className={css.secondaryButton} type="button" onClick={() => { void scan() }}>
          {busy === 'discover' ? t('scanning') : t('scan')}
        </button>
      </fieldset>

      {sourceRows.length > 0 ? (
        <fieldset className={css.fieldset} disabled={waiting || snapshot !== null}>
          <legend>{t('sourceSession')}</legend>
          <div className={css.sourceList}>
            {sourceRows.map(source => (
              <label className={css.sourceRow} key={source.sourceSessionId}>
                <input
                  type="radio"
                  name="session-import-source"
                  value={source.sourceSessionId}
                  checked={selected === source.sourceSessionId}
                  onChange={() => { setSelected(source.sourceSessionId) }}
                />
                <span className={css.sourceIdentity}>{source.sourceSessionId}</span>
                <span>{t('sourceSize')}: {bytes(source.sizeBytes)}</span>
                <span>{t('sourceModified')}: {source.modified}</span>
              </label>
            ))}
          </div>
          <button
            className={css.primaryButton}
            type="button"
            disabled={selected === ''}
            onClick={() => { void readSnapshot() }}
          >
            {busy === 'capture' ? t('capturing') : t('capture')}
          </button>
        </fieldset>
      ) : scanned && busy === null ? <p className={css.muted}>{t('noSources')}</p> : null}

      {snapshot !== null ? (
        <div className={css.preview}>
          <div className={css.previewHeading}>
            <h3>{t('captured')}</h3>
            <button className={css.textButton} type="button" onClick={clearSnapshot}>{t('discard')}</button>
          </div>
          <dl className={css.facts}>
            <div><dt>{t('messages')}</dt><dd>{snapshot.messageCount}</dd></div>
            <div><dt>{t('tools')}</dt><dd>{snapshot.toolCount}</dd></div>
            <div><dt>{t('context')}</dt><dd>{bytes(snapshot.contextBytes)}</dd></div>
            <div><dt>{t('cwdHint')}</dt><dd>{snapshot.cwdHint ?? t('noCwdHint')}</dd></div>
          </dl>
          {snapshot.trailingPartialRecordIgnored ? <p className={css.notice}>{t('partialTail')}</p> : null}

          <label className={css.control}>
            <span>{t('workspace')}</span>
            <select value={workspaceId} onChange={(event) => {
              setWorkspaceId(event.currentTarget.value)
              setConfirmed(false)
            }}>
              <option value="">{t('chooseWorkspace')}</option>
              {optionValue?.workspaces.map(workspace => (
                <option key={workspace.id} value={workspace.id}>{workspace.title} — {workspace.path}</option>
              ))}
            </select>
          </label>
          <label className={css.control}>
            <span>{t('preset')}</span>
            <select value={preset} onChange={(event) => {
              setPreset(event.currentTarget.value)
              setConfirmed(false)
            }}>
              <option value="">{t('choosePreset')}</option>
              {optionValue?.presets.map(option => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </label>
          <label className={css.confirm}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => { setConfirmed(event.currentTarget.checked) }}
            />
            <span>{t('confirm')}</span>
          </label>
          <button
            className={css.primaryButton}
            type="button"
            disabled={!confirmed || workspaceId === '' || preset === '' || waiting}
            onClick={() => { void publish() }}
          >
            {busy === 'commit' ? t('importing') : t('import')}
          </button>
        </div>
      ) : null}

      {waiting && busy !== 'options' ? (
        <div className={css.progress} role="status" aria-live="polite">
          <span className={css.spinner} aria-hidden="true" />
          <span>{busy === 'discover' ? t('scanning') : busy === 'capture' ? t('capturing') : t('importing')}</span>
          {busy === 'capture' || busy === 'commit' ? (
            <button type="button" className={css.textButton} onClick={() => { operation.current?.abort() }}>
              {t('cancel')}
            </button>
          ) : null}
        </div>
      ) : null}
      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
      {warning !== null ? <p className={css.notice} role="status">{warning}</p> : null}
    </section>
  )
}
