/**
 * Login.tsx — экран входа/регистрации (Этап 15a; i18n и почтовая верификация — 16c).
 * Три режима: "auth" (логин/регистрация), "verify" (код из письма), "reset"
 * (сброс пароля: email → код + новый пароль). Успешный вход отдаёт Session в App.
 */

import { useEffect, useState } from "react";
import {
  ApiError,
  login,
  register,
  resendCode,
  resetConfirm,
  resetRequest,
  verifyEmail,
  type Session,
} from "@/auth/client";
import { LOCALES, setLocale, useI18n, type Locale } from "@/i18n";

type Mode = "auth" | "verify" | "reset";

export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [locale, t] = useI18n();
  const [mode, setMode] = useState<Mode>("auth");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetCodeSent, setResetCodeSent] = useState(false);

  // Сплэш первой загрузки снимается игрой при старте рендера; на экране входа
  // игры ещё нет — убираем сами, иначе он перекрывает форму.
  useEffect(() => {
    document.getElementById("boot-splash")?.remove();
  }, []);

  const failText = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "";
    const key = `login.err.${code}`;
    return t(key) !== key ? t(key) : "Ошибка: " + (code || String(e));
  };

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(failText(e));
    } finally {
      setBusy(false);
    }
  };

  const doLogin = () =>
    run(async () => {
      try {
        onLogin(await login(username.trim(), password));
      } catch (e) {
        // почта не подтверждена — сразу ведём на ввод кода
        if (e instanceof ApiError && e.code === "email_not_verified") {
          setInfo(failText(e));
          setMode("verify");
          resendCode(username.trim()).catch(() => {});
          return;
        }
        throw e;
      }
    });

  const doRegister = () =>
    run(async () => {
      const r = await register(username.trim(), password, email.trim() || undefined);
      if (r.needVerification) {
        setInfo(t("login.msg.codeSent"));
        setMode("verify");
      } else if (r.session) {
        onLogin(r.session);
      }
    });

  const doVerify = () =>
    run(async () => {
      onLogin(await verifyEmail(username.trim(), code.trim()));
    });

  const doResend = () =>
    run(async () => {
      await resendCode(username.trim());
      setInfo(t("login.msg.codeSent"));
    });

  const doResetRequest = () =>
    run(async () => {
      await resetRequest(email.trim());
      setResetCodeSent(true);
      setInfo(t("login.msg.codeSent"));
    });

  const doResetConfirm = () =>
    run(async () => {
      onLogin(await resetConfirm(email.trim(), code.trim(), password));
    });

  const langSwitch = (
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      {(Object.keys(LOCALES) as Locale[]).map((l) => (
        <button
          key={l}
          className={l === locale ? "btn btn-primary" : "btn btn-ghost"}
          style={{ padding: "2px 10px", fontSize: 12 }}
          onClick={() => setLocale(l)}
        >
          {LOCALES[l].label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="login-screen">
      <div className="login-panel">
        {langSwitch}
        <h1 className="login-title">{t("app.title")}</h1>
        <p className="login-sub">{mode === "reset" ? t("login.resetTitle") : t("login.sub")}</p>

        {mode !== "reset" && (
          <input
            className="login-input"
            placeholder={t("login.username")}
            value={username}
            autoFocus
            maxLength={24}
            disabled={mode === "verify"}
            onChange={(e) => setUsername(e.target.value)}
          />
        )}
        {mode === "auth" && (
          <>
            <input
              className="login-input"
              type="password"
              placeholder={t("login.password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
            />
            <input
              className="login-input"
              type="email"
              placeholder={t("login.email")}
              value={email}
              maxLength={100}
              onChange={(e) => setEmail(e.target.value)}
            />
          </>
        )}
        {mode === "verify" && (
          <input
            className="login-input"
            placeholder={t("login.code")}
            value={code}
            autoFocus
            maxLength={6}
            inputMode="numeric"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doVerify()}
          />
        )}
        {mode === "reset" && (
          <>
            <input
              className="login-input"
              type="email"
              placeholder={t("login.email")}
              value={email}
              autoFocus
              maxLength={100}
              disabled={resetCodeSent}
              onChange={(e) => setEmail(e.target.value)}
            />
            {resetCodeSent && (
              <>
                <input
                  className="login-input"
                  placeholder={t("login.code")}
                  value={code}
                  maxLength={6}
                  inputMode="numeric"
                  onChange={(e) => setCode(e.target.value)}
                />
                <input
                  className="login-input"
                  type="password"
                  placeholder={t("login.newPassword")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doResetConfirm()}
                />
              </>
            )}
          </>
        )}

        {error && <p className="login-error">{error}</p>}
        {info && !error && <p className="login-sub">{info}</p>}

        {mode === "auth" && (
          <>
            <button className="btn btn-primary" disabled={busy || !username.trim() || !password} onClick={doLogin}>
              {t("login.signIn")}
            </button>
            <button className="btn btn-ghost" disabled={busy || !username.trim() || !password} onClick={doRegister}>
              {t("login.register")}
            </button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12 }}
              onClick={() => {
                setMode("reset");
                setError(null);
                setInfo(null);
                setResetCodeSent(false);
                setCode("");
              }}
            >
              {t("login.forgot")}
            </button>
          </>
        )}
        {mode === "verify" && (
          <>
            <button className="btn btn-primary" disabled={busy || code.trim().length !== 6} onClick={doVerify}>
              {t("login.verify")}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={doResend}>
              {t("login.resend")}
            </button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setMode("auth")}>
              {t("login.back")}
            </button>
          </>
        )}
        {mode === "reset" && !resetCodeSent && (
          <button className="btn btn-primary" disabled={busy || !email.trim()} onClick={doResetRequest}>
            {t("login.sendCode")}
          </button>
        )}
        {mode === "reset" && resetCodeSent && (
          <button
            className="btn btn-primary"
            disabled={busy || code.trim().length !== 6 || password.length < 6}
            onClick={doResetConfirm}
          >
            {t("login.changePassword")}
          </button>
        )}
        {mode === "reset" && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12 }}
            onClick={() => {
              setMode("auth");
              setError(null);
              setInfo(null);
            }}
          >
            {t("login.back")}
          </button>
        )}
      </div>
    </div>
  );
}
