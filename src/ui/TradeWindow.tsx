import { useEffect, useState } from 'react'
import { GOODS, WORLD_CFG } from '@/game/config'
import { gameApi } from '@/game/uiBridge'
import { worldNet } from '@/net/world'
import { GoodIcon } from './GoodIcon'

/**
 * TradeWindow.tsx — торговля игроков в общем шаре (Этап 15c, трек Б).
 * Три секции: входящие офферы (принять/отклонить), мои заявки (отменить/статус),
 * и конструктор оффера соседу по системе. Кредиты в шаре идут через серверный
 * ledger, товары переходят на клиентах — перенос в трюмы делает game.ts по
 * trade_done; здесь только сверка условий и отправка.
 */

function fmt(n: number): string {
  return n.toLocaleString('ru-RU')
}

/** Радиус «рядом» — те же метры, что TRADE_MAX_RANGE на сервере. */
const TRADE_RADIUS = 1500

type Goods = Record<string, number>

const GOOD_NAME = (id: string) => GOODS.find((g) => g.id === id)?.name ?? id
const qtySum = (g: Goods) => Object.values(g).reduce((a, b) => a + b, 0)

function chips(g: Goods) {
  return Object.entries(g).map(([id, q]) => (
    <span className="cargo-chip" key={id}><GoodIcon id={id} className="sm" />×{q}</span>
  ))
}

/** Последний исход сделки по id в ленте worldNet (новые — в конце). */
function eventOf(id: string) {
  for (let i = worldNet.tradeEvents.length - 1; i >= 0; i--) {
    if (worldNet.tradeEvents[i].id === id) return worldNet.tradeEvents[i]
  }
  return null
}

function failText(reason?: string): string {
  if (reason === 'expired') return 'время вышло'
  if (reason === 'offline') return 'собеседник отвалился'
  if (reason === 'insufficient_funds') return 'на счёте собеседника не хватило'
  return reason ?? 'сбой'
}

function statusText(e: NonNullable<ReturnType<typeof eventOf>>): string {
  switch (e.t) {
    case 'trade_done': return 'закрыта ✓'
    case 'trade_declined': return 'отклонена'
    case 'trade_cancelled': return 'отменена'
    default: return `сорвалась: ${failText(e.reason)}`
  }
}

