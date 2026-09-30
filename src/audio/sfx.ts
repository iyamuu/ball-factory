import { BALANCE } from '../config/balance';

/**
 * Synthesised sound effects (no audio assets). Everything is generated with the Web Audio API
 * from oscillators and gain envelopes. The context is created on the first pointer event, which
 * browsers require before sound can play. Every call is guarded: a missing or failing audio
 * context must never affect the game. Nothing here is tied to the number of balls: the frequent
 * effects are paced by the caller in wall-clock time and rate-limited again here.
 */
export type SfxName =
  | 'gain'
  | 'pick'
  | 'offer'
  | 'accel'
  | 'extend'
  | 'best'
  | 'heat'
  | 'hold'
  | 'reelStop'
  | 'reach'
  | 'miss'
  | 'feverHit'
  | 'feverContinue'
  | 'feverEnd'
  | 'feverBgm'
  | 'end'
  | 'fanfare';

type Wave = OscillatorType;

/** A sound requested before the context ran is still played if the context starts within this time. */
const PENDING_MAX_MS = 400;

/** FEVER music tempo. FeverFx pulses the screen at the same tempo. */
export const FEVER_BPM = 150;
/** Length of one sixteenth note of the FEVER music, in seconds. */
const STEP_SEC = 60 / FEVER_BPM / 4;
/** How far ahead the FEVER music is scheduled, and how often the scheduler runs. */
const BGM_AHEAD_SEC = 0.15;
const BGM_TICK_MS = 40;
/** Chord roots per bar (C, G, A minor, F), as semitones above C. */
const BGM_ROOTS = [0, 7, 9, 5];
/** Chord tones per bar, as semitones above the root (major, major, minor, major). */
const BGM_CHORDS = [
  [0, 4, 7, 12],
  [0, 4, 7, 12],
  [0, 3, 7, 12],
  [0, 4, 7, 12],
];
/** Lead line for chain 3 and up: one note per eighth (null = rest), semitones above the bar root + 12. */
const BGM_LEAD: (number | null)[] = [12, null, 7, 12, 16, null, 12, 7];

interface Note {
  /** Start frequency in Hz. */
  freq: number;
  /** Frequency at the end of the note (glide), default: same as freq. */
  to?: number;
  /** Note length in seconds. */
  dur: number;
  /** Start offset from the call, in seconds. */
  at?: number;
  wave?: Wave;
  /** Peak gain, 0..1, before the master volume. */
  gain?: number;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastGainAt = -1;
  /** Notes requested while the context was still suspended, replayed once it runs (first tap on touch). */
  private pending: { notes: Note[]; at: number } | null = null;
  /** Times each effect was requested (for tests). `gain` counts only requests that passed its rate limit. */
  readonly counts: Record<SfxName, number> = {
    gain: 0,
    pick: 0,
    offer: 0,
    accel: 0,
    extend: 0,
    best: 0,
    heat: 0,
    hold: 0,
    reelStop: 0,
    reach: 0,
    miss: 0,
    feverHit: 0,
    feverContinue: 0,
    feverEnd: 0,
    feverBgm: 0,
    end: 0,
    fanfare: 0,
  };

  private bound = false;
  /** FEVER music: scheduler handle, next step to schedule, its audio time, and the layer level (chain). */
  private bgmTimer: ReturnType<typeof setInterval> | null = null;
  private bgmStep = 0;
  private bgmNextAt = 0;
  private bgmLevel = 1;
  private noise: AudioBuffer | null = null;

  constructor(public enabled: boolean) {}

  /** Zeroes the per-round request counters (the audio context is kept). */
  resetCounts(): void {
    for (const k of Object.keys(this.counts) as SfxName[]) this.counts[k] = 0;
  }

