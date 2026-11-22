/**
 * Login.tsx — экран входа/регистрации (Этап 15a, i18n — 2026-11-22).
 * Показывается до старта игры; успешный вход отдаёт Session наверх в App.
 * Все строки — через src/i18n (референс-реализация для остальных экранов).
 */

import { useEffect, useState } from "react";
import { ApiError, login, register, type Session } from "@/auth/client";
import { LOCALES, useI18n, type Locale } from "@/i18n";

export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [locale, t] = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Сплэш первой загрузки снимается игрой при старте рендера; на экране входа
  // игры ещё нет — убираем сами, иначе он перекрывает форму.
  useEffect(() => {
    document.getElementById("boot-splash")?.remove();
  }, []);

  const submit = async (mode: "login" | "register") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fn = mode === "login" ? login : register;
      onLogin(await fn(username.trim(), password));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setError(t(`login.err.${code}`) !== `login.err.${code}` ? t(`login.err.${code}`) : "Ошибка: " + (code || String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-panel">
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {(Object.keys(LOCALES) as Locale[]).map((l) => (
            <button
              key={l}
              className={l === locale ? "btn btn-primary" : "btn btn-ghost"}
              style={{ padding: "2px 10px", fontSize: 12 }}
              onClick={() => import("@/i18n").then((m) => m.setLocale(l))}
            >
              {LOCALES[l].label}
            </button>
          ))}
        </div>
        <h1 className="login-title">{t("app.title")}</h1>
        <p className="login-sub">{t("login.sub")}</p>
        <input
          className="login-input"
          placeholder={t("login.username")}
          value={username}
          autoFocus
          maxLength={24}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="login-input"
          type="password"
          placeholder={t("login.password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit("login")}
        />
        {error && <p className="login-error">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !username.trim() || !password} onClick={() => submit("login")}>
          {t("login.signIn")}
        </button>
        <button className="btn btn-ghost" disabled={busy || !username.trim() || !password} onClick={() => submit("register")}>
          {t("login.register")}
        </button>
      </div>
    </div>
  );
}
