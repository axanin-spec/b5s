import { useCallback, useEffect, useRef, useState } from 'react'
import { CLAN_ONLY_GOODS, GOODS } from '@/game/config'
import { gameApi, type MapSnapshot } from '@/game/uiBridge'

/** Fixed galaxy positions for the six chart nodes (canvas fractions), hexagonal ring. */
const GAL_POS: Record<string, [number, number]> = {
  eidolon: [0.5, 0.135],
  aurora: [0.85, 0.31],
  kronos: [0.85, 0.69],
  nix: [0.5, 0.865],
  terminus: [0.15, 0.69],
  kar: [0.15, 0.31],
}

function mmss(sec: number): string {
  const s = Math.max(0, Math.ceil(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function priceLabel(level: number): string {
  return level < 0.95 ? 'дешёвая — закупаться' : level > 1.05 ? 'дорогая — продавать' : 'рыночные цены'
}

/** Age of a market observation vs snapshot time; stale after 10 game minutes. */
function intelAge(map: MapSnapshot, t: number): { text: string; stale: boolean } {
  const d = Math.max(0, map.now - t)
  if (d < 60) return { text: 'только что', stale: false }
  const stale = d > 600
  if (d < 3600) return { text: `${Math.floor(d / 60)} мин назад`, stale }
  return { text: `${Math.floor(d / 3600)} ч назад`, stale: true }
}

function statusLine(map: MapSnapshot, id: string): { text: string; cls: string } {
  const sys = map.systems.find((s) => s.id === id)
  if (!sys) return { text: '', cls: '' }
  if (sys.occupied) {
    return { text: '⚑ Под пиратами — чёрный рынок, патруля нет', cls: 'bad' }
  }
  if (map.occ && !map.occ.held && map.occ.systemId === id) {
    return { text: `Освобождена. Кланам нужно ещё ${mmss(map.occ.timer)}`, cls: 'good' }
  }
  return { text: 'Свободна, патруль на позициях', cls: 'good' }
}

/**
 * Star chart overlay (M): «Галактика» — all six systems, their specialization and
 * the pirate front; «Система» — schematic of any system, click a body or a gate in
 * the current one to plot a course. Live, non-modal — the world ticks on behind.
 */
export function StarMap({ map }: { map: MapSnapshot }) {
  const [tab, setTab] = useState<'galaxy' | 'system'>('galaxy')
  const [viewId, setViewId] = useState<string>(map.currentId)
  const [selId, setSelId] = useState<string>(map.currentId)
  const [hint, setHint] = useState<string | null>(null)
  /** Этап 10a: «Рынки» on the system tab — collapsed until asked for. */
  const [mkOpen, setMkOpen] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef(map)
  mapRef.current = map

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const m = mapRef.current
    const S = canvas.width
    const pulse = 0.55 + Math.sin(Date.now() / 220) * 0.3
    ctx.clearRect(0, 0, S, S)

    if (tab === 'galaxy') {
      // jump lanes: every system links every other (one gate per neighbour) — faint full mesh
      ctx.strokeStyle = 'rgba(140,190,220,0.12)'
      ctx.lineWidth = 1
      const ids = m.systems.map((s) => s.id)
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = GAL_POS[ids[i]], b = GAL_POS[ids[j]]
          if (!a || !b) continue
          ctx.beginPath(); ctx.moveTo(a[0] * S, a[1] * S); ctx.lineTo(b[0] * S, b[1] * S); ctx.stroke()
        }
      }
      for (const s of m.systems) {
        const pos = GAL_POS[s.id]
        if (!pos) continue
        const x = pos[0] * S, y = pos[1] * S
        if (s.id === selId) {
          ctx.strokeStyle = 'rgba(255,255,255,0.8)'
          ctx.setLineDash([4, 4])
          ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2); ctx.stroke()
          ctx.setLineDash([])
        }
        const col = s.occupied ? '#ff5a4a' : '#54ffd2'
        ctx.shadowColor = col
        ctx.shadowBlur = 12
        ctx.fillStyle = col
        ctx.globalAlpha = s.occupied ? 0.5 + pulse * 0.5 : 1
        ctx.beginPath(); ctx.arc(x, y, s.current ? 14 : 11, 0, Math.PI * 2); ctx.fill()
        ctx.shadowBlur = 0
        ctx.globalAlpha = 1
        if (s.current) {
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke()
        }
        if (s.flagship) {
          ctx.font = '13px system-ui'
          ctx.fillStyle = '#ffd24a'
          ctx.textAlign = 'center'
          ctx.fillText('☠', x, y - 20)
        }
        ctx.font = 'bold 11px system-ui'
        ctx.fillStyle = '#eafff8'
        ctx.textAlign = 'center'
        ctx.fillText(s.name, x, y + 34)
        ctx.font = '9px system-ui'
        ctx.fillStyle = 'rgba(143,169,182,0.9)'
        ctx.fillText(s.profile, x, y + 46)
      }
      return
    }

    /* ---- system schematic ---- */
    const layout = m.layouts.find((l) => l.id === viewId)
    if (!layout) return
    const R = S / 2 // normalized [-1,1] → canvas
    const px = (v: number) => (v * 0.5 + 0.5) * S
    // orbit guides
    ctx.strokeStyle = 'rgba(140,190,220,0.10)'
    ctx.lineWidth = 1
    for (const b of layout.bodies) {
      const rr = Math.hypot(b.x, b.y) * R
      ctx.beginPath(); ctx.arc(S / 2, S / 2, rr, 0, Math.PI * 2); ctx.stroke()
    }
    // star
    const g = ctx.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, 26)
    g.addColorStop(0, 'rgba(255,220,140,1)')
    g.addColorStop(1, 'rgba(255,160,60,0)')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(S / 2, S / 2, 26, 0, Math.PI * 2); ctx.fill()

    // gates
    for (const gt of layout.gates) {
      const x = px(gt.x), y = px(-gt.y)
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(Math.PI / 4)
      ctx.strokeStyle = '#54ffd2'
      ctx.lineWidth = 1.5
      ctx.strokeRect(-4.5, -4.5, 9, 9)
      ctx.restore()
      ctx.font = '9px system-ui'
      ctx.fillStyle = 'rgba(84,255,210,0.85)'
      ctx.textAlign = 'center'
      ctx.fillText(`→ ${gt.name}`, x, y - 9)
    }
    // bodies
    for (const b of layout.bodies) {
      const x = px(b.x), y = px(-b.y)
      ctx.fillStyle = b.c
      ctx.globalAlpha = b.station ? 0.9 : 1
      ctx.beginPath(); ctx.arc(x, y, Math.max(3, b.r * R), 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 1
      ctx.font = b.station ? '8px system-ui' : '9px system-ui'
      ctx.fillStyle = 'rgba(200,220,230,0.75)'
      ctx.textAlign = 'center'
      ctx.fillText(b.label, x, y + Math.max(3, b.r * R) + 10)
    }
    // live contacts + player (current system only)
    if (viewId === m.currentId) {
      for (const sh of m.ships) {
        ctx.fillStyle = sh.c
        ctx.beginPath(); ctx.arc(px(sh.x), px(-sh.y), 2, 0, Math.PI * 2); ctx.fill()
      }
      if (m.objective) {
        const x = px(m.objective.x), y = px(-m.objective.y)
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(Math.PI / 4)
        ctx.strokeStyle = m.objective.c
        ctx.lineWidth = 2
        const r = 5 + pulse * 2
        ctx.strokeRect(-r, -r, r * 2, r * 2)
        ctx.restore()
      }
      if (m.waypoint) {
        const x = px(m.waypoint.x), y = px(-m.waypoint.y)
        ctx.strokeStyle = '#54ffd2'
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(px(m.player.x), px(-m.player.y))
        ctx.lineTo(x, y)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke()
      }
      const pxx = px(m.player.x), pyy = px(-m.player.y)
      ctx.save()
      ctx.translate(pxx, pyy)
      ctx.rotate(-m.player.a)
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.moveTo(7, 0); ctx.lineTo(-5, -4.5); ctx.lineTo(-5, 4.5)
      ctx.closePath(); ctx.fill()
      ctx.restore()
    }
  }, [tab, viewId, selId])

  // redraw on fresh snapshot (parent re-renders ~8 Hz while open) + slow pulse
  useEffect(() => { draw() }, [draw, map])
  useEffect(() => {
    const id = setInterval(draw, 250)
    return () => clearInterval(id)
  }, [draw])

  const onCanvasClick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    if (tab === 'galaxy') {
      let bestId: string | null = null
      let bestD = 0.09
      for (const s of map.systems) {
        const pos = GAL_POS[s.id]
        if (!pos) continue
        const d = Math.hypot(pos[0] - fx, pos[1] - fy)
        if (d < bestD) { bestD = d; bestId = s.id }
      }
      if (bestId) setSelId(bestId)
      return
    }
    if (viewId !== map.currentId) return
    const nx = fx * 2 - 1
    const ny = -(fy * 2 - 1)
    const layout = map.layouts.find((l) => l.id === viewId)
    if (!layout) return
    let best: { kind: 'dockable' | 'gate'; id: string; d: number } | null = null
    for (const b of layout.bodies) {
      const d = Math.hypot(b.x - nx, b.y - ny)
      if (d < 0.08 && (!best || d < best.d)) best = { kind: 'dockable', id: b.id, d }
    }
    for (const g of layout.gates) {
      const d = Math.hypot(g.x - nx, g.y - ny)
      if (d < 0.07 && (!best || d < best.d)) best = { kind: 'gate', id: g.to, d }
    }
    if (best) {
      gameApi.current?.setWaypoint(best.kind, best.id)
      setHint(null)
    }
  }

  const sel = map.systems.find((s) => s.id === selId) ?? map.systems[0]
  const st = statusLine(map, sel.id)

  return (
    <div className="starmap hud-panel">
      <div className="starmap-tabs">
        <button className={`tab ${tab === 'galaxy' ? 'active' : ''}`} onClick={() => setTab('galaxy')}>Галактика</button>
        <button className={`tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>Система</button>
        <button className="sm-close" aria-label="Закрыть карту" onClick={() => gameApi.current?.closeMap()}>✕ <kbd>M</kbd></button>
      </div>

      <canvas
        ref={canvasRef}
        className="sm-canvas"
        width={380}
        height={380}
        onPointerDown={onCanvasClick}
      />

      {tab === 'system' && (
        <div className="sm-views">
          {map.systems.map((s) => (
            <button
              key={s.id}
              className={`sm-chip ${viewId === s.id ? 'on' : ''} ${s.occupied ? 'bad' : ''}`}
              onClick={() => setViewId(s.id)}
            >
              {s.occupied ? '⚑ ' : ''}{s.name}
            </button>
          ))}
        </div>
      )}

      {/* Этап 10a: разведка рынков показанной системы — что видели при стыковке */}
      {tab === 'system' && (() => {
        const lay = map.layouts.find((l) => l.id === viewId)
        if (!lay) return null
        const intel = new Map(map.intel.filter((i) => i.systemId === viewId).map((i) => [i.dockableId, i]))
        const seen = lay.bodies.filter((b) => intel.has(b.id)).length
        return (
          <div className="sm-markets">
            <button className="sm-mk-head" onClick={() => setMkOpen((v) => !v)}>
              {mkOpen ? '▾' : '▸'} Рынки
              <span className="sm-mk-count">{seen}/{lay.bodies.length} разведано</span>
            </button>
            {mkOpen && (
              <table className="sm-mk-table">
                <thead>
                  <tr>
                    <th className="sm-mk-th-name">Станция</th>
                    {GOODS.map((g) => <th key={g.id}>{g.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {lay.bodies.map((b) => {
                    const it = intel.get(b.id)
                    if (!it) {
                      return (
                        <tr key={b.id} className="sm-mk-none">
                          <td className="sm-mk-name">{b.label}</td>
                          <td colSpan={GOODS.length}>нет данных — стыкуйтесь</td>
                        </tr>
                      )
                    }
                    const age = intelAge(map, it.t)
                    return (
                      <tr key={b.id} className={age.stale ? 'stale' : undefined}>
                        <td className="sm-mk-name">
                          {it.name}
                          <span className="sm-mk-age">{age.text}{age.stale ? ' · устарело' : ''}</span>
                        </td>
                        {GOODS.map((g) => {
                          const q = it.prices[g.id]
                          // 14g: тройка в союзном доку не торгуется; старые снимки
                          // (clan не записан) показываем как раньше — докинг обновит
                          const ban = it.clan === false && CLAN_ONLY_GOODS.includes(g.id)
                          return (
                            <td key={g.id} className={`sm-mk-cell${ban ? ' mk-ban' : ''}`}>
                              {ban ? <span title="запрещено Альянсом">⊘</span> : q ? <><span className="b">{q.buy}</span><span className="s">{q.sell}</span></> : '—'}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )
      })()}

      <div className={`sm-info ${tab === 'system' ? 'hidden' : ''}`} hidden={tab !== 'galaxy'}>
        <div className="sm-name">
          {sel.name}
          {sel.current && <span className="sm-here">ВЫ ЗДЕСЬ</span>}
          {sel.occupied && <span className="black-badge">ЧЁРНЫЙ РЫНОК</span>}
        </div>
        <div className="sm-prof">{sel.profile} · {sel.desc}</div>
        <div className="sm-meta">Рынок: {priceLabel(sel.priceLevel)}</div>
        {sel.occupied && (
          <div className="sm-meta">
            {sel.flagship ? <span className="bad">☠ Флагман кланов на орбите — берите его</span>
              : <span>Флагман достраивается: {mmss(map.occ?.timer ?? 0)}</span>}
          </div>
        )}
        <div className={`sm-status ${st.cls}`}>{st.text}</div>
        {(() => {
          const r = map.raid
          const nameOf = (id: string) => map.systems.find((s) => s.id === id)?.name ?? id
          if (r && r.timeLeft > 0 && r.targetId === sel.id) {
            return (
              <div className="sm-meta bad">
                ⚔ ОПЕРАЦИЯ ИДЁТ · {mmss(r.timeLeft)} · складов взято {r.grabbed}
              </div>
            )
          }
          if (sel.occupied) {
            return <div className="sm-meta">Налёт здесь нечего брать — у кланов общий котёл.</div>
          }
          if (r && r.timeLeft > 0) {
            return (
              <button className="btn btn-small" disabled>
                ⚔ Идёт операция: {nameOf(r.targetId)} · {mmss(r.timeLeft)}
              </button>
            )
          }
          if (r && r.cooldown > 0) {
            return (
              <button className="btn btn-small" disabled>
                Оперштаб остывает · {mmss(r.cooldown)}
              </button>
            )
          }
          return (
            <button className="btn btn-small" onClick={() => gameApi.current?.startRaid(sel.id)}>
              ⚔ Налёт на {sel.name} · ≈₡{sel.raidEst.toLocaleString('ru-RU')}/склад
            </button>
          )
        })()}
        <button
          className="btn btn-small"
          onClick={() => { setViewId(sel.id); setTab('system') }}
        >
          Схема системы
        </button>
      </div>

      <div className="sm-hint">
        {tab === 'galaxy'
          ? 'Клик по узлу — сводка и налёт. Красный — оккупирован.'
          : viewId === map.currentId
            ? hint ?? 'Клик по станции, планете или вратам — проложить курс.'
            : 'Чужая система — схема для планирования прыжка.'}
      </div>
    </div>
  )
}
