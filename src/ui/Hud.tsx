import { useEffect, useRef } from 'react'
import { REP } from '@/game/config'
import { gameApi, type Snapshot } from '@/game/uiBridge'

function fmt(n: number): string {
  return n.toLocaleString('ru-RU')
}

function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const draw = () => {
      const api = gameApi.current
      if (!api) return
      const S = canvas.width
      ctx.clearRect(0, 0, S, S)
      ctx.fillStyle = 'rgba(4,10,20,0.72)'
      ctx.fillRect(0, 0, S, S)
      ctx.strokeStyle = 'rgba(84,255,210,0.25)'
      ctx.strokeRect(0.5, 0.5, S - 1, S - 1)
      for (const b of api.getMinimap()) {
        const x = (b.x * 0.5 + 0.5) * S
        const y = (-b.y * 0.5 + 0.5) * S
        if (b.o) {
          // mission objective: pulsing diamond outline, drawn last so it stays on top
          const r = b.s + 2 + Math.sin(Date.now() / 180) * 1.5
          ctx.save()
          ctx.translate(x, y)
          ctx.rotate(Math.PI / 4)
          ctx.strokeStyle = b.c
          ctx.lineWidth = 2.5
          ctx.shadowColor = b.c
          ctx.shadowBlur = 6
          ctx.strokeRect(-r, -r, r * 2, r * 2)
          ctx.restore()
          continue
        }
        if (b.w) {
          // plotted waypoint: dashed teal ring (drawn like the objective, on top)
          ctx.strokeStyle = b.c
          ctx.lineWidth = 1.5
          ctx.setLineDash([3, 3])
          ctx.beginPath()
          ctx.arc(x, y, b.s, 0, Math.PI * 2)
          ctx.stroke()
          ctx.setLineDash([])
          continue
        }
        ctx.fillStyle = b.c
        ctx.beginPath()
        ctx.arc(x, y, b.s, 0, Math.PI * 2)
        ctx.fill()
      }
      // player heading tick
      const p = api.getPlayerHeading()
      const px = (p.x * 0.5 + 0.5) * S
      const py = (-p.y * 0.5 + 0.5) * S
      ctx.strokeStyle = '#ffffff'
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(px + Math.cos(p.a) * 9, py - Math.sin(p.a) * 9)
      ctx.stroke()
    }
    draw()
    const id = setInterval(draw, 160)
    return () => clearInterval(id)
  }, [])
  return <canvas ref={ref} className="minimap" width={300} height={300} />
}

export function Hud({ snap, isTouch }: { snap: Snapshot; isTouch: boolean }) {
  const hud = snap.hud!
  const api = () => gameApi.current
  const hullPct = Math.max(0, (hud.hull / hud.maxHull) * 100)
  const shieldPct = Math.max(0, (hud.shield / hud.maxShield) * 100)

  return (
    <>
      {/* top-left: resources */}
      <div className="hud-topleft hud-panel">
        <div className="hud-system">✦ {hud.systemName}</div>
        {hud.occupied && <div className="hud-occupied">⚑ ОККУПАЦИЯ ПИРАТОВ</div>}
        <div className="hud-credits">₡ {fmt(hud.credits)}</div>
        <div className="hud-line">Трюм: {hud.cargoUsed}/{hud.cargoMax}</div>
        <div className="hud-line">Победы: {hud.kills}</div>
        <div className="hud-rep" title="Репутация во фракциях">
          <span className={`rep-chip ${hud.rep.patrol <= REP.UNFRIENDLY ? 'bad' : hud.rep.patrol >= REP.FRIENDLY ? 'good' : ''}`}>
            Патруль {hud.rep.patrol > 0 ? '+' : ''}{Math.round(hud.rep.patrol)}
          </span>
          <span className={`rep-chip ${hud.rep.trader <= REP.UNFRIENDLY ? 'bad' : hud.rep.trader >= REP.FRIENDLY ? 'good' : ''}`}>
            Альянс {hud.rep.trader > 0 ? '+' : ''}{Math.round(hud.rep.trader)}
          </span>
        </div>
        {hud.wanted && (
          <div className="hud-outlaw">
            {hud.outlaw
              ? `⚠ РОЗЫСК — патруль стреляет · искупление ${hud.pardons}/${REP.PARDON_KILLS} пиратов`
              : `☠ ВРАЖДА с патрулём — стреляет при виде вас · искупление ${hud.pardons}/${REP.PARDON_KILLS} пиратов`}
          </div>
        )}
        {hud.contractLine && <div className="hud-contract">◈ {hud.contractLine}</div>}
        {hud.waypointName && (
          <div className="waypoint-chip">
            <span>◇ {hud.waypointName} · {(hud.waypointDist / 1000).toFixed(1)}k</span>
            <button className="wp-clear" aria-label="Снять путевую точку" onClick={() => api()?.clearWaypoint()}>✕</button>
          </div>
        )}
      </div>

      {/* top-right: minimap + buttons */}
      <div className="hud-topright">
        <Minimap />
        <div className="hud-buttons">
          <button className="icon-btn" aria-label="Звёздная карта" onClick={() => api()?.toggleMap()}>🗺</button>
          <button className="icon-btn" aria-label="Пауза" onClick={() => api()?.pause()}>⏸</button>
          <button className="icon-btn" aria-label="Звук" onClick={() => api()?.toggleMute()}>
            {snap.muted ? '🔇' : '🔊'}
          </button>
        </div>
      </div>

      {/* boss bar */}
      {hud.bossActive && (
        <div className="boss-bar">
          <div className="boss-name">ФЛАГМАН ПИРАТОВ</div>
          <div className="bar boss">
            <div className="bar-fill boss" style={{ width: `${(hud.bossHp / hud.bossMaxHp) * 100}%` }} />
          </div>
        </div>
      )}

      {/* bottom: status bars */}
      <div className="hud-bottom">
        <div className="bar-row">
          <span className="bar-label">ЩИТ</span>
          <div className="bar shield"><div className="bar-fill shield" style={{ width: `${shieldPct}%` }} /></div>
          <span className="bar-num">{hud.shield}</span>
        </div>
        <div className="bar-row">
          <span className="bar-label">КОРПУС</span>
          <div className="bar hull"><div className="bar-fill hull" style={{ width: `${hullPct}%` }} /></div>
          <span className="bar-num">{hud.hull}</span>
        </div>
        <div className="hud-speed">{hud.speed} u/s</div>
      </div>

      {/* dock prompt */}
      {hud.dockName && (
        <button className="dock-btn" onClick={() => api()?.dock()}>
          ⚓ Стыковка: {hud.dockName}{!isTouch && <kbd>E</kbd>}
        </button>
      )}

      {/* hyperspace gate prompt */}
      {!hud.dockName && hud.gateName && (
        <button className="dock-btn gate" onClick={() => api()?.jump()}>
          ⇄ Гиперпрыжок: {hud.gateName}{!isTouch && <kbd>E</kbd>}
        </button>
      )}

      {/* touch controls */}
      {isTouch && snap.screen === 'playing' && (
        <>
          <div className="stick-hint">◯</div>
          <button
            className="fire-btn"
            onPointerDown={() => api()?.setTouchFiring(true)}
            onPointerUp={() => api()?.setTouchFiring(false)}
            onPointerLeave={() => api()?.setTouchFiring(false)}
            onPointerCancel={() => api()?.setTouchFiring(false)}
            onContextMenu={(e) => e.preventDefault()}
          >
            ОГОНЬ
          </button>
        </>
      )}
    </>
  )
}
