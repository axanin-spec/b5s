import { useState } from 'react'
import { gameApi } from '@/game/uiBridge'
import { SettingsPanel } from './SettingsPanel'

export function TitleScreen({ hasSave, muted }: { hasSave: boolean; muted: boolean }) {
  const [settings, setSettings] = useState(false)
  const api = () => gameApi.current
  return (
    <div className="screen title-screen">
      <div className="title-block">
        <div className="title-over">ОДИН КОРАБЛЬ. ТРИ СИСТЕМЫ. ЦЕЛЫЙ КОСМОС.</div>
        <h1 className="game-title">КОСМИЧЕСКИЙ<br />РЕЙНДЖЕР</h1>
        <div className="title-sub">Торгуйте между планетами · Отбивайтесь от пиратов · Прокачивайте корабль · Прыгайте между звёздными системами</div>
      </div>
      <div className="menu-buttons">
        {hasSave && (
          <button className="btn btn-primary" onClick={() => api()?.continueGame()}>
            Продолжить полёт
          </button>
        )}
        <button className={`btn ${hasSave ? '' : 'btn-primary'}`} onClick={() => api()?.newGame()}>
          Новая игра
        </button>
        <button className="btn btn-ghost" onClick={() => api()?.toggleMute()}>
          {muted ? '🔇 Звук выключен' : '🔊 Звук включён'}
        </button>
        <button className="btn btn-ghost" onClick={() => setSettings((v) => !v)}>
          ⚙ Настройки
        </button>
        {settings && <SettingsPanel onClose={() => setSettings(false)} />}
      </div>
      <div className="help-panel">
        <div className="help-col">
          <div className="help-title">Компьютер</div>
          <div><kbd>W A S D</kbd> — тяга двигателей</div>
          <div><kbd>Мышь</kbd> — прицел, <kbd>ЛКМ</kbd>/<kbd>Пробел</kbd> — огонь</div>
          <div><kbd>E</kbd> — стыковка / гиперпрыжок · <kbd>M</kbd> — звёздная карта</div>
          <div><kbd>Esc</kbd> — пауза (сначала закрывает карту)</div>
        </div>
        <div className="help-col">
          <div className="help-title">Планшет и телефон</div>
          <div>Левая половина экрана — джойстик тяги</div>
          <div>Кнопка <b>ОГОНЬ</b> — авто-прицел по ближайшему врагу</div>
          <div>Кнопки <b>СТЫКОВКА</b> и <b>ГИПЕРПРЫЖОК</b> появляются у станций и врат</div>
        </div>
      </div>
      <div className="title-foot">
        Цели: выкупить четверть экономики Галактики (доля рынка 25%) — или потопить три флагмана пиратов в оккупированных системах.
        Клавиша <b>M</b> — звёздная карта галактики. Врата на окраине системы ведут в Кронос и Никс:
        там свои специализации, свои цены и пиратский фронт. Прогресс сохраняется автоматически в этом браузере.
      </div>
    </div>
  )
}
