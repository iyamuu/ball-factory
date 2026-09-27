import { BALANCE, type MachineDef, type MachineId } from '../config/balance';
import { Rng } from './rng';

export interface Offer {
  /** Sim-time at which this offer is shown. */
  atSec: number;
  /** Cards shown, no duplicates within one offer. */
  cards: MachineDef[];
}

export function machineDef(id: MachineId): MachineDef {
  const def = BALANCE.machineDefs.find((m) => m.id === id);
  if (!def) throw new Error(`unknown machine ${id}`);
  return def;
}

/**
 * Generates every offer of a round up front from a fixed seed.
 * The draw does not depend on what the player owns, so two rounds with the same seed
 * always show the same candidates at the same times.
 */
export function generateOffers(seed: number, roundDurationSec: number): Offer[] {
  // Offers are scheduled up to the longest possible round (base length plus every EXTEND);
  // the game shows an offer only if the round has not ended before its time.
  const rng = new Rng(seed);
  const { firstOfferAtSec, intervalSec, choices } = BALANCE.cards;
  const offers: Offer[] = [];
  for (let t = firstOfferAtSec; t < roundDurationSec; t += intervalSec) {
    const pool = rng.shuffle([...BALANCE.machineDefs]);
    offers.push({ atSec: t, cards: pool.slice(0, choices) });
  }
  return offers;
}
