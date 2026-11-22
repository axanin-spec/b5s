import { useState } from 'react'
import { gameApi } from '@/game/uiBridge'
import { SettingsPanel } from './SettingsPanel'
import { useI18n } from '@/i18n'

export function PauseMenu({ muted }: { muted: boolean }) {
  const [settings, setSettings] = useState(false)
  const [, t] = useI18n()
  const api = () => gameApi.current

  // Этап 17: ручные сейвы убраны — откат прогресса невозможен, мир живой.
  // Автосейв (стыковка + 30 с) пишется в облако автоматически.
  return (
    <div className="screen dim-screen">
      <div className="menu-panel">
        <h2 className="menu-title">{t('pause.title')}</h2>
        <div className="menu-buttons">
          <button className="btn btn-primary" onClick={() => api()?.resume()}>{t('pause.resume')}</button>
          <button className="btn" onClick={() => api()?.toggleMute()}>
            {muted ? t('title.soundOff') : t('title.soundOn')}
          </button>
          <button className="btn" onClick={() => setSettings((v) => !v)}>{t('title.settings')}</button>
          {settings && <SettingsPanel onClose={() => setSettings(false)} />}
          <button className="btn btn-ghost" onClick={() => api()?.toTitle()}>{t('pause.toTitle')}</button>
        </div>
        <div className="menu-note">{t('pause.note')}</div>
      </div>
    </div>
  )
}
