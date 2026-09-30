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
  | 'end'
  | 'fanfare';

type Wave = OscillatorType;

/** A sound requested before the context ran is still played if the context starts within this time. */
const PENDING_MAX_MS = 400;

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
    end: 0,
    fanfare: 0,
  };

  private bound = false;

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

  /** FEVER hit: impact, a fast rising run and a held major chord. */
  feverHit(): void {
    this.count('feverHit');
    const run = [523, 659, 784, 1047, 1319, 1568];
    this.play([
      { freq: 90, to: 40, dur: 0.35, wave: 'sine', gain: 0.5 },
      { freq: 200, to: 1600, dur: 0.2, wave: 'sawtooth', gain: 0.12 },
      ...run.map((freq, i) => ({ freq, dur: 0.1, at: 0.18 + i * 0.06, wave: 'square' as Wave, gain: 0.16 })),
      { freq: 1047, dur: 0.6, at: 0.56, wave: 'triangle', gain: 0.22 },
      { freq: 1319, dur: 0.6, at: 0.56, wave: 'triangle', gain: 0.18 },
      { freq: 1568, dur: 0.6, at: 0.56, wave: 'triangle', gain: 0.18 },
    ]);
  }

  /** FEVER continues: arpeggio, a step higher for each chain. */
  feverContinue(chain: number): void {
    this.count('feverContinue');
    const lift = Math.pow(1.122, Math.min(6, chain - 1));
    this.play([659, 784, 988, 1319].map((f, i) => ({ freq: f * lift, dur: 0.12, at: i * 0.07, wave: 'square' as Wave, gain: 0.18 })));
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
