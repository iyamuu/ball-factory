import { BALANCE } from './config/balance';

/**
 * Runtime overrides from the URL, used for testing only:
 *   ?round=5   shorten the round to 5 seconds
 *   ?shake=0   disable camera shake
 *   ?seed=123  use another offer seed
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
  seed: num('seed') ?? BALANCE.cards.seed,
};
