/**
 * Login.tsx — экран входа/регистрации (Этап 15a).
 * Показывается до старта игры; успешный вход отдаёт Session наверх в App.
 */

import { useState } from "react";
import { ApiError, login, register, type Session } from "@/auth/client";

const ERROR_TEXT: Record<string, string> = {
  bad_username: "Позывной: 3–24 символа (буквы, цифры, _ и -)",
  bad_password: "Пароль: минимум 6 символов",
  username_taken: "Такой позывной уже занят",
  bad_credentials: "Неверный позывной или пароль",
  network: "Сервер недоступен — проверьте, что он запущен",
};

export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (mode: "login" | "register") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fn = mode === "login" ? login : register;
      onLogin(await fn(username.trim(), password));
    } catch (e) {
      setError(ERROR_TEXT[e instanceof ApiError ? e.code : ""] || "Ошибка: " + (e instanceof ApiError ? e.code : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-panel">
        <h1 className="login-title">Космический Рейнджер</h1>
        <p className="login-sub">Общий сервер. Введите позывной и пароль.</p>
        <input
          className="login-input"
          placeholder="Позывной"
          value={username}
          autoFocus
          maxLength={24}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="login-input"
          type="password"
          placeholder="Пароль"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit("login")}
        />
        {error && <p className="login-error">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !username.trim() || !password} onClick={() => submit("login")}>
          Войти
        </button>
        <button className="btn btn-ghost" disabled={busy || !username.trim() || !password} onClick={() => submit("register")}>
          Регистрация
        </button>
      </div>
    </div>
  );
}
