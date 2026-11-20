import { useState } from 'react'
import { type GameSettings, type RenderPref, loadSettings, updateSettings } from '@/game/settings'

/**
 * Player settings: three live volume sliders + render-backend picker (Этап 12d), backed
 * by the settings store (AudioSystem/Game subscribe via onSettingsChange — instant, persisted).
 * Aim needs no slider — the 2D cockpit aims absolutely (cursor = aim point).
 */
const RENDER_OPTS: { v: RenderPref; label: string }[] = [
  { v: 'auto', label: 'Авто' },
  { v: '2d', label: '2D' },
  { v: '3d', label: '3D' },
]

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<GameSettings>(() => loadSettings())
  type NumKey = 'master' | 'music' | 'sfx'
  const set = (k: NumKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setS(updateSettings({ [k]: Number(e.target.value) / 100 } as Partial<GameSettings>))
  }
  const row = (label: string, k: NumKey) => (
    <label className="set-row">
      <span className="set-label">{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(s[k] * 100)}
        style={{ '--fill': `${Math.round(s[k] * 100)}%` } as React.CSSProperties}
        onChange={set(k)}
      />
      <span className="set-val">{Math.round(s[k] * 100)}%</span>
    </label>
  )
  return (
    <div className="set-panel">
      <div className="set-title">ЗВУК</div>
      {row('Общая громкость', 'master')}
      {row('Музыка', 'music')}
      {row('Эффекты', 'sfx')}
      <div className="set-title">ГРАФИКА</div>
      <div className="set-row">
        <span className="set-label">Рендер</span>
        <div className="set-seg" role="radiogroup" aria-label="Рендер">
          {RENDER_OPTS.map((o) => (
            <button
              key={o.v}
              type="button"
              role="radio"
              aria-checked={s.render === o.v}
              className={`set-seg-btn${s.render === o.v ? ' on' : ''}`}
              onClick={() => setS(updateSettings({ render: o.v }))}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="set-val" />
      </div>
      <div className="set-note">
        Авто включает 3D при поддержке WebGL2. Смена применяется сразу; при потере
        WebGL-контекста игра сама откатится в 2D.
      </div>
      <div className="set-note">Прицел абсолютный — курсор и есть точка прицела, чувствительность не нужна.</div>
      <button className="btn btn-small" onClick={onClose}>Готово</button>
    </div>
  )
}
