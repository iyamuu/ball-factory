import { BALANCE } from '../config/balance';

/**
 * Synthesised sound effects (no audio assets). Everything is generated with the Web Audio API
 * from oscillators and gain envelopes. The context is created on the first pointer event, which
 * browsers require before sound can play. Every call is guarded: a missing or failing audio
 * context must never affect the game.
 */
export type SfxName = 'tick' | 'press' | 'pick' | 'accel' | 'extend' | 'best' | 'end';

type Wave = OscillatorType;

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
  private lastAt: Partial<Record<SfxName, number>> = {};
  /** Times each effect was requested, whether or not it could play (for tests). */
  readonly counts: Record<SfxName, number> = { tick: 0, press: 0, pick: 0, accel: 0, extend: 0, best: 0, end: 0 };

  constructor(public enabled: boolean) {}

  /** Creates or resumes the audio context. Call from a pointer event handler. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = BALANCE.sound.masterVolume;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      this.ctx = null;
    }
  }

  /** A ball dropping into the bin. Pitch rises with how many presses it went through. */
  tick(pressedLevel: number): void {
    if (!this.throttle('tick', BALANCE.sound.minGapSec.tick)) return;
    const freq = 880 * Math.pow(1.25, Math.min(pressedLevel, 4));
    this.play([{ freq, to: freq * 0.9, dur: 0.05, wave: 'sine', gain: 0.25 }]);
  }

  /** A press processing a ball: short low thud. */
  press(): void {
    if (!this.throttle('press', BALANCE.sound.minGapSec.press)) return;
    this.play([{ freq: 160, to: 90, dur: 0.08, wave: 'triangle', gain: 0.35 }]);
  }

  /** Card picked: two rising notes. */
  pick(): void {
    this.count('pick');
    this.play([
      { freq: 523, dur: 0.08, wave: 'square', gain: 0.18 },
      { freq: 784, dur: 0.12, at: 0.08, wave: 'square', gain: 0.18 },
    ]);
  }

  /** Accelerator boost starting: upward sweep. */
  accel(): void {
    this.count('accel');
    this.play([{ freq: 300, to: 1000, dur: 0.28, wave: 'sawtooth', gain: 0.16 }]);
  }

  /** Time added: bright chime. */
  extend(): void {
    this.count('extend');
    this.play([
      { freq: 660, dur: 0.1, wave: 'sine', gain: 0.3 },
      { freq: 880, dur: 0.1, at: 0.09, wave: 'sine', gain: 0.3 },
      { freq: 1320, dur: 0.22, at: 0.18, wave: 'sine', gain: 0.3 },
    ]);
  }

  /** Passing the previous best mid-round: quick arpeggio. */
  best(): void {
    this.count('best');
    this.play(
      [523, 659, 784, 1047].map((freq, i) => ({ freq, dur: 0.14, at: i * 0.07, wave: 'square' as Wave, gain: 0.2 })),
    );
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

  private count(name: SfxName): void {
    this.counts[name] += 1;
  }

  /** Rate limit for effects that can fire many times per second; counts only the ones that pass. */
  private throttle(name: SfxName, minGapSec: number): boolean {
    const now = performance.now() / 1000;
    if (now - (this.lastAt[name] ?? -1) < minGapSec) return false;
    this.lastAt[name] = now;
    this.count(name);
    return true;
  }

  private play(notes: Note[]): void {
    if (!this.enabled || !this.ctx || !this.master || this.ctx.state !== 'running') return;
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
