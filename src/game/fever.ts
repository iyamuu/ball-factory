import { BALANCE } from '../config/balance';
import { Rng } from './rng';

export type HoldColor = (typeof BALANCE.fever.colors)[number];

/** One lottery ticket. The result is decided when the hold is added, so its colour can hint at it. */
export interface Hold {
  color: HoldColor;
  hit: boolean;
  /** True if the draw shows a reach (left and right digits match). Always true for a hit. */
  reach: boolean;
  /** Final digits, left / centre / right, 1..9. */
  digits: [number, number, number];
}

/** The hold being drawn on the reel. */
export interface Draw extends Hold {
  /** Sim seconds since the draw started. */
  elapsed: number;
  /** Length of this draw (longer with a reach). */
  duration: number;
}

export type FeverEvent =
  | { type: 'hold'; color: HoldColor }
  | { type: 'drawStart'; draw: Draw }
  | { type: 'leftStop' }
  | { type: 'rightStop'; reach: boolean }
  | { type: 'result'; hit: boolean }
  | { type: 'feverStart' }
  | { type: 'feverContinue'; chain: number }
  | { type: 'feverEnd'; chain: number };

const F = BALANCE.fever;

/** Score multiplier of the given FEVER chain (1 = the hit). Longer chains keep the last value. */
export function chainMultiplier(chain: number): number {
  const m = F.chainMultipliers;
  return m[Math.max(0, Math.min(m.length - 1, chain - 1))];
}

/**
 * Fever lottery, pure and deterministic for a given seed and sequence of calls.
 *
 * Every score milestone (milestoneBase * milestoneGrowth^k) adds a hold, up to maxHolds. When no draw
 * and no FEVER is running, the next hold is drawn; a hit starts FEVER (score x chainMultiplier(chain) for
 * durationSec), and each time FEVER runs out it continues with continueChance. Holds added during a
 * draw or FEVER wait. Everything runs on sim time, so offers pause it with the rest of the round.
 */
export class FeverLottery {
  holds: Hold[] = [];
  draw: Draw | null = null;
  feverRemainingSec = 0;
  /** FEVER runs in the current chain (1 = the hit itself). */
  chain = 0;
  /** Index of the next milestone. */
  private milestone = 0;
  private missStreak = 0;
  private readonly rng: Rng;

  // Round totals, for telemetry and the balance check.
  draws = 0;
  hits = 0;
  reaches = 0;
  feverSec = 0;
  longestChain = 0;
  /** Milestones passed while the holds were full. */
  lostHolds = 0;
  /** EXPERIMENT: continuation checks by heat stage. */
  continueChecks = [0, 0, 0, 0];

  constructor(seed: number) {
    // Separate stream from the offers so the lottery never changes what is offered.
    this.rng = new Rng((seed ^ 0x5eed_f00d) >>> 0);
  }

  get feverActive(): boolean {
    return this.feverRemainingSec > 0;
  }

  get multiplier(): number {
    return this.feverActive ? chainMultiplier(this.chain) : 1;
  }

  /** Score at which the next hold is added. */
  get nextMilestone(): number {
    return F.milestoneBase * F.milestoneGrowth ** this.milestone;
  }

  /**
   * Advances by dt sim seconds. `score` is the round score after this step; `heat` (0..3) sets the
   * colour weights of holds added now. Returns what happened, in order, for the presentation.
   */
  advance(dt: number, score: number, heat: number): FeverEvent[] {
    const events: FeverEvent[] = [];

    while (score >= this.nextMilestone) {
      this.milestone += 1;
      if (this.holds.length >= F.maxHolds) {
        this.lostHolds += 1;
        continue;
      }
      const hold = this.makeHold(heat);
      this.holds.push(hold);
      events.push({ type: 'hold', color: hold.color });
    }

    if (this.feverActive) {
      this.feverSec += Math.min(dt, this.feverRemainingSec);
      this.feverRemainingSec -= dt;
      if (this.feverRemainingSec <= 1e-9) {
        this.feverRemainingSec = 0;
        const cc = F.continueByHeat ? F.continueByHeat[Math.min(3, heat)] : F.continueChance;
        this.continueChecks[Math.min(3, heat)] += 1;
        const capped = F.maxChain > 0 && this.chain >= F.maxChain;
        if (!capped && this.rng.next() < cc) {
          this.chain += 1;
          this.feverRemainingSec = F.durationSec;
          this.longestChain = Math.max(this.longestChain, this.chain);
          events.push({ type: 'feverContinue', chain: this.chain });
        } else {
          events.push({ type: 'feverEnd', chain: this.chain });
        }
      }
      return events;
    }

    const d = this.draw;
    if (d) {
      const before = d.elapsed;
      d.elapsed += dt;
      const crossed = (t: number): boolean => before < t - 1e-9 && d.elapsed >= t - 1e-9;
      if (crossed(F.leftStopSec)) events.push({ type: 'leftStop' });
      if (crossed(F.rightStopSec)) events.push({ type: 'rightStop', reach: d.reach });
      if (d.elapsed >= d.duration - 1e-9) {
        this.draw = null;
        events.push({ type: 'result', hit: d.hit });
        if (d.hit) {
          this.hits += 1;
          this.chain = 1;
          this.longestChain = Math.max(this.longestChain, 1);
          this.feverRemainingSec = F.durationSec;
          events.push({ type: 'feverStart' });
        }
      }
      return events;
    }

    const next = this.holds.shift();
    if (next) {
      this.draw = { ...next, elapsed: 0, duration: next.reach ? F.reachDrawSec : F.drawSec };
      this.draws += 1;
      if (next.reach) this.reaches += 1;
      events.push({ type: 'drawStart', draw: this.draw });
    }
    return events;
  }

  private makeHold(heat: number): Hold {
    const h = F.heatHolds ? heat : 0;
    const weights = F.colorWeightsByHeat[Math.max(0, Math.min(F.colorWeightsByHeat.length - 1, h))];
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng.next() * total;
    let ci = 0;
    while (ci < weights.length - 1 && r >= weights[ci]) {
      r -= weights[ci];
      ci += 1;
    }
    let hit = this.rng.next() < F.hitChance[ci];
    if (this.missStreak >= F.ceiling) hit = true; // pity ceiling
    this.missStreak = hit ? 0 : this.missStreak + 1;
    const reach = hit || this.rng.next() < F.reachOnMiss;

    const digit = (): number => 1 + this.rng.int(9);
    const d = digit();
    let digits: [number, number, number];
    if (hit) {
      digits = [d, d, d];
    } else if (reach) {
      // Near miss: the centre stops one off the matching digit.
      const off = this.rng.next() < 0.5 ? 1 : -1;
      digits = [d, ((d - 1 + off + 9) % 9) + 1, d];
    } else {
      const right = ((d - 1 + 1 + this.rng.int(8)) % 9) + 1; // any digit but d
      digits = [d, digit(), right];
    }
    return { color: F.colors[ci], hit, reach, digits };
  }
}
