import { useState } from 'react'
import { type GameSettings, loadSettings, updateSettings } from '@/game/settings'

/**
 * Sound settings: three live volume sliders backed by the settings store
 * (AudioSystem reacts via onSettingsChange, changes are instant and persisted).
 * Aim needs no slider — the 2D cockpit aims absolutely (cursor = aim point).
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<GameSettings>(() => loadSettings())
  const set = (k: keyof GameSettings) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setS(updateSettings({ [k]: Number(e.target.value) / 100 } as Partial<GameSettings>))
  }
  const row = (label: string, k: keyof GameSettings) => (
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
      <div className="set-note">Прицел абсолютный — курсор и есть точка прицела, чувствительность не нужна.</div>
      <button className="btn btn-small" onClick={onClose}>Готово</button>
    </div>
  )
}
