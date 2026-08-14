/**
 * Explicit destination choice for a credential reference already used by a
 * different provider profile. The component receives reference names and
 * route identities only; credential values never enter its props or copy.
 */

import { useId } from 'react'
import type { ReactNode } from 'react'
import type { CredentialReferenceUse } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The two intentional outcomes for a colliding credential write. */
export type CredentialReferenceMode = 'separate' | 'share'

/** Props of {@link CredentialReferenceChoice}. */
export interface CredentialReferenceChoiceProps {
  /** Other profiles that already name the shared reference. */
  conflicts: readonly CredentialReferenceUse[]
  /** Reference the colliding profiles currently share. */
  sharedRef: string
  /** Route-scoped reference used by the safe default. */
  independentRef: string
  /** Current explicit form choice. */
  mode: CredentialReferenceMode
  /** Update the form choice. */
  onModeChange: (mode: CredentialReferenceMode) => void
  /** Disable the choice while the card cannot accept edits. */
  disabled: boolean
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Replace named placeholders without interpreting replacement characters. */
function copy(template: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, () => value),
    template,
  )
}

/** Stable, unambiguous visible identity for one conflicting provider. */
function providerLabel(use: CredentialReferenceUse): string {
  return use.provider === use.displayName
    ? use.provider
    : `${use.displayName} (${use.provider})`
}

/** Render the native radio group used to make credential sharing explicit. */
export function CredentialReferenceChoice(props: CredentialReferenceChoiceProps): ReactNode {
  const id = useId()
  const descriptionId = `${id}-description`
  const owners = props.conflicts.map(providerLabel).join(', ')
  const conflictCopy = copy(props.t('credentialCollision'), {
    reference: props.sharedRef,
    providers: owners,
  })
  const separateCopy = copy(props.t('credentialSeparate'), { reference: props.independentRef })
  const shareCopy = copy(props.t('credentialShare'), { reference: props.sharedRef })

  return (
    <fieldset
      className={styles['credentialChoice']}
      aria-describedby={descriptionId}
      disabled={props.disabled}
    >
      <legend className={styles['credentialChoiceLegend']}>{props.t('credentialChoice')}</legend>
      <p id={descriptionId} className={styles['credentialChoiceDescription']}>{conflictCopy}</p>
      <label className={styles['credentialChoiceOption']}>
        <input
          type="radio"
          name={`${id}-credential-mode`}
          value="separate"
          checked={props.mode === 'separate'}
          onChange={() => { props.onModeChange('separate') }}
        />
        <span>
          <span className={styles['credentialChoiceLabel']}>{separateCopy}</span>
          <span className={styles['credentialChoiceHint']}>{props.t('credentialSeparateHint')}</span>
        </span>
      </label>
      <label className={styles['credentialChoiceOption']}>
        <input
          type="radio"
          name={`${id}-credential-mode`}
          value="share"
          checked={props.mode === 'share'}
          onChange={() => { props.onModeChange('share') }}
        />
        <span>
          <span className={styles['credentialChoiceLabel']}>{shareCopy}</span>
          <span className={styles['credentialChoiceHint']}>{props.t('credentialShareHint')}</span>
        </span>
      </label>
    </fieldset>
  )
}
