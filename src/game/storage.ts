import { BALANCE } from '../config/balance';

interface SaveData {
  best: number;
}

/**
 * localStorage wrapper. Every access is guarded: a missing or throwing storage
 * (private mode, blocked site data) must never break a round.
 */
export function loadBest(): number {
  try {
    const raw = localStorage.getItem(BALANCE.storage.key);
    if (!raw) return 0;
    const data = JSON.parse(raw) as Partial<SaveData>;
    return typeof data.best === 'number' && Number.isFinite(data.best) ? data.best : 0;
  } catch {
    return 0;
  }
}

/** Returns true if the value was persisted. */
export function saveBest(best: number): boolean {
  try {
    const data: SaveData = { best };
    localStorage.setItem(BALANCE.storage.key, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
