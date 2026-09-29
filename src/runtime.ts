import { BALANCE } from './config/balance';

/**
 * Runtime overrides from the URL, used for testing only:
 *   ?round=5   shorten the round to 5 seconds
 *   ?shake=0   disable camera shake
 *   ?seed=123  fix the offer seed for every round (default: a new random seed per round)
 *   ?telemetry=0 (or =<localhost url>)  disable or redirect round telemetry (src/telemetry.ts)
 *   ?speed=1.5 start at this playback speed (one of BALANCE.playback.speeds) instead of the saved one
 *   ?sound=0   start muted regardless of the saved speaker state
 */
const params = new URLSearchParams(window.location.search);

function num(name: string): number | undefined {
  const v = params.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export const RUNTIME = {
  roundDurationSec: num('round') ?? BALANCE.round.durationSec,
  shakeEnabled: BALANCE.shake.enabled && params.get('shake') !== '0',
  /** Fixed offer seed, or undefined for a new random seed every round. */
  fixedSeed: normalizeSeed(num('seed') ?? BALANCE.cards.seed ?? undefined),
  /** Playback speed from ?speed=, or undefined to use the saved one. Only offered speeds are accepted. */
  speed: offeredSpeed(num('speed')),
  /** false when ?sound=0 is given; undefined otherwise (use the saved state, then the default). */
  sound: params.get('sound') === '0' ? false : undefined,
};

function offeredSpeed(speed: number | undefined): number | undefined {
  return speed !== undefined && (BALANCE.playback.speeds as readonly number[]).includes(speed) ? speed : undefined;
}

/** The RNG uses seeds as 32-bit unsigned integers; show the same value the RNG uses. */
function normalizeSeed(seed: number | undefined): number | undefined {
  return seed === undefined ? undefined : Math.trunc(seed) >>> 0;
}

/** A fresh 31-bit seed for one round. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}
