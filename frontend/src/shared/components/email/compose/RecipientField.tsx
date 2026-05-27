// Compose recipient chip field (To / Cc / Bcc).
//
// Reuses the existing composer CSS tokens authored for the folder DraftEditor
// (`.folder-field-row` + `.recipient-chip` + `.rc-av` + `.rc-close`, see
// index.css §Composer). Enter / comma commits a chip; Backspace on an empty
// input deletes the last chip; × removes one. The owner's own address is
// filtered out so a reply-all chip set doesn't loop the mail back to the user.

import { useCallback, useState } from 'react'
import { X } from 'lucide-react'

interface Props {
  label: string
  values: string[]
  placeholder: string
  onChange: (next: string[]) => void
  /** Owner email — filtered out of additions (case-insensitive). */
  selfEmail?: string | null
}

function chipInitials(addr: string): string {
  const at = addr.split('@')[0] ?? addr
  return (at.slice(0, 2) || '?').toUpperCase()
}

/** "a@x, b@y; c@z" → ['a@x', 'b@y', 'c@z']. */
function splitTokens(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function RecipientField({
  label,
  values,
  placeholder,
  onChange,
  selfEmail
}: Props): React.ReactElement {
  const [input, setInput] = useState('')

  const normalizedSelf = (selfEmail ?? '').trim().toLowerCase()

  const addTokens = useCallback(
    (tokens: string[]) => {
      if (tokens.length === 0) return
      const seen = new Set(values.map((v) => v.toLowerCase()))
      const next = [...values]
      for (const tok of tokens) {
        const lower = tok.toLowerCase()
        if (seen.has(lower)) continue
        if (normalizedSelf && lower === normalizedSelf) continue
        seen.add(lower)
        next.push(tok)
      }
      if (next.length !== values.length) onChange(next)
    },
    [values, onChange, normalizedSelf]
  )

  const commit = useCallback(() => {
    const tokens = splitTokens(input)
    addTokens(tokens)
    setInput('')
  }, [input, addTokens])

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        commit()
      } else if (e.key === 'Backspace' && input === '' && values.length > 0) {
        onChange(values.slice(0, -1))
      }
    },
    [commit, input, values, onChange]
  )

  const removeAt = useCallback(
    (idx: number) => onChange(values.filter((_, i) => i !== idx)),
    [values, onChange]
  )

  return (
    <div className="folder-field-row">
      <span className="field-label">{label}</span>
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        {values.map((addr, i) => (
          <span key={`${addr}-${i}`} className="recipient-chip">
            <span className="rc-av">{chipInitials(addr)}</span>
            <span className="break-all">{addr}</span>
            <button
              type="button"
              className="rc-close"
              aria-label={`remove ${addr}`}
              onClick={() => removeAt(i)}
            >
              <X size={11} strokeWidth={2.2} />
            </button>
          </span>
        ))}
        <input
          value={input}
          placeholder={values.length === 0 ? placeholder : ''}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          onBlur={commit}
          aria-label={label}
        />
      </div>
    </div>
  )
}
