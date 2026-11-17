import { useState } from 'react'
import { GOODS, REP, repLabel } from '@/game/config'
import { gameApi, type StationSnapshot } from '@/game/uiBridge'

function fmt(n: number): string {
  return n.toLocaleString('ru-RU')
}

function mmss(sec: number): string {
  const s = Math.max(0, Math.ceil(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const KIND_NAMES: Record<string, string> = { hunt: 'Охота', transport: 'Доставка', escort: 'Эскорт', bounty: 'Головы' }

type Tab = 'trade' | 'yard' | 'repair' | 'contracts'

function RepBar({ name, v }: { name: string; v: number }) {
  // −100..100 mapped onto the bar around the neutral midline
  const left = Math.min(50, (v + 100) / 2)
  const width = Math.abs(v) / 2
  const cls = v <= REP.UNFRIENDLY ? 'bad' : v >= REP.FRIENDLY ? 'good' : ''
  return (
    <div className="rep-row">
      <span className="rep-name">{name}</span>
      <div className={`rep-bar ${cls}`}>
        <i className="rep-mid" />
        <i className="rep-fill" style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
      <span className="rep-label">{repLabel(v)}</span>
    </div>
  )
}

export function StationScreen({ s }: { s: StationSnapshot }) {
  const [tab, setTab] = useState<Tab>('trade')
  const api = () => gameApi.current

  return (
    <div className="screen station-screen">
      <div className="station-panel">
        <header className="station-header">
          <div>
            <div className="station-name">
              {s.name}
              {s.occupied && <span className="black-badge">ЧЁРНЫЙ РЫНОК</span>}
            </div>
            <div className="station-kind">{s.kindName}</div>
            <div className="station-system">{s.systemProfile}</div>
          </div>
          <div className="station-wallet">
            <div className="hud-credits">₡ {fmt(s.credits)}</div>
            <div className="hud-line">Трюм: {s.cargoUsed}/{s.cargoMax}</div>
          </div>
        </header>

        <nav className="station-tabs">
          <button className={`tab ${tab === 'trade' ? 'active' : ''}`} onClick={() => setTab('trade')}>Торговля</button>
          <button className={`tab ${tab === 'contracts' ? 'active' : ''}`} onClick={() => setTab('contracts')}>Контракты</button>
          <button className={`tab ${tab === 'yard' ? 'active' : ''}`} onClick={() => setTab('yard')}>Верфь</button>
          <button className={`tab ${tab === 'repair' ? 'active' : ''}`} onClick={() => setTab('repair')}>Ремонт</button>
        </nav>

        <div className="station-body">
          {tab === 'trade' && (
            <div className="trade-table">
              <div className="trade-row trade-head">
                <span>Товар</span><span>Цена</span><span>У вас</span><span>Сделка</span>
              </div>
              {GOODS.map((g) => {
                const p = s.prices[g.id]
                const have = s.cargo[g.id] ?? 0
                const hot = s.eventGood === g.id
                return (
                  <div className={`trade-row ${hot ? 'hot' : ''}`} key={g.id}>
                    <span className="trade-good">
                      {g.name}{hot && <em className="hot-badge">СПРОС ↑</em>}
                    </span>
                    <span className="trade-price">
                      <b>{fmt(p.buy)}</b>
                      <i> / {fmt(p.sell)}</i>
                    </span>
                    <span className="trade-have">{have}</span>
                    <span className="trade-actions">
                      <button className="mini-btn" onClick={() => api()?.buy(g.id, 1)}>+1</button>
                      <button className="mini-btn" onClick={() => api()?.buy(g.id, 10)}>+10</button>
                      <button className="mini-btn sell" disabled={have < 1} onClick={() => api()?.sell(g.id, 1)}>−1</button>
                      <button className="mini-btn sell" disabled={have < 1} onClick={() => api()?.sell(g.id, 9999)}>Всё</button>
                    </span>
                  </div>
                )
              })}
              <div className="trade-note">
                Цена покупки / цена продажи. Цены живут своей жизнью — следите за новостями.
                {s.priceNote && <span className={`price-note ${s.reputation.trader >= REP.FRIENDLY ? 'good' : 'bad'}`}> {s.priceNote}.</span>}
              </div>
            </div>
          )}

          {tab === 'contracts' && (
            <div className="contracts-wrap">
              <div className="rep-panel">
                <div className="rep-title">Репутация во фракциях</div>
                <RepBar name="Патруль" v={s.reputation.patrol} />
                <RepBar name="Торговый альянс" v={s.reputation.trader} />
                <RepBar name="Пиратские кланы" v={s.reputation.clan} />
                <div className="trade-note">
                  Союзным рейнджерам патруль не стреляет, а Альянс делает скидки на товары.
                  Сбитые конвои и гражданские топят репутацию — патруль может объявить охоту и без статуса изгоя.
                </div>
                <div className="fine-panel">
                  {s.wanted && (
                    <div className="fine-wanted">
                      {s.reputation.patrol <= REP.HOSTILE_PATROL
                        ? `☠ ВРАЖДА с патрулём (${Math.round(s.reputation.patrol)}): стреляет при виде вас. Искупление — ${REP.PARDON_KILLS} сбитых пиратов (${s.pardons}/${REP.PARDON_KILLS}) — или штраф трибунала гасят её полностью.`
                        : `⚠ Вы в розыске. Сбитые пираты идут в зачёт: ${s.pardons}/${REP.PARDON_KILLS} — или заплатите штраф.`}
                    </div>
                  )}
                  {(s.wanted || s.reputation.patrol < 0) && (
                    <button
                      className="mini-btn fine-btn"
                      disabled={s.credits < s.fineCost}
                      onClick={() => api()?.payFine()}
                    >
                      Заплатить штраф патрульному трибуналу ₡{fmt(s.fineCost)}
                      <em> — розыск снимается, Патруль +{REP.FINE.GAIN}, Альянс +{REP.FINE.TRADER_GAIN}</em>
                    </button>
                  )}
                  {!s.wanted && s.reputation.patrol >= 0 && (
                    <div className="trade-note">Претензий патруля к вам нет — трибунал без дела не держит.</div>
                  )}
                </div>
              </div>

              {s.active ? (
                <div className="contract-card active-card">
                  <div className="contract-head">
                    <span className={`contract-badge ${s.active.kind}`}>{KIND_NAMES[s.active.kind]}</span>
                    <span className="contract-title">{s.active.title}</span>
                    <span className="contract-reward">₡ {fmt(s.active.reward)}</span>
                  </div>
                  <div className="contract-desc">{s.active.desc}</div>
                  <div className="contract-meta">
                    {s.active.kind === 'hunt' || s.active.kind === 'bounty'
                      ? <>Прогресс: <b>{s.active.done}/{s.active.need}</b></>
                      : <>Ждём завершения в секторе</>}
                    {' · '}Осталось: <b>{mmss(s.active.timeLeft)}</b>
                  </div>
                  <button className="btn btn-small" onClick={() => api()?.cancelContract()}>Отменить контракт</button>
                </div>
              ) : (
                <>
                  {s.contracts.map((o) => (
                    <div className="contract-card" key={o.id}>
                      <div className="contract-head">
                        <span className={`contract-badge ${o.kind}`}>{KIND_NAMES[o.kind]}</span>
                        <span className="contract-title">{o.title}</span>
                        <span className="contract-reward">₡ {fmt(o.reward)}</span>
                      </div>
                      <div className="contract-desc">{o.desc}</div>
                      <div className="contract-meta">Лимит: <b>{Math.round(o.timeLimit / 60)} мин</b></div>
                      <button className="btn btn-small btn-primary" onClick={() => api()?.acceptContract(o.id)}>Принять</button>
                    </div>
                  ))}
                  <div className="trade-note">
                    {s.occupied
                      ? '⚑ Пиратская оккупация: брокеры Альянса эвакуированы. Доску ведут кланы: разборки, головы патруля, тёмные рейсы. Платят вперёд глазами; сорванный контракт кланы запоминают.'
                      : 'Брокер обновляет доску при каждой стыковке. Активен только один контракт; гиперпрыжок автоматически его срывает.'}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'yard' && (
            <div className="yard-list">
              {s.upgrades.map((u) => (
                <div className="yard-card" key={u.id}>
                  <div className="yard-info">
                    <div className="yard-name">
                      {u.name}
                      <span className="pips">
                        {Array.from({ length: u.maxLevel }, (_, i) => (
                          <i key={i} className={i < u.level ? 'pip on' : 'pip'} />
                        ))}
                      </span>
                    </div>
                    <div className="yard-desc">{u.desc}</div>
                    {u.nextValue !== null && (
                      <div className="yard-next">Следующий уровень: {u.nextValue}</div>
                    )}
                  </div>
                  {u.nextCost !== null ? (
                    <button
                      className="btn btn-small"
                      disabled={!u.canAfford}
                      onClick={() => api()?.upgrade(u.id)}
                    >
                      ₡ {fmt(u.nextCost)}
                    </button>
                  ) : (
                    <span className="yard-max">МАКС</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'repair' && (
            <div className="repair-block">
              <div className="repair-status">
                Корпус: <b>{s.hull}</b> / {s.maxHull}
              </div>
              <div className="bar hull big">
                <div className="bar-fill hull" style={{ width: `${(s.hull / s.maxHull) * 100}%` }} />
              </div>
              {s.hull < s.maxHull ? (
                <button
                  className="btn btn-primary"
                  disabled={s.credits < s.repairCost}
                  onClick={() => api()?.repair()}
                >
                  Полный ремонт — ₡ {fmt(s.repairCost)}
                </button>
              ) : (
                <div className="repair-ok">Корпус в идеальном состоянии.</div>
              )}
            </div>
          )}
        </div>

        <footer className="station-footer">
          <button className="btn btn-primary" onClick={() => api()?.undock()}>
            Покинуть станцию <kbd>Esc</kbd>
          </button>
        </footer>
      </div>
    </div>
  )
}
