import type { MachineId } from './config/balance';
import { TELEMETRY } from './config/telemetry';

/** One card offer and what the player did with it. */
export interface OfferRecord {
  /** 0-based offer number within the round. */
  index: number;
  /** Sim-time at which the offer was shown. */
  atSec: number;
  /** Cards shown, in display order. */
  cards: MachineId[];
  /** Card picked. */
  pick: MachineId;
  /** Wall-clock seconds between the offer appearing and the pick. */
  decisionSec: number;
}

/** One finished round. Everything needed to replay the decisions offline. */
export interface RoundRecord {
  v: number;
  build: string;
  /** Anonymous per-browser id (random, stored in localStorage; not tied to any account). */
  player: string;
  /** ISO time at which the round ended. */
  time: string;
  seed: number;
  /** Configured round length before EXTEND. */
  durationSec: number;
  /** Actual round length including EXTEND. */
  roundLengthSec: number;
  /** True if the player restarted before the round ended; the record then covers the part played. */
  abandoned: boolean;
  /** Sim-time played (equals roundLengthSec for a finished round). */
  playedSec: number;
  score: number;
  peakRate: number;
  line: MachineId[];
  speedCount: number;
  extendCount: number;
  offers: OfferRecord[];
  screen: { w: number; h: number; dpr: number; touch: boolean };
  /** Playback speed when the record was made (sim seconds per wall-clock second). */
  speed: number;
  /** Sim-time played at each speed, keyed by the speed ("1", "1.5"). Shows switching during a round. */
  speedSec: Record<string, number>;
  /** Speaker button state when the record was made. */
  muted: boolean;
  /** Highest heat stage reached (0..3); named fever before the lottery existed. */
  fever: number;
  /** Fever lottery totals, or null when the lottery was off (?fever=0). */
  lottery: {
    draws: number;
    hits: number;
    reaches: number;
    feverSec: number;
    longestChain: number;
    /** Milestones passed while the holds were full. */
    lostHolds: number;
    /** Score added by the FEVER multiplier (included in score). */
    bonus: number;
  } | null;
}

/** Hosts a ?telemetry=<url> override may point at: the tester's own machine, never a third party. */
const OVERRIDE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Endpoint override for testing: ?telemetry=0 disables sending, ?telemetry=<url> replaces the URL.
 * The replacement must be a local address, so a crafted public link cannot redirect records elsewhere.
 */
function endpoint(): string {
  try {
    const p = new URLSearchParams(window.location.search).get('telemetry');
    if (p === '0') return '';
    if (p) {
      const u = new URL(p);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && OVERRIDE_HOSTS.has(u.hostname)) return u.href;
    }
  } catch {
    // no URL access or an unparsable override: fall through to the configured endpoint
  }
  return TELEMETRY.endpoint;
}

/** Anonymous id for this browser, created on first use. Empty when storage is unavailable. */
export function playerId(): string {
  try {
    const key = TELEMETRY.storage.playerKey;
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(key, id);
    return id;
  } catch {
    return '';
  }
}

/** Rounds kept locally, oldest first. */
export function localLog(): RoundRecord[] {
  try {
    const raw = localStorage.getItem(TELEMETRY.storage.logKey);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as RoundRecord[]) : [];
  } catch {
    return [];
  }
}

function appendLocal(record: RoundRecord): void {
  try {
    const list = localLog();
    list.push(record);
    while (list.length > TELEMETRY.localRounds) list.shift();
    localStorage.setItem(TELEMETRY.storage.logKey, JSON.stringify(list));
  } catch {
    // storage unavailable: the round is still sent
  }
}

/** Screen facts that help interpret decision times and layout problems. */
export function screenInfo(): RoundRecord['screen'] {
  try {
    return {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      touch: navigator.maxTouchPoints > 0,
    };
  } catch {
    return { w: 0, h: 0, dpr: 1, touch: false };
  }
}

/**
 * Posts one record. sendBeacon with a string body is a text/plain request, which needs no CORS
 * preflight and survives the page closing; fetch with keepalive is the fallback. Never throws.
 */
function send(url: string, body: string): boolean {
  try {
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, body)) return true;
  } catch {
    // fall through to fetch
  }
  try {
    void fetch(url, { method: 'POST', body, mode: 'no-cors', keepalive: true }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Stores the round locally and sends it when an endpoint is configured. Returns true if a send was attempted. */
export function recordRound(record: RoundRecord): boolean {
  appendLocal(record);
  const url = endpoint();
  if (!url) return false;
  let body: string;
  try {
    body = JSON.stringify(record);
  } catch {
    return false;
  }
  return send(url, body);
}

/** Local log as text for COPY LOG. */
export function formatLog(): string {
  return JSON.stringify(localLog());
}
