/**
 * en.ts — English dictionary (mirrors ru.ts keys exactly).
 */

export const en = {
  "app.title": "B5S — Beyond the 5th Sun",
  "app.tagline": "Beyond the 5th Sun",

  "login.sub": "Shared server. Enter your callsign and password.",
  "login.username": "Callsign",
  "login.password": "Password",
  "login.email": "Email (for registration)",
  "login.signIn": "Sign in",
  "login.register": "Register",
  "login.forgot": "Forgot password?",
  "login.back": "← Back",
  "login.code": "Code from the email",
  "login.verify": "Confirm",
  "login.resend": "Resend code",
  "login.sendCode": "Send code",
  "login.newPassword": "New password",
  "login.changePassword": "Change password",
  "login.resetTitle": "Password reset",
  "login.msg.codeSent": "Code sent — check your inbox (valid for 15 minutes)",
  "login.err.bad_username": "Callsign: 3–24 characters (letters, digits, _ and -)",
  "login.err.bad_password": "Password: at least 6 characters",
  "login.err.username_taken": "This callsign is already taken",
  "login.err.bad_credentials": "Wrong callsign or password",
  "login.err.rate_limited": "Too many attempts — wait a minute",
  "login.err.network": "Server unreachable — check that it is running",
  "login.err.bad_email": "Enter a valid email",
  "login.err.email_taken": "This email is already linked to an account",
  "login.err.bad_code": "Wrong code",
  "login.err.code_expired": "Code expired — request a new one",
  "login.err.too_many_attempts": "Too many attempts — request a new code",
  "login.err.email_not_verified": "Email not verified — enter the code from the email",
  "login.err.mail_failed": "Could not send the email — try again later",
} as const;
