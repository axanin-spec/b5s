/**
 * en.ts — English dictionary (mirrors ru.ts keys exactly).
 */

export const en = {
  "app.title": "B5S — Beyond the 5th Sun",
  "app.tagline": "Beyond the 5th Sun",

  "login.sub": "Shared server. Enter your callsign and password.",
  "login.username": "Callsign",
  "login.password": "Password",
  "login.signIn": "Sign in",
  "login.register": "Register",
  "login.err.bad_username": "Callsign: 3–24 characters (letters, digits, _ and -)",
  "login.err.bad_password": "Password: at least 6 characters",
  "login.err.username_taken": "This callsign is already taken",
  "login.err.bad_credentials": "Wrong callsign or password",
  "login.err.rate_limited": "Too many attempts — wait a minute",
  "login.err.network": "Server unreachable — check that it is running",
} as const;
