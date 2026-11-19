import { useRef, useState } from 'react'
import { gameApi } from '@/game/uiBridge'
import { SettingsPanel } from './SettingsPanel'

export function PauseMenu({ muted }: { muted: boolean }) {
  const [settings, setSettings] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const api = () => gameApi.current

  const exportSave = () => {
    const json = api()?.exportSave()
    if (!json) { setSaveMsg('Не удалось выгрузить сейв'); return }
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'ranger-save.json'
    a.click()
    URL.revokeObjectURL(url)
    setSaveMsg('Сейв выгружен в файл')
  }

  const importSave = async (file: File | undefined) => {
    if (!file) return
    try {
      const text = await file.text()
      const ok = api()?.importSave(text) ?? false
      if (!ok) setSaveMsg('Файл не прошёл проверку — сейв не изменён')
      // при успехе игра сама переходит в playing и меню закрывается
    } catch {
      setSaveMsg('Не удалось прочитать файл')
    }
  }

  return (
    <div className="screen dim-screen">
      <div className="menu-panel">
        <h2 className="menu-title">ПАУЗА</h2>
        <div className="menu-buttons">
          <button className="btn btn-primary" onClick={() => api()?.resume()}>Продолжить</button>
          <button className="btn" onClick={() => api()?.saveNow()}>Сохранить игру</button>
          <button className="btn" onClick={exportSave}>💾 Выгрузить сейв</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>📂 Загрузить сейв</button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => { void importSave(e.target.files?.[0]); e.target.value = '' }}
          />
          <button className="btn" onClick={() => api()?.toggleMute()}>
            {muted ? '🔇 Включить звук' : '🔊 Выключить звук'}
          </button>
          <button className="btn" onClick={() => setSettings((v) => !v)}>⚙ Настройки</button>
          {settings && <SettingsPanel onClose={() => setSettings(false)} />}
          <button className="btn btn-ghost" onClick={() => api()?.toTitle()}>В главное меню</button>
        </div>
        {saveMsg && <div className="menu-note">{saveMsg}</div>}
        <div className="menu-note">Игра автоматически сохраняется при стыковке и каждые 30 секунд.</div>
      </div>
    </div>
  )
}
