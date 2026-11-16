import { gameApi, type EndStats } from '@/game/uiBridge'

function fmt(n: number): string {
  return n.toLocaleString('ru-RU')
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function EndScreen({ end, hasSave }: { end: EndStats; hasSave: boolean }) {
  const api = () => gameApi.current
  return (
    <div className={`screen dim-screen ${end.victory ? 'victory' : 'defeat'}`}>
      <div className="menu-panel">
        <h2 className="menu-title">{end.victory ? '🏆 ПОБЕДА' : '💥 КОРАБЛЬ УНИЧТОЖЕН'}</h2>
        <div className="end-reason">{end.reason}</div>
        <div className="end-stats">
          <div><span>Кредиты</span><b>₡ {fmt(end.credits)}</b></div>
          <div><span>Заработано всего</span><b>₡ {fmt(end.earned)}</b></div>
          <div><span>Оборот торговли</span><b>₡ {fmt(end.traded)}</b></div>
          <div><span>Пиратов уничтожено</span><b>{end.kills}</b></div>
          <div><span>Время в космосе</span><b>{fmtTime(end.playTime)}</b></div>
        </div>
        <div className="menu-buttons">
          {end.victory && (
            <button className="btn btn-primary" onClick={() => api()?.continuePlaying()}>
              Продолжить игру
            </button>
          )}
          {!end.victory && hasSave && (
            <button className="btn btn-primary" onClick={() => api()?.continueGame()}>
              Загрузить автосейв
            </button>
          )}
          <button className="btn" onClick={() => api()?.newGame()}>Новая игра</button>
          <button className="btn btn-ghost" onClick={() => api()?.toTitle()}>В главное меню</button>
        </div>
      </div>
    </div>
  )
}
