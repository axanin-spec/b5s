/**
 * settings.ts — persisted player settings (localStorage `game.settings`).
 * Volumes are 0..1 linear. AudioSystem subscribes via onSettingsChange and applies
 * them live; the UI mutates through updateSettings so every consumer stays in sync.
 * Defensive like save.ts: anything malformed on load falls back to defaults.
 */

export interface GameSettings {
  master: number;
  music: number;
  sfx: number;
}

const SETTINGS_KEY = "game.settings";

export const DEFAULT_SETTINGS: GameSettings = { master: 0.5, music: 0.8, sfx: 0.85 };

function vol(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fb;
}

export function loadSettings(): GameSettings {
  const d = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Record<string, unknown>;
    return {
      master: vol(s.master, d.master),
      music: vol(s.music, d.music),
      sfx: vol(s.sfx, d.sfx),
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage blocked — settings last for this session only
  }
}

const listeners = new Set<(s: GameSettings) => void>();

/** Subscribe to live changes; returns the unsubscribe fn (AudioSystem wires it in ctor). */
export function onSettingsChange(fn: (s: GameSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function updateSettings(patch: Partial<GameSettings>): GameSettings {
  const s = { ...loadSettings(), ...patch };
  const clamp = (v: number | undefined, fb: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fb;
  s.master = clamp(s.master, DEFAULT_SETTINGS.master);
  s.music = clamp(s.music, DEFAULT_SETTINGS.music);
  s.sfx = clamp(s.sfx, DEFAULT_SETTINGS.sfx);
  saveSettings(s);
  for (const fn of listeners) fn(s);
  return s;
}
