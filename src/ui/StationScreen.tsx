import { useCallback, useEffect, useMemo, useState } from 'react'
import { CLAN_ONLY_GOODS, GOODS, REP, repLabel } from '@/game/config'
import { gameApi, type StationSnapshot } from '@/game/uiBridge'
import { deposit, getBalance, withdraw } from '@/net/bank'
import { getSession } from '@/auth/client'
import { EquipIcon, GoodIcon } from './GoodIcon'

function fmt(n: number): string {
  return n.toLocaleString('ru-RU')
}

/** itemId «wasp-A» → id линии «wasp» — по нему ищется иконка модуля (Этап 13). */
const lineOf = (itemId: string) => itemId.slice(0, itemId.lastIndexOf('-'))

function mmss(sec: number): string {
  const s = Math.max(0, Math.ceil(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const KIND_NAMES: Record<string, string> = { hunt: 'Охота', transport: 'Доставка', escort: 'Эскорт', bounty: 'Головы' }

type Tab = 'trade' | 'yard' | 'gear' | 'repair' | 'contracts' | 'bank' | 'base'

const CAT_NAMES: Record<string, string> = { weapon: 'Орудия', shield: 'Щиты', engine: 'Двигатели' }

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

/**
 * Касса (Этап 15c, трек Б): перекидываем ₡ между кошельком в сейве и серверным
 * счётом (ledger). Сервер ведёт расчёты шара по счёту, поэтому кошелёк в рейде
 * — наличные, счёт — то, чем платят сделки. Снятие ограничено 500k/час на сервере.
 */
function BankTab({ s }: { s: StationSnapshot }) {
  const session = useMemo(getSession, [])
  const [balance, setBalance] = useState<number | null>(null)
  const [amount, setAmount] = useState('1000')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!session) return
    try { setBalance((await getBalance(session)).player) } catch { setBalance(null) }
  }, [session])
  useEffect(() => { void refresh() }, [refresh])

  if (!session) {
    return <div className="bank-note">Касса работает с подключённым сервером: войдите в аккаунт и причальте заново.</div>
  }

  const n = Math.max(0, Math.floor(Number(amount) || 0))
  const move = async (dir: 'in' | 'out') => {
    if (!n || busy || !session) return
    setBusy(true)
    setErr(null)
    try {
      if (dir === 'in') {
        await deposit(session, n)
        gameApi.current?.bankAdjust(-n) // зеркало: кошелёк худеет вместе со списанием
      } else {
        await withdraw(session, n)
        gameApi.current?.bankAdjust(n)
      }
      await refresh()
    } catch (e) {
      setErr(`Отказ сервера: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const quick = (v: number) => setAmount(String(Math.max(0, Math.floor(v))))

  return (
    <div className="bank-grid">
      <div className="bank-card">
        <h4>КОШЕЛЁК</h4>
        <div className="bank-sum">₡ {fmt(s.credits)}</div>
        <div className="bank-note">Наличные в сейве: верфь, рынки, ремонт. В шаре ими не платят.</div>
      </div>
      <div className="bank-card">
        <h4>СЧЁТ СТАНЦИИ</h4>
        <div className="bank-sum">{balance === null ? '—' : `₡ ${fmt(balance)}`}</div>
        <div className="bank-note">
          {balance === null ? 'Сервер молчит — касса недоступна.' : 'С этого счёта идут сделки с игроками.'}
        </div>
      </div>
      <div className="bank-card" style={{ gridColumn: '1 / -1' }}>
        <h4>ПЕРЕЛОЖИТЬ</h4>
        <div className="bank-quick">
          <input className="bank-amt" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button className="mini-btn" onClick={() => quick(1000)}>1k</button>
          <button className="mini-btn" onClick={() => quick(10000)}>10k</button>
          <button className="mini-btn" onClick={() => quick(100000)}>100k</button>
          <button className="mini-btn" onClick={() => quick(s.credits)}>всё наличное</button>
          {balance !== null && <button className="mini-btn" onClick={() => quick(balance)}>всё со счёта</button>}
        </div>
        <div className="bank-quick">
          <button className="btn btn-primary" disabled={busy || !n || n > s.credits} onClick={() => void move('in')}>
            Пополнить счёт — ₡ {fmt(n)}
          </button>
          <button className="btn" disabled={busy || !n || (balance ?? 0) < n} onClick={() => void move('out')}>
            Снять в кошелёк — ₡ {fmt(n)}
          </button>
        </div>
        {err && <div className="bank-err">{err}</div>}
        <div className="bank-note">Снятие со счёта ограничено 500k в час — анти-абьюз до серверной валидации событий.</div>
      </div>
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
          <button className={`tab ${tab === 'gear' ? 'active' : ''}`} onClick={() => setTab('gear')}>Снаряжение</button>
          <button className={`tab ${tab === 'repair' ? 'active' : ''}`} onClick={() => setTab('repair')}>Ремонт</button>
          <button className={`tab ${tab === 'bank' ? 'active' : ''}`} onClick={() => setTab('bank')}>Касса</button>
          <button className={`tab ${tab === 'base' ? 'active' : ''}`} onClick={() => setTab('base')}>База</button>
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
                // 14с: клановая тройка торгуется в любом порту — на союзной земле
                // из-под прилавка (уличный сходняк), на клановой — открыто
                const clanGood = CLAN_ONLY_GOODS.includes(g.id)
                return (
                  <div className={`trade-row ${hot ? 'hot' : ''}`} key={g.id}>
                    <span className="trade-good">
                      <GoodIcon id={g.id} /><b className="trade-name">{g.name}</b>
                      {hot && <em className="hot-badge">СПРОС ↑</em>}
                      {clanGood && <em className="black-badge">{s.clanMarket ? 'ЧЁРНЫЙ РЫНОК' : 'СХОДНЯК · ИЗ-ПОД ПРИЛАВКА'}</em>}
                    </span>
                    <span className="trade-price">
                      <b>{fmt(p.buy)}</b><i> / {fmt(p.sell)}</i>
                    </span>
                    <span className="trade-have">{have}</span>
                    <span className="trade-actions">
                      <button className="mini-btn" onClick={() => api()?.buy(g.id, 1)}>+1</button>
                      <button className="mini-btn" onClick={() => api()?.buy(g.id, 10)}>+10</button>
                      <button className="mini-btn" title="Набить трюм этим товаром" onClick={() => api()?.buy(g.id, 9999)}>Макс</button>
                      <button className="mini-btn sell" disabled={have < 1} onClick={() => api()?.sell(g.id, 1)}>−1</button>
                      <button className="mini-btn sell" disabled={have < 1} onClick={() => api()?.sell(g.id, 9999)}>Всё</button>
                    </span>
                  </div>
                )
              })}
              <div className="trade-foot">
                <button
                  className="btn btn-small sell"
                  disabled={s.cargoUsed < 1}
                  onClick={() => api()?.sellAll()}
                >
                  Продать весь трюм
                </button>
              </div>
              <div className="trade-note">
                Цена покупки / цена продажи. Цены живут своей жизнью — следите за новостями.
                Табак, специя и наркотики — контрабанда: в союзных портах её берут из-под прилавка —
                выплата жирнее клановой, но сделку может прервать патрульный досмотр.
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
                    {/* 13e: наследный заказ — двойная выплата из казны заказчика */}
                    {s.active.legacy && <span className="contract-badge legacy">наследный</span>}
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
                        {/* 13e: наследный заказ — двойная выплата из казны заказчика */}
                        {o.legacy && <span className="contract-badge legacy">наследный</span>}
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
              <div className="fleet-current">
                <div>
                  <span className="fleet-cur-name">{s.fleet.ship.name}</span>
                  <span className="fleet-cur-stats">
                    слоты {s.fleet.ship.slots} · трюм {s.fleet.ship.cargoMax} · скорость {s.fleet.ship.speed} · DPS {Math.round(s.fleet.ship.dps)}
                  </span>
                </div>
                {s.fleet.canSellHull && (
                  <button className="btn btn-small" onClick={() => api()?.sellHull()}>
                    Сдать на слом +₡ {fmt(s.fleet.sellHullValue)}
                  </button>
                )}
              </div>
              {s.fleet.hulls.map((h) => (
                <div className={`yard-card hull-card ${h.current ? 'current' : ''} ${!h.stock && !h.current ? 'locked' : ''}`} key={h.id}>
                  <div className="yard-info">
                    <div className="yard-name">
                      {h.name}
                      {h.current && <span className="black-badge">ВАШ КОРПУС</span>}
                    </div>
                    <div className="yard-desc">{h.desc}</div>
                    <div className="hull-stats">
                      корпус {h.hp} · скорость {h.speed} · трюм {h.cargo} · слоты о/щ/д {h.slots}
                    </div>
                  </div>
                  {h.current ? null : h.stock ? (
                    <button className="btn btn-small" disabled={!h.canAfford} onClick={() => api()?.buyHull(h.id)}>
                      {h.net >= 0 ? <>↻ ₡ {fmt(h.net)}</> : <>↻ сдача ₡ {fmt(-h.net)}</>}
                    </button>
                  ) : (
                    <span className="hull-locked">{h.why}</span>
                  )}
                </div>
              ))}
              <div className="trade-note">
                Обмен корпуса: старый идёт в зачёт по 60% цены, неподъёмный груз придётся выгрузить,
                нелезущие модули уедут на склад. Флагманы продают хабы и клановые рынки.
              </div>
            </div>
          )}

          {tab === 'gear' && (
            <div className="gear-wrap">
              <div className="gear-col">
                <div className="rep-title">Ваш фит · {s.fleet.ship.name}</div>
                {s.fleet.slotRows.map((row) => (
                  <div className="gear-cat" key={row.cat}>
                    <div className="gear-cat-name">{CAT_NAMES[row.cat]}</div>
                    {row.items.map((it) => (
                      <div className="gear-row" key={it.slot}>
                        <span className={`rank-chip ${it.itemId ? 'on' : ''}`}>{it.rank || '—'}</span>
                        {it.itemId && <EquipIcon line={lineOf(it.itemId)} className="sm" />}
                        <span className="gear-info">
                          <b>{it.name}</b>
                          <em>{it.desc}</em>
                        </span>
                        {it.itemId && (
                          <button className="mini-btn" onClick={() => api()?.unequipModule(row.cat, it.slot)}>Снять</button>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
                {s.fleet.stash.length > 0 && (
                  <div className="gear-cat">
                    <div className="gear-cat-name">Склад</div>
                    {s.fleet.stash.map((st) => (
                      <div className="gear-row" key={st.idx}>
                        <span className="rank-chip on">{st.rank}</span>
                        <EquipIcon line={lineOf(st.itemId)} className="sm" />
                        <span className="gear-info">
                          <b>{st.name}</b>
                          <em>{st.desc}{st.fits ? '' : ' · не по корпусу'}</em>
                        </span>
                        {st.fits && s.fleet.slotRows.filter((r) => r.cat === st.cat)[0]?.items.map((_, slot) => (
                          <button className="mini-btn" key={slot} onClick={() => api()?.equipModule(st.idx, st.cat, slot)}>
                            →{slot + 1}
                          </button>
                        ))}
                        <button className="mini-btn sell" onClick={() => api()?.sellModule(st.idx)}>₡{fmt(st.sell)}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="gear-col">
                <div className="rep-title">Лавка снаряжения</div>
                <div className="gear-shop">
                  {s.fleet.shop.map((g) => (
                    <div className="gear-row" key={g.itemId}>
                      <span className="rank-chip on">{g.rank}</span>
                      <EquipIcon line={lineOf(g.itemId)} className="sm" />
                      <span className="gear-info">
                        <b>{g.name}</b>
                        <em>{CAT_NAMES[g.cat]} · {g.desc}</em>
                      </span>
                      <button className="mini-btn" disabled={!g.canAfford} onClick={() => api()?.buyModule(g.itemId)}>
                        ₡ {fmt(g.cost)}
                      </button>
                    </div>
                  ))}
                </div>
                <div className="trade-note">
                  Ранги C и B лежат всюду; выше — только там, где вам доверяют: промышленные узлы,
                  хабы Альянса, а SSS — эксклюзив чёрного рынка кланов.
                </div>
              </div>
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

          {tab === 'bank' && <BankTab s={s} />}

          {tab === 'base' && (
            <div className="base-wrap">
              <div className="rep-title">
                Домашняя система: {s.base.sysName}
                {s.base.isHome && <span className="black-badge">ЭТА СТАНЦИЯ — БАЗА</span>}
              </div>
              {s.base.here ? (
                <div className="trade-table">
                  <div className="trade-row trade-head">
                    <span>Товар</span><span>На складе</span><span>В трюме</span><span>Сделка</span>
                  </div>
                  {GOODS.map((g) => {
                    const stored = s.base.cargo[g.id] ?? 0
                    const have = s.cargo[g.id] ?? 0
                    return (
                      <div className="trade-row" key={g.id}>
                        <span className="trade-good">
                          <GoodIcon id={g.id} /><b className="trade-name">{g.name}</b>
                        </span>
                        <span className="trade-have"><b>{stored}</b></span>
                        <span className="trade-have">{have}</span>
                        <span className="trade-actions">
                          <button className="mini-btn" disabled={have < 1} onClick={() => api()?.baseStore(g.id, 1)}>сдать 1</button>
                          <button className="mini-btn" disabled={have < 1} onClick={() => api()?.baseStore(g.id, 10)}>сдать 10</button>
                          <button className="mini-btn" disabled={have < 1} onClick={() => api()?.baseStore(g.id, 99999)}>всё</button>
                          <button className="mini-btn sell" disabled={stored < 1} onClick={() => api()?.baseTake(g.id, 1)}>взять 1</button>
                          <button className="mini-btn sell" disabled={stored < 1} onClick={() => api()?.baseTake(g.id, 10)}>взять 10</button>
                          <button className="mini-btn sell" disabled={stored < 1} onClick={() => api()?.baseTake(g.id, 99999)}>макс</button>
                        </span>
                      </div>
                    )
                  })}
                  <div className="trade-note">
                    Склад безлимитен: тонны просто переезжают между трюмом и ангаром — денег не стоят.
                    После гибели борта спасательный транспорт вернёт вас на базу, склад не пострадает.
                  </div>
                </div>
              ) : (
                <div className="trade-note">
                  Это не ваша база: склад открыт только в системе {s.base.sysName}.
                  {s.base.canSet ? ' Или сделайте домашней эту станцию.' : ''}
                </div>
              )}
              <div className="fine-panel">
                {s.base.canSet && !s.base.isHome && (
                  <button className="btn btn-small btn-primary" onClick={() => api()?.setHomeBase()}>
                    Сделать эту станцию домашней базой
                  </button>
                )}
                <div className="trade-note">
                  Гибель борта: корпус → стартовый «Рейнджер», установленные модули теряются,
                  трюм остаётся поддонами у обломков на десять минут. Кошелёк, банковский счёт,
                  склад модулей и склад базы — целы.
                </div>
              </div>
            </div>
          )}
        </div>

        <footer className="station-footer">
          <button className="btn btn-primary" onClick={() => api()?.undock()}>
            Покинуть станцию <kbd>Esc</kbd>
          </button>
          <button
            className="btn"
            title="Сейв пишется, борт уходит из шарда, выход в меню"
            onClick={() => api()?.endSession()}
          >
            Завершить сессию
          </button>
        </footer>
      </div>
    </div>
  )
}
