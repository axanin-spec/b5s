import { useState } from 'react'
import { gameApi } from '@/game/uiBridge'
import { SettingsPanel } from './SettingsPanel'

export function PauseMenu({ muted }: { muted: boolean }) {
  const [settings, setSettings] = useState(false)
  const api = () => gameApi.current
  return (
    <div className="screen dim-screen">
      <div className="menu-panel">
        <h2 className="menu-title">ПАУЗА</h2>
        <div className="menu-buttons">
          <button className="btn btn-primary" onClick={() => api()?.resume()}>Продолжить</button>
          <button className="btn" onClick={() => api()?.saveNow()}>Сохранить игру</button>
          <button className="btn" onClick={() => api()?.toggleMute()}>
            {muted ? '🔇 Включить звук' : '🔊 Выключить звук'}
          </button>
          <button className="btn" onClick={() => setSettings((v) => !v)}>⚙ Настройки</button>
          {settings && <SettingsPanel onClose={() => setSettings(false)} />}
          <button className="btn btn-ghost" onClick={() => api()?.toTitle()}>В главное меню</button>
        </div>
        <div className="menu-note">Игра автоматически сохраняется при стыковке и каждые 30 секунд.</div>
      </div>
    </div>
  )
}
