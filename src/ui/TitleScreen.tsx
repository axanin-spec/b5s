import { useState } from 'react'
import { gameApi } from '@/game/uiBridge'
import { SettingsPanel } from './SettingsPanel'
import { LOCALES, setLocale, useI18n, type Locale } from '@/i18n'

export function TitleScreen({ muted }: { muted: boolean }) {
  const [settings, setSettings] = useState(false)
  const [locale, t] = useI18n()
  const api = () => gameApi.current
  return (
    <div className="screen title-screen">
      <div className="title-block">
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 8 }}>
          {(Object.keys(LOCALES) as Locale[]).map((l) => (
            <button
              key={l}
              className={l === locale ? 'btn btn-primary' : 'btn btn-ghost'}
              style={{ padding: '2px 10px', fontSize: 12 }}
              onClick={() => setLocale(l)}
            >
              {LOCALES[l].label}
            </button>
          ))}
        </div>
        <div className="title-over">{t('title.over')}</div>
        <h1 className="game-title">
          {t('title.name')}
          <br />
          <span style={{ fontSize: '0.42em', letterSpacing: '0.18em' }}>{t('title.nameSub')}</span>
        </h1>
        <div className="title-sub">{t('title.sub')}</div>
      </div>
      <div className="menu-buttons">
        <button className="btn btn-primary" onClick={() => api()?.continueGame()}>
          {t('title.fly')}
        </button>
        <button className="btn btn-ghost" onClick={() => api()?.toggleMute()}>
          {muted ? t('title.soundOff') : t('title.soundOn')}
        </button>
        <button className="btn btn-ghost" onClick={() => setSettings((v) => !v)}>
          {t('title.settings')}
        </button>
        {settings && <SettingsPanel onClose={() => setSettings(false)} />}
      </div>
      <div className="help-panel">
        <div className="help-col">
          <div className="help-title">{t('title.helpPc')}</div>
          <div><kbd>W A S D</kbd> — {t('title.helpPc1')}</div>
          <div><kbd>{t('title.helpMouse')}</kbd> — {t('title.helpPc2')} <kbd>ЛКМ</kbd>/<kbd>Space</kbd> — {t('title.helpPc3')}</div>
          <div><kbd>E</kbd> — {t('title.helpPc4')} · <kbd>M</kbd> — {t('title.helpPc5')}</div>
          <div><kbd>Esc</kbd> — {t('title.helpPc6')}</div>
        </div>
        <div className="help-col">
          <div className="help-title">{t('title.helpTouch')}</div>
          <div>{t('title.helpTouch1')}</div>
          <div><b>{t('title.fire')}</b> — {t('title.helpTouch2')}</div>
          <div><b>{t('title.dock')}</b> & <b>{t('title.jump')}</b> — {t('title.helpTouch3')}</div>
        </div>
      </div>
      <div className="title-foot">{t('title.foot')}</div>
    </div>
  )
}
