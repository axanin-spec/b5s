/**
 * audio.ts — sound: sampled SFX (Stable Audio Open) over a synthesized fallback,
 * per-system background music (ACE-Step) with crossfade on jump, and a procedural
 * combat pulse driven by threat level. Mute is remembered in localStorage.
 *
 * Signal chain: destination ← limiter ← master(user master volume/mute) ←
 *   ├─ sfxBus   (user SFX volume) — sampled + synthesized shots
 *   └─ musicBus (user music volume) ← musicDuck(threat ducking) ← layers/pad,
 *      the combat pulse sits on musicBus above the duck (it IS the threat).
 * The limiter (DynamicsCompressor) keeps salvo pile-ups from clipping.
 */

import { type GameSettings, loadSettings, onSettingsChange } from "./settings";

export type SfxId =
  | "laser" | "enemyLaser" | "hitShield" | "hitHull" | "explosion" | "bigExplosion"
  | "pickup" | "credits" | "trade" | "dock" | "undock" | "upgrade" | "alarm"
  | "ui" | "win" | "lose";

const MUTE_KEY = "game.muted";
const SFX_DIR = "assets/audio/sfx/";
const MUSIC_DIR = "assets/audio/music/";

// localStorage can throw (storage disabled, private mode, third-party storage blocked
// inside a preview iframe) — a game must never fail to start because of that.
function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeMuted(v: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  } catch {
    // not persisted this session; the in-memory flag still works
  }
}

interface SampleDef { files: string[]; gain: number; rate: [number, number] }

/**
 * Which recorded samples stand in for each SFX id. Combat sounds carry two
 * generated variants (Stable Audio Open, different seeds/prompts) — shots
 * alternate between them, on top of the per-shot pitch/gain jitter.
 */
const SFX_SAMPLES: Partial<Record<SfxId, SampleDef>> = {
  laser:       { files: ["laser_light.wav", "laser_light_b.wav"], gain: 0.55, rate: [0.97, 1.07] },
  enemyLaser:  { files: ["laser_heavy.wav", "laser_heavy_b.wav"], gain: 0.34, rate: [0.92, 1.0] },
  hitShield:   { files: ["shield_hit.wav"], gain: 0.4, rate: [0.97, 1.06] },
  hitHull:     { files: ["explosion_small.wav", "explosion_small_b.wav"], gain: 0.28, rate: [1.22, 1.4] },
  explosion:   { files: ["explosion_small.wav", "explosion_small_b.wav"], gain: 0.6, rate: [0.94, 1.08] },
  bigExplosion:{ files: ["explosion_big.wav", "explosion_big_b.wav"], gain: 0.7, rate: [0.96, 1.05] },
  alarm:       { files: ["ui_alarm.wav"], gain: 0.3, rate: [1, 1] },
  ui:          { files: ["ui_click.wav"], gain: 0.35, rate: [0.95, 1.1] },
};

/** Minor pentatonic around A — calm space-pad arpeggio, fallback if the track fails. */
const PAD_NOTES = [110, 130.81, 164.81, 196, 220, 261.63, 329.63];

interface AudioDebug {
  system: string | null;
  playing: string | null;
  samplesReady: number;
  muted: boolean;
  /** Live user volumes from the settings store (Этап: меню настроек). */
  volumes: { master: number; music: number; sfx: number };
  /** Battle-theme layer state for automation checks. */
  combat: "none" | "loading" | "ready" | "failed";
}

interface MusicLayer {
  el: HTMLAudioElement;
  srcNode: MediaElementAudioSourceNode;
  gain: GainNode;
  loaded: boolean;
  failed: boolean;
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private padGain: GainNode | null = null;
  private combatGain: GainNode | null = null;
  /** User volumes (settings store); applied to the buses in applyVolumes(). */
  private settings: GameSettings = loadSettings();
  private unsubSettings: (() => void) | null = null;
  private padTimer: ReturnType<typeof setInterval> | null = null;
  private combatTimer: ReturnType<typeof setInterval> | null = null;
  private padStep = 0;
  private disposed = false;
  muted = false;

  // sampled SFX: url -> in-flight decode / decoded cache
  private samples = new Map<string, Promise<AudioBuffer | null>>();
  private sampleBuf = new Map<string, AudioBuffer>();

