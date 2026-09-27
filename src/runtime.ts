import { BALANCE } from './config/balance';

/**
 * Runtime overrides from the URL, used for testing only:
 *   ?round=5   shorten the round to 5 seconds
 *   ?shake=0   disable camera shake
 *   ?seed=123  fix the offer seed for every round (default: a new random seed per round)
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
  fixedSeed: num('seed') ?? BALANCE.cards.seed ?? undefined,
};

/** A fresh 31-bit seed for one round. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}
