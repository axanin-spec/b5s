import { useEffect, useState } from 'react'
import { Routes, Route } from 'react-router'
import Home from './pages/Home'
import { Login } from './pages/Login'
import { getSession, wireRemoteSync, type Session } from './auth/client'
import { flushRemote, preloadRemote } from './game/storage'

/**
 * Этап 15a: игра запускается только после входа. Порядок:
 * сессия → wireRemoteSync → preloadRemote (облачный сейв в localStorage) → игра.
 * game/* при этом не знает про сеть: storage API остался синхронным.
 */
/** Тестовая сборка (vite --mode test) идёт без сервера: зонды грузят игру напрямую. */
const SKIP_AUTH = import.meta.env.MODE === 'test'

export default function App() {
  const [session, setSession] = useState<Session | null>(() =>
    SKIP_AUTH ? { token: '', username: 'probe' } : getSession(),
  )
  const [ready, setReady] = useState(SKIP_AUTH)

  useEffect(() => {
    if (!session || SKIP_AUTH) return
    setReady(false)
    wireRemoteSync(session)
    let cancelled = false
    preloadRemote().finally(() => {
      if (!cancelled) setReady(true)
    })
    const flush = () => flushRemote()
    window.addEventListener('beforeunload', flush)
    return () => {
      cancelled = true
      window.removeEventListener('beforeunload', flush)
    }
  }, [session])

  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<Login onLogin={setSession} />} />
      </Routes>
    )
  }
  if (!ready) return <div className="login-loading">Подключаемся к серверу…</div>
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  )
}