export function TradeWindow({ cargo, systemName, onClose }: {
  cargo: Goods; systemName: string; onClose: () => void
}) {
  // worldNet мутируем на месте; на каждый emit транспорта — перерисовка
  const [, setTick] = useState(0)
  useEffect(() => worldNet.subscribe(() => setTick((v) => v + 1)), [])

  const [targetId, setTargetId] = useState('')
  const [giveC, setGiveC] = useState('0')
  const [wantC, setWantC] = useState('0')
  const [giveQty, setGiveQty] = useState<Goods>({})
  const [wantQty, setWantQty] = useState<Goods>({})
  const [sent, setSent] = useState<{ id: string; toName: string }[]>([])

  const api = () => gameApi.current
  const me = api()?.getPlayerHeading()
  const incoming = [...worldNet.tradeOffers.values()].filter((o) => o.from !== worldNet.selfId)
  const mineSent = sent.filter((s) => !eventOf(s.id))
  const resolved = sent.length - mineSent.length

  // 13e: у соседа-победителя титул 🏆 в ростере (state.legend из шарда)
  const nearby: { id: string; name: string; dist: number; legend: boolean }[] = []
  if (me) {
    for (const pl of worldNet.players.values()) {
      if (pl.id === worldNet.selfId || pl.dead || !pl.state) continue
      const st = pl.state
      if (st.sys && st.sys !== systemName) continue
      const dist = Math.hypot(st.x - me.x, st.y - me.y) * WORLD_CFG.HALF
      if (dist <= TRADE_RADIUS) nearby.push({ id: pl.id, name: pl.username, dist, legend: !!st.legend })
    }
  }

  const setQty = (g: Goods, id: string, v: number) => ({ ...g, [id]: Math.max(0, Math.round(v)) })

  const send = () => {
    if (!targetId) return
    const give: Goods = {}
    const want: Goods = {}
    for (const [k, v] of Object.entries(giveQty)) if (v > 0) give[k] = v
    for (const [k, v] of Object.entries(wantQty)) if (v > 0) want[k] = v
    const id = api()?.netTradeCreate(targetId, {
      giveCredits: Number(giveC) || 0, wantCredits: Number(wantC) || 0,
      giveGoods: give, wantGoods: want,
    })
    if (id) {
      setSent((s) => [...s, { id, toName: nearby.find((n) => n.id === targetId)?.name ?? 'сосед' }])
      setGiveQty({}); setWantQty({}); setGiveC('0'); setWantC('0')
    }
  }

  return (
    <div className="trade-win hud-panel">
      <div className="trade-head">
        🤝 БОРТОВОЙ РЫНОК · {systemName}
        <button className="wp-clear" aria-label="Закрыть" onClick={onClose}>✕</button>
      </div>

      {incoming.length > 0 && (
        <div className="trade-sec">
          <div className="radio-sec-title">ВХОДЯЩИЕ</div>
          {incoming.map((o) => (
            <div className="trade-row" key={o.id}>
              <div className="trade-peer">{o.fromName}</div>
              <div className="trade-terms">
                <span>отдаёт {o.giveCredits > 0 ? `₡${fmt(o.giveCredits)} ` : ''}{chips(o.giveGoods)}</span>
                <span>хочет {o.wantCredits > 0 ? `₡${fmt(o.wantCredits)} ` : ''}{chips(o.wantGoods)}</span>
              </div>
              <div className="trade-acts">
                <button className="radio-btn" onClick={() => api()?.netTradeAccept(o.id)}>Принять</button>
                <button className="radio-btn sell" onClick={() => worldNet.declineTrade(o.id)}>Нет</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(mineSent.length > 0 || resolved > 0) && (
        <div className="trade-sec">
          <div className="radio-sec-title">МОИ ЗАЯВКИ</div>
          {mineSent.map((s) => (
            <div className="trade-row" key={s.id}>
              <div className="trade-peer">{s.toName}</div>
              <div className="trade-terms"><span>ждёт ответа</span></div>
              <div className="trade-acts">
                <button className="radio-btn sell" onClick={() => worldNet.cancelTrade(s.id)}>Отозвать</button>
              </div>
            </div>
          ))}
          {sent.slice().reverse().filter((s) => eventOf(s.id)).slice(0, 3).map((s) => (
            <div className="trade-row done" key={s.id}>
              <div className="trade-peer">{s.toName}</div>
              <div className="trade-terms"><span>{statusText(eventOf(s.id)!)}</span></div>
            </div>
          ))}
        </div>
      )}

      {nearby.length === 0 ? (
        <div className="radio-empty">рядом (≤{(TRADE_RADIUS / 1000).toFixed(1)}k) никого нет на волне</div>
      ) : (
        <div className="trade-sec">
          <div className="radio-sec-title">СОСЕДИ ПОД БОТОМ</div>
          {nearby.map((n) => (
            <button
              key={n.id}
              className={`trade-peer-pick ${targetId === n.id ? 'active' : ''}`}
              onClick={() => setTargetId(n.id)}
            >
              {n.legend && '🏆 '}{n.name} · {(n.dist / 1000).toFixed(1)}k
            </button>
          ))}

          <div className="trade-draft">
            <label className="trade-cred">отдам ₡
              <input type="number" min={0} value={giveC} onChange={(e) => setGiveC(e.target.value)} />
            </label>
            <label className="trade-cred">за ₡
              <input type="number" min={0} value={wantC} onChange={(e) => setWantC(e.target.value)} />
            </label>
          </div>

          {GOODS.filter((g) => (cargo[g.id] ?? 0) > 0).map((g) => (
            <div className="trade-row" key={g.id}>
              <span className="radio-good"><GoodIcon id={g.id} className="sm" />{g.name} · {cargo[g.id]}</span>
              <span className="radio-acts">
                <button className="radio-btn" onClick={() => setGiveQty((q) => setQty(q, g.id, (q[g.id] ?? 0) + 1))}>+ отдам</button>
                <button className="radio-btn sell" onClick={() => setGiveQty((q) => setQty(q, g.id, (q[g.id] ?? 0) - 1))}>−</button>
                <b>{giveQty[g.id] ?? 0}</b>
              </span>
            </div>
          ))}

          <div className="trade-sec">
            <div className="radio-sec-title">ЗАИНТЕРЕСОВАЛО</div>
            <div className="trade-draft">
              <select
                className="trade-good-pick"
                value=""
                onChange={(e) => { if (e.target.value) setWantQty((q) => setQty(q, e.target.value, (q[e.target.value] ?? 0) + 1)) }}
              >
                <option value="" disabled>товар…</option>
                {GOODS.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            {Object.entries(wantQty).filter(([, q]) => q > 0).map(([id, q]) => (
              <div className="trade-row" key={id}>
                <span className="radio-good"><GoodIcon id={id} className="sm" />{GOOD_NAME(id)}</span>
                <span className="radio-acts">
                  <button className="radio-btn" onClick={() => setWantQty((s) => setQty(s, id, s[id] + 1))}>+</button>
                  <button className="radio-btn sell" onClick={() => setWantQty((s) => setQty(s, id, s[id] - 1))}>−</button>
                  <b>{q}</b>
                </span>
              </div>
            ))}
          </div>

          <button className="btn btn-primary" disabled={!targetId} onClick={send}>
            Предложить · примут — трюм освободим
          </button>
          <div className="trade-note">
            Кредиты сделка снимает с серверного счёта (как в кассе), товары переезжают
            при взаимном «да». Просят больше, чем влезет в трюм, — откажем сами.
            {qtySum(giveQty) > 0 || qtySum(wantQty) > 0 ? '' : ' Пока в оферте только кредиты.'}
          </div>
        </div>
      )}
    </div>
  )
}

/** Кнопка на HUD + окно; живёт только когда шард онлайн, бейдж — число входящих. */
export function NetTradeDock({ cargo, systemName }: { cargo: Goods; systemName: string }) {
  const [online, setOnline] = useState(worldNet.status === 'online')
  const [badge, setBadge] = useState(worldNet.tradeOffers.size)
  const [open, setOpen] = useState(false)
  useEffect(() => worldNet.subscribe(() => {
    setOnline(worldNet.status === 'online')
    setBadge(worldNet.tradeOffers.size)
  }), [])
  if (!online) return null
  return (
    <>
      <button
        className={`icon-btn${badge > 0 ? ' net-hint' : ''}`}
        aria-label="Бортовой рынок"
        onClick={() => setOpen((v) => !v)}
      >
        🤝{badge > 0 && <span className="net-badge">{badge}</span>}
      </button>
      {open && <TradeWindow cargo={cargo} systemName={systemName} onClose={() => setOpen(false)} />}
    </>
  )
}