  /** Turns sound on or off. Off also silences notes already playing, through the master gain. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.pending = null;
    try {
      if (this.master && this.ctx) {
        const g = this.master.gain;
        g.cancelScheduledValues(this.ctx.currentTime);
        g.setValueAtTime(enabled ? BALANCE.sound.masterVolume : 0, this.ctx.currentTime);
      }
    } catch {
      // no audio context yet: the flag alone is enough
    }
  }

  /**
   * Unlocks at the DOM level, in the capture phase, so the context exists before any game-object
   * handler (a card tap, a button) asks for its sound. Browsers count only some events as user
   * activation: mouse down and key down, but for touch only the pointer up / touch end / click.
   * All of them are bound, so a touch tap creates the context on the way down and resumes it on
   * the way up; a sound requested in between is replayed as soon as the context runs. Bound once.
   */
  bindUnlock(canvas: EventTarget): void {
    if (this.bound) return;
    this.bound = true;
    const unlock = (): void => this.unlock();
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'click']) {
      canvas.addEventListener(type, unlock, { capture: true, passive: true });
    }
    window.addEventListener('keydown', unlock, { capture: true, passive: true });
  }

  /** Creates or resumes the audio context. Call from a user gesture. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.enabled ? BALANCE.sound.masterVolume : 0;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().then(() => this.flushPending()).catch(() => undefined);
      }
    } catch {
      this.ctx = null;
    }
  }

  /** Plays the notes requested while the context was suspended, if they are still fresh. */
  private flushPending(): void {
    const p = this.pending;
    this.pending = null;
    if (p && performance.now() - p.at < PENDING_MAX_MS) this.play(p.notes);
  }

  /**
   * A "+N" popup: a small coin sound. Pitch rises with the number of digits of N and with `lift`
   * (heat stage, plus more during FEVER), so a rich stream sounds brighter. Rate-limited in wall-clock time.
   */
  gain(amount: number, lift: number): void {
    const now = performance.now() / 1000;
    if (now - this.lastGainAt < BALANCE.sound.minGainGapSec) return;
    this.lastGainAt = now;
    this.count('gain');
    const digits = Math.max(1, Math.floor(Math.log10(Math.max(1, amount))) + 1);
    const freq = 660 * Math.pow(1.19, digits - 1 + lift);
    this.play([{ freq, to: freq * 1.5, dur: 0.06, wave: 'sine', gain: 0.22 }]);
  }

  /** Card picked. `ratio` is the rate after / before: a bigger jump is higher and thicker. */
  pick(ratio: number): void {
    this.count('pick');
    const lift = Math.pow(1.12, Math.max(0, Math.min(4, Math.log2(Math.max(1, ratio)) * 2)));
    const notes: Note[] = [
      { freq: 523 * lift, dur: 0.08, wave: 'square', gain: 0.18 },
      { freq: 784 * lift, dur: 0.14, at: 0.08, wave: 'square', gain: 0.18 },
    ];
    // A third, fifth-above note for a jump of x2 or more.
    if (ratio >= 2) notes.push({ freq: 1175 * lift, dur: 0.16, at: 0.16, wave: 'triangle', gain: 0.16 });
    this.play(notes);
  }

  /** Offer opened: short notification. */
  offer(): void {
    this.count('offer');
    this.play([{ freq: 880, dur: 0.05, wave: 'sine', gain: 0.2 }, { freq: 1175, dur: 0.08, at: 0.06, wave: 'sine', gain: 0.2 }]);
  }

  /** Accelerator boost starting: upward sweep. */
  accel(): void {
    this.count('accel');
    this.play([{ freq: 300, to: 1000, dur: 0.28, wave: 'sawtooth', gain: 0.16 }]);
  }

  /** Time added: bell-like chime. */
  extend(): void {
    this.count('extend');
    this.play([
      { freq: 660, dur: 0.1, wave: 'sine', gain: 0.3 },
      { freq: 880, dur: 0.1, at: 0.09, wave: 'sine', gain: 0.3 },
      { freq: 1320, dur: 0.3, at: 0.18, wave: 'sine', gain: 0.3 },
    ]);
  }

  /** Passing the previous best mid-round: quick arpeggio. */
  best(): void {
    this.count('best');
    this.play([523, 659, 784, 1047].map((freq, i) => ({ freq, dur: 0.14, at: i * 0.07, wave: 'square' as Wave, gain: 0.2 })));
  }

  /** Heat stage up: rising sweep plus a chord, higher for each stage. */
  heat(stage: number): void {
    this.count('heat');
    const base = 262 * Math.pow(1.5, stage - 1);
    this.play([
      { freq: base, to: base * 4, dur: 0.35, wave: 'sawtooth', gain: 0.14 },
      { freq: base * 2, dur: 0.5, at: 0.3, wave: 'triangle', gain: 0.22 },
      { freq: base * 2.5, dur: 0.5, at: 0.3, wave: 'triangle', gain: 0.18 },
      { freq: base * 3, dur: 0.5, at: 0.3, wave: 'triangle', gain: 0.18 },
    ]);
  }

  /** Hold added: a blip, higher and brighter for a hotter colour (0 = white .. 4 = gold). */
  hold(colorIndex: number): void {
    this.count('hold');
    const freq = 988 * Math.pow(1.26, colorIndex);
    const notes: Note[] = [{ freq, dur: 0.06, wave: 'square', gain: 0.12 }];
    if (colorIndex >= 3) notes.push({ freq: freq * 1.5, dur: 0.12, at: 0.06, wave: 'square', gain: 0.14 });
    this.play(notes);
  }

  /** A reel digit stops. */
  reelStop(): void {
    this.count('reelStop');
    this.play([{ freq: 1400, to: 700, dur: 0.04, wave: 'square', gain: 0.12 }]);
  }

  /** Reach: two-tone alarm, then a slow rising drone under the rolling centre digit. */
  reach(sec: number): void {
    this.count('reach');
    const notes: Note[] = [];
    for (let i = 0; i < 4; i++) {
      notes.push({ freq: i % 2 ? 1175 : 880, dur: 0.09, at: i * 0.1, wave: 'square', gain: 0.16 });
    }
    notes.push({ freq: 180, to: 720, dur: Math.max(0.5, sec - 0.45), at: 0.42, wave: 'sawtooth', gain: 0.09 });
    this.play(notes);
  }

  /** Draw lost: short falling note. */
  miss(): void {
    this.count('miss');
    this.play([{ freq: 330, to: 220, dur: 0.18, wave: 'triangle', gain: 0.16 }]);
  }

  /** FEVER hit: impact with a cymbal crash, a fast rising run and a held major chord in three layers. */
  feverHit(): void {
    this.count('feverHit');
    const run = [523, 659, 784, 1047, 1319, 1568, 2093];
    this.play([
      { freq: 110, to: 35, dur: 0.5, wave: 'sine', gain: 0.6 },
      { freq: 200, to: 2400, dur: 0.22, wave: 'sawtooth', gain: 0.12 },
      ...run.map((freq, i) => ({ freq, dur: 0.1, at: 0.16 + i * 0.05, wave: 'square' as Wave, gain: 0.15 })),
      ...[1047, 1319, 1568, 2093].map((freq) => ({ freq, dur: 0.75, at: 0.52, wave: 'triangle' as Wave, gain: 0.16 })),
      ...[523, 659, 784].map((freq) => ({ freq, dur: 0.75, at: 0.52, wave: 'sawtooth' as Wave, gain: 0.06 })),
    ]);
    this.crash(0, 1.2, 0.35);
    this.crash(0.52, 0.9, 0.25);
  }

  /** FEVER continues: crash and a rising arpeggio, a whole tone higher for each chain. */
  feverContinue(chain: number): void {
    this.count('feverContinue');
    const lift = Math.pow(1.122, Math.min(6, chain - 1));
    this.play([
      { freq: 90, to: 40, dur: 0.3, wave: 'sine', gain: 0.5 },
      ...[523, 659, 784, 1047, 1319].map((f, i) => ({ freq: f * lift, dur: 0.12, at: 0.05 + i * 0.06, wave: 'square' as Wave, gain: 0.17 })),
      ...[1047, 1319, 1568].map((f) => ({ freq: f * lift, dur: 0.5, at: 0.35, wave: 'triangle' as Wave, gain: 0.16 })),
    ]);
    this.crash(0, 0.9, 0.3);
  }

  /**
   * Starts the FEVER music (or changes its layers when already playing). `level` is the chain:
   * 1 = kick, bass and arpeggio; 2 adds hi-hats; 3 and up add a lead. Each level is a whole tone higher.
   */
  startFeverBgm(level: number): void {
    this.bgmLevel = Math.max(1, level);
    if (this.bgmTimer !== null) return;
    this.count('feverBgm');
    if (!this.ctx) return;
    this.bgmStep = 0;
    this.bgmNextAt = this.ctx.currentTime + 0.05;
    this.bgmTimer = setInterval(() => this.scheduleBgm(), BGM_TICK_MS);
    this.scheduleBgm();
  }

  stopFeverBgm(): void {
    if (this.bgmTimer !== null) clearInterval(this.bgmTimer);
    this.bgmTimer = null;
  }

  /** Schedules the FEVER music steps that fall inside the look-ahead window. */
  private scheduleBgm(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    // After a stall (background tab) skip ahead instead of playing the missed steps at once.
    if (this.bgmNextAt < ctx.currentTime - 0.2) this.bgmNextAt = ctx.currentTime + 0.02;
    while (this.bgmNextAt < ctx.currentTime + BGM_AHEAD_SEC) {
      if (this.enabled) this.bgmStepNotes(this.bgmStep, this.bgmNextAt - ctx.currentTime);
      this.bgmStep = (this.bgmStep + 1) % 64;
      this.bgmNextAt += STEP_SEC;
    }
  }

  private bgmStepNotes(step: number, at: number): void {
    const level = this.bgmLevel;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const shift = 2 * Math.min(4, level - 1);
    const note = (semi: number, base: number): number => base * Math.pow(2, (semi + shift) / 12);
    const root = BGM_ROOTS[bar];
    const notes: Note[] = [];
    if (s % 4 === 0) notes.push({ freq: 150, to: 42, dur: 0.14, at, wave: 'sine', gain: 0.5 });
    if (s % 4 === 2) notes.push({ freq: note(root, 65.41), dur: STEP_SEC * 1.8, at, wave: 'sawtooth', gain: 0.14 });
    const chord = BGM_CHORDS[bar];
    notes.push({ freq: note(root + chord[s % 4], 523.25), dur: STEP_SEC * 0.9, at, wave: 'triangle', gain: 0.07 });
    if (level >= 3 && s % 2 === 0) {
      const lead = BGM_LEAD[s / 2];
      if (lead !== null) notes.push({ freq: note(root + lead, 261.63), dur: STEP_SEC * 1.8, at, wave: 'square', gain: 0.06 });
    }
    this.play(notes);
    if (level >= 2 && s % 2 === 0) this.crash(at, 0.05, s % 4 === 2 ? 0.1 : 0.05);
  }

  /** Band-passed noise burst: a cymbal crash when long, a hi-hat when short. */
  private crash(at: number, dur: number, gain: number): void {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || !this.master || ctx.state !== 'running') return;
    try {
      if (!this.noise) {
        const len = Math.floor(ctx.sampleRate * 1.5);
        this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 5000;
      const env = ctx.createGain();
      const start = ctx.currentTime + at;
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(gain, start + 0.005);
      env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      src.connect(filter);
      filter.connect(env);
      env.connect(this.master);
      src.start(start);
      src.stop(start + dur + 0.02);
    } catch {
      // audio failure is never a game failure
    }
  }

  /** FEVER over: falling three notes. */
  feverEnd(): void {
    this.count('feverEnd');
    this.play([784, 659, 523].map((freq, i) => ({ freq, dur: 0.14, at: i * 0.12, wave: 'triangle' as Wave, gain: 0.2 })));
  }

  /** Round over: three-note close. */
  end(): void {
    this.count('end');
    this.play([
      { freq: 392, dur: 0.16, wave: 'triangle', gain: 0.3 },
      { freq: 523, dur: 0.16, at: 0.15, wave: 'triangle', gain: 0.3 },
      { freq: 659, dur: 0.4, at: 0.3, wave: 'triangle', gain: 0.3 },
    ]);
  }

  /** Round over with a new best: fanfare. */
  fanfare(): void {
    this.count('fanfare');
    const seq = [523, 523, 523, 659, 784, 1047];
    this.play(seq.map((freq, i) => ({ freq, dur: i === 5 ? 0.6 : 0.12, at: i * 0.12, wave: 'square' as Wave, gain: 0.2 })));
  }

  private count(name: SfxName): void {
    this.counts[name] += 1;
  }

  private play(notes: Note[]): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    if (this.ctx.state !== 'running') {
      // Nothing is scheduled on a suspended context (its clock does not advance, so nodes would
      // pile up). Keep only the latest request and replay it when the gesture completes.
      this.pending = { notes, at: performance.now() };
      return;
    }
    try {
      const t0 = this.ctx.currentTime;
      for (const n of notes) {
        const osc = this.ctx.createOscillator();
        const env = this.ctx.createGain();
        const start = t0 + (n.at ?? 0);
        const end = start + n.dur;
        osc.type = n.wave ?? 'sine';
        osc.frequency.setValueAtTime(n.freq, start);
        if (n.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, n.to), end);
        // Short attack and an exponential release so notes never click.
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(n.gain ?? 0.2, start + 0.008);
        env.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(env);
        env.connect(this.master);
        osc.start(start);
        osc.stop(end + 0.02);
      }
    } catch {
      // audio failure is never a game failure
    }
  }
}