  // per-system music layers, crossfaded on jump
  private music = new Map<string, MusicLayer>();
  private musicStarted = false;
  private curSys: string | null = null;
  private lastPlaying: string | null = null;
  // ACE-Step battle theme (music/combat.ogg): sits above the threat duck and
  // fades in as the threat rises; the synth pulse shrinks to a thin accent
  // while it is alive, and replaces it entirely when the track is missing.
  private combatLayer: MusicLayer | null = null;

  // browsers require a first user interaction before the AudioContext can start
  private readonly unlock = () => {
    this.ensureCtx();
    this.detachUnlock();
    // any music whose play() was rejected pre-gesture can start now
    if (this.musicStarted) {
      if (this.curSys) void this.playLayer(this.curSys);
      if (this.music.has("combat")) void this.playLayer("combat");
    }
  };

  constructor() {
    this.muted = readMuted();
    // live volume changes from the settings menu (master/music/sfx)
    this.unsubSettings = onSettingsChange((s) => {
      this.settings = s;
      this.applyVolumes();
    });
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
    try {
      (window as unknown as { __audioCtl: AudioSystem }).__audioCtl = this;
    } catch { /* test hook only */ }
  }

  private detachUnlock(): void {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }

  /**
   * Release everything: unlock listeners, music timers/elements and the AudioContext.
   * Call it from your teardown path (stopGame) next to input.dispose() — otherwise React
   * StrictMode's double mount / HMR leaks one AudioContext per mount, and Chrome caps a
   * page at about six of them.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubSettings?.();
    this.unsubSettings = null;
    this.detachUnlock();
    this.stopMusic();
    this.master?.disconnect();
    this.sfxBus?.disconnect();
    this.limiter?.disconnect();
    this.master = null;
    this.sfxBus = null;
    this.limiter = null;
    this.musicBus = null;
    this.musicDuck = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      // master limiter: dozens of overlapping salvos must duck each other, not clip
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -14;
      this.limiter.knee.value = 8;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.25;
      this.limiter.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.settings.master;
      this.master.connect(this.limiter);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.settings.sfx;
      this.sfxBus.connect(this.master);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.settings.music;
      this.musicBus.connect(this.master);
      this.musicDuck = this.ctx.createGain();
      this.musicDuck.gain.value = 1;
      this.musicDuck.connect(this.musicBus);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Re-apply user volumes after a settings change (smooth, no zipper noise). */
  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master?.gain.setTargetAtTime(this.muted ? 0 : this.settings.master, t, 0.05);
    this.sfxBus?.gain.setTargetAtTime(this.settings.sfx, t, 0.05);
    this.musicBus?.gain.setTargetAtTime(this.settings.music, t, 0.05);
    this.publishDebug();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    writeMuted(this.muted);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.settings.master;
    return this.muted;
  }

  // ---------- synthesized fallback SFX ----------

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, when = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, f0), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env).connect(this.sfxBus ?? this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, lowpass = 1200): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    const env = ctx.createGain();
    env.gain.value = gain;
    src.connect(filter).connect(env).connect(this.sfxBus ?? this.master);
    src.start();
  }

  private synthSfx(id: SfxId): void {
    switch (id) {
      case "laser": this.tone("square", 880, 240, 0.1, 0.10); break;
      case "enemyLaser": this.tone("square", 420, 160, 0.12, 0.07); break;
      case "hitShield": this.tone("sine", 620, 320, 0.09, 0.16); break;
      case "hitHull": this.tone("sawtooth", 200, 70, 0.16, 0.22); this.noise(0.12, 0.12, 900); break;
      case "explosion": this.noise(0.5, 0.4, 700); this.tone("sawtooth", 140, 28, 0.5, 0.3); break;
      case "bigExplosion": this.noise(0.9, 0.55, 500); this.tone("sawtooth", 110, 22, 0.9, 0.4); this.tone("sine", 60, 24, 1.1, 0.35, 0.05); break;
      case "pickup": this.tone("sine", 660, 990, 0.12, 0.2); break;
      case "credits": this.tone("sine", 880, 1320, 0.14, 0.2); this.tone("sine", 1320, 1760, 0.12, 0.14, 0.07); break;
      case "trade": this.tone("sine", 520, 780, 0.1, 0.18); this.tone("sine", 780, 1040, 0.1, 0.14, 0.06); break;
      case "dock": this.tone("sine", 220, 330, 0.35, 0.22); this.tone("sine", 330, 440, 0.3, 0.16, 0.2); break;
      case "undock": this.tone("sine", 440, 260, 0.3, 0.18); break;
      case "upgrade": this.tone("triangle", 440, 880, 0.22, 0.22); this.tone("triangle", 880, 1320, 0.2, 0.16, 0.12); break;
      case "alarm": this.tone("square", 520, 520, 0.16, 0.12); this.tone("square", 520, 520, 0.16, 0.12, 0.22); break;
      case "ui": this.tone("sine", 440, 520, 0.05, 0.12); break;
      case "win":
        [523, 659, 784, 1046].forEach((f, i) => this.tone("triangle", f, f, 0.35, 0.2, i * 0.14));
        break;
      case "lose":
        [392, 330, 262, 196].forEach((f, i) => this.tone("sawtooth", f, f * 0.94, 0.4, 0.16, i * 0.18));
        break;
    }
  }

  // ---------- sampled SFX ----------

  private loadSample(file: string): Promise<AudioBuffer | null> {
    const hit = this.samples.get(file);
    if (hit) return hit;
    const ctx = this.ensureCtx();
    const p = fetch(SFX_DIR + file)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => (ab ? ctx.decodeAudioData(ab) : null))
      .then((buf) => { if (buf) this.sampleBuf.set(file, buf); return buf; })
      .catch(() => null);
    this.samples.set(file, p);
    return p;
  }

  private playSample(buf: AudioBuffer, def: SampleDef): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const [r0, r1] = def.rate;
    src.playbackRate.value = r0 + Math.random() * (r1 - r0);
    const g = ctx.createGain();
    g.gain.value = def.gain * (0.85 + Math.random() * 0.3);
    src.connect(g).connect(this.sfxBus ?? this.master);
    src.start();
  }

  sfx(id: SfxId): void {
    if (this.disposed || this.muted) return; // muted: no context is created either
    this.ensureCtx();
    if (!this.master) return;
    const def = SFX_SAMPLES[id];
    if (def) {
      const ready = def.files.filter((f) => this.sampleBuf.has(f));
      if (ready.length) {
        const file = ready[Math.floor(Math.random() * ready.length)];
        const buf = this.sampleBuf.get(file);
        if (buf) { this.playSample(buf, def); this.publishDebug(); return; }
      }
      // warm the whole variant set; the synth voice covers the very first shot
      for (const f of def.files) void this.loadSample(f);
    }
    this.synthSfx(id);
  }

  // ---------- per-system music ----------

  private musicLayer(sysId: string): MusicLayer | null {
    const hit = this.music.get(sysId);
    if (hit) return hit;
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return null;
    const el = new Audio(MUSIC_DIR + sysId + ".ogg");
    el.loop = true;
    el.preload = "auto";
    let srcNode: MediaElementAudioSourceNode;
    try {
      srcNode = ctx.createMediaElementSource(el);
    } catch {
      return null; // context already closed (StrictMode double mount race)
    }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    srcNode.connect(gain).connect(this.musicDuck ?? this.musicBus);
    const layer: MusicLayer = { el, srcNode, gain, loaded: false, failed: false };
    el.addEventListener("canplay", () => { layer.loaded = true; void this.playLayer(sysId); });
    el.addEventListener("error", () => {
      layer.failed = true;
      // no track for this system — keep the synthesized pad alive instead
      // (the combat layer failing must not summon the pad over a fine theme)
      if (sysId === this.curSys && !this.padTimer) this.startPad();
    });
    this.music.set(sysId, layer);
    return layer;
  }

  private async playLayer(sysId: string): Promise<void> {
    const layer = this.musicLayer(sysId);
    if (!layer || layer.failed || this.disposed) return;
    try {
      await layer.el.play();
      this.stopPad();
      if (this.ctx && this.curSys === sysId) {
        layer.gain.gain.setTargetAtTime(0.5, this.ctx.currentTime, 0.9);
        this.lastPlaying = sysId;
      }
    } catch {
      // autoplay policy: the unlock handler retries once the page has a gesture
    }
    this.publishDebug();
  }

  /** Small read-only view for browser automation/tests. */
  private publishDebug(): void {
    try {
      const d: AudioDebug = {
        system: this.curSys,
        playing: this.lastPlaying,
        samplesReady: this.sampleBuf.size,
        muted: this.muted,
        volumes: { ...this.settings },
        combat: !this.combatLayer ? "none" : this.combatLayer.failed ? "failed" : this.combatLayer.loaded ? "ready" : "loading",
      };
      (window as unknown as { __audioDebug: AudioDebug }).__audioDebug = d;
    } catch {
      // debug hook must never break audio
    }
  }

  /** Switch the background track to another system's theme (crossfade over ~3 s). */
  setSystem(sysId: string): void {
    if (this.disposed || this.curSys === sysId) return;
    const prev = this.curSys;
    this.curSys = sysId;
    if (!this.musicStarted) return;
    const ctx = this.ensureCtx();
    if (prev) {
      const old = this.music.get(prev);
      if (old) {
        old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.9);
        const el = old.el;
        setTimeout(() => { if (this.curSys !== prev) el.pause(); }, 3200);
      }
    }
    void this.playLayer(sysId);
  }

  /**
   * Adaptive music: the current system's ACE-Step theme on loop, plus a low
   * combat pulse whose gain follows `setThreat()`. A synthesized pad arpeggio
   * stands in until the first track loads (or forever, if the assets are absent).
   */
  startMusic(): void {
    if (this.disposed || this.musicStarted) return;
    const ctx = this.ensureCtx();
    if (!this.master || !this.musicBus) return;
    this.musicStarted = true;

    this.combatGain = ctx.createGain();
    this.combatGain.gain.value = 0;
    this.combatGain.connect(this.musicBus); // above the duck — the pulse IS the threat

    if (this.curSys) void this.playLayer(this.curSys);
    else this.startPad(); // enterSystem hasn't run yet — pad holds until it does

    // battle theme: preloaded silently, setThreat() rides its fader
    this.combatLayer = this.musicLayer("combat");
    if (this.combatLayer) void this.combatLayer.el.play().catch(() => { /* unlock retries */ });

    const pulse = () => {
      if (!this.ctx || !this.combatGain || this.muted) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const env = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(55, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.28);
      env.gain.setValueAtTime(0.16, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.connect(env).connect(this.combatGain);
      osc.start(t); osc.stop(t + 0.32);
    };
    this.combatTimer = setInterval(pulse, 380);
  }

  /** 0 = calm space, 1 = full combat — crossfades theme → battle track. */
  setThreat(v: number): void {
    if (!this.combatGain || !this.ctx || !this.musicDuck) return;
    const g = Math.max(0, Math.min(1, v));
    const t = this.ctx.currentTime;
    const combat = this.combatLayer;
    const themeAlive = !!combat && combat.loaded && !combat.failed;
    // battle theme takes the lead from ~40% threat (sits outside the duck)
    if (combat && !combat.failed) {
      const lead = Math.max(0, Math.min(1, (g - 0.22) / 0.5));
      combat.gain.gain.setTargetAtTime(lead * 0.55, t, 0.7);
    }
    // the synth pulse thins to an accent once the real track can carry the fight
    this.combatGain.gain.setTargetAtTime(g * (themeAlive ? 0.3 : 0.9), t, 0.4);
    this.musicDuck.gain.setTargetAtTime(1 - 0.45 * g, t, 0.5);
  }

  /** Fallback ambient layer used before/instead of the generated tracks. */
  private startPad(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || this.padTimer) return;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.5;
    this.padGain.connect(this.musicDuck ?? this.musicBus);
    const padNote = () => {
      if (!this.ctx || !this.padGain || this.muted) return;
      const f = PAD_NOTES[this.padStep % PAD_NOTES.length];
      this.padStep += 1 + ((this.padStep * 7) % 3);
      const t = this.ctx.currentTime;
      for (const mult of [1, 2.01]) {
        const osc = this.ctx.createOscillator();
        const env = this.ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = f * mult;
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(0.05, t + 0.9);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
        osc.connect(env).connect(this.padGain);
        osc.start(t); osc.stop(t + 2.7);
      }
    };
    padNote();
    this.padTimer = setInterval(padNote, 2400);
  }

  private stopPad(): void {
    if (this.padTimer) { clearInterval(this.padTimer); this.padTimer = null; }
    this.padGain?.disconnect();
    this.padGain = null;
  }

  stopMusic(): void {
    if (this.combatTimer) { clearInterval(this.combatTimer); this.combatTimer = null; }
    this.combatGain?.disconnect();
    this.combatGain = null;
    this.stopPad();
    for (const layer of this.music.values()) {
      layer.el.pause();
      layer.el.src = "";
      layer.srcNode.disconnect();
      layer.gain.disconnect();
    }
    this.music.clear();
    this.combatLayer = null;
    this.musicStarted = false;
  }
}
