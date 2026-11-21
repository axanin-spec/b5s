/**
 * Home.tsx — the page that hosts the game canvas.
 *
 * React only owns the DOM shell (canvas + HUD overlay); everything inside the
 * render loop lives under src/game/ and never re-renders React. Start the game
 * in an effect and tear it down in the cleanup so React StrictMode's
 * mount → unmount → mount cycle does not leak a second renderer or loop.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { startGame, stopGame } from '@/game/boot'
import { uiBridge } from '@/game/uiBridge'
import { startNetBridge, stopNetBridge } from '@/net/bridge'
import { startNetOverlay } from '@/net/overlay'
import { TitleScreen } from '@/ui/TitleScreen'
import { Hud } from '@/ui/Hud'
import { StarMap } from '@/ui/StarMap'
import { StationScreen } from '@/ui/StationScreen'
import { PauseMenu } from '@/ui/PauseMenu'
import { EndScreen } from '@/ui/EndScreen'

function useIsTouch(): boolean {
  const ref = useRef(false)
  if (typeof window !== 'undefined' && !ref.current) {
    ref.current = window.matchMedia?.('(pointer: coarse)').matches ?? ('ontouchstart' in window)
  }
  return ref.current
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const snap = useSyncExternalStore(uiBridge.subscribe, uiBridge.getSnapshot)
  const isTouch = useIsTouch()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    startGame(canvas)
    // общий шард (15b): отправка позиции + оверлей чужих кораблей; game.ts не меняется
    startNetBridge()
    const stopOverlay = startNetOverlay(canvas.parentElement!)
    return () => {
      stopNetBridge()
      stopOverlay()
      stopGame()
    }
  }, [])

  return (
    <div id="game-root">
      <canvas id="game-canvas" ref={canvasRef} />
      {snap.damageFlash > 0 && <div key={snap.damageFlash} className="damage-flash" />}
      <div id="ui-overlay">
        {(snap.screen === 'playing' || snap.screen === 'paused') && snap.hud && (
          <Hud snap={snap} isTouch={isTouch} />
        )}
        {snap.screen === 'title' && <TitleScreen hasSave={snap.hasSave} muted={snap.muted} />}
        {snap.screen === 'paused' && <PauseMenu muted={snap.muted} />}
        {snap.mapOpen && snap.map && snap.screen === 'playing' && <StarMap map={snap.map} />}
        {snap.screen === 'docked' && snap.station && <StationScreen s={snap.station} />}
        {(snap.screen === 'gameover' || snap.screen === 'victory') && snap.end && (
          <EndScreen end={snap.end} hasSave={snap.hasSave} />
        )}
        {snap.news && snap.screen === 'playing' && (
          <div className="news-ticker">📡 {snap.news}</div>
        )}
      </div>
    </div>
  )
}
