/**
 * Balance check by brute force. Runs the real Simulation and generateOffers (no Phaser) and, for
 * each seed, enumerates every pick sequence (depth first, since EXTEND changes the number of
 * offers) to find the optimum. Simple strategies and random picking are measured against it.
 *
 *   npm run balance                 # the configured spec (BALANCE as is), 20 seeds
 *   npm run balance -- --seeds 6    # fewer seeds
 *   npm run balance -- --from 21    # seeds 21.. (a hold-out set not used when choosing numbers)
 *   npm run balance -- --variants   # the configured spec plus the variants listed in VARIANTS
 *   npm run balance -- --variant x3.0   # only the variants whose label contains the text
 *
 * Results are printed as Markdown tables so they can be pasted into docs/DESIGN.md.
 */
import { BALANCE, type MachineId } from '../../src/config/balance';
import { generateOffers, type Offer } from '../../src/game/cards';
import { Simulation } from '../../src/game/simulation';

type Chooser = (sim: Simulation, cards: MachineId[], allowed: boolean[]) => MachineId;

const LETTER: Record<MachineId, string> = { splitter: 'S', accelerator: 'A', press: 'P', speed: 'V', extend: 'E' };
const CARDS: MachineId[] = ['press', 'splitter', 'accelerator', 'speed', 'extend'];
const DURATION = BALANCE.round.durationSec;
const LONGEST = DURATION + BALANCE.machines.extend.maxPerRound * BALANCE.machines.extend.seconds;
const RANDOM_RUNS = 200;

// ---------------------------------------------------------------- CLI

declare const process: { argv: string[] };
const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
/** --seeds N: how many seeds; --from K: first seed (default 1), e.g. --from 21 for a hold-out set. */
const FIRST_SEED = Number(arg('from', '1'));
const SEEDS = Array.from({ length: Number(arg('seeds', '20')) }, (_, i) => FIRST_SEED + i);
const RUN_VARIANTS = args.includes('--variants');
/** --variant <text>: run only the variants whose label contains the text. */
const VARIANT_FILTER = arg('variant', '');

// ---------------------------------------------------------------- variants

/** BALANCE is declared readonly for the game; the checker mutates a copy of the same object. */
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const M = BALANCE as unknown as Mutable<typeof BALANCE>;
const accel = M.machines.accelerator;

interface Variant {
  label: string;
  apply: () => void;
}

/** Edit this list to compare specs. Every entry sets all five ACCEL numbers so the order of runs does not matter. */
interface AccelNumbers {
  rateMultiplier: number;
  countWhileBoosted: boolean;
  boostSecPerTrigger: number;
  ballsPerTrigger: number;
  maxBoostSec: number;
}
const CONFIGURED: AccelNumbers = {
  rateMultiplier: accel.rateMultiplier,
  countWhileBoosted: accel.countWhileBoosted,
  boostSecPerTrigger: accel.boostSecPerTrigger,
  ballsPerTrigger: accel.ballsPerTrigger,
  maxBoostSec: accel.maxBoostSec,
};
const accelVariant = (label: string, v: Partial<AccelNumbers>): Variant => ({
  label,
  apply: () => Object.assign(accel, CONFIGURED, v),
});
const VARIANTS: Variant[] = [
  accelVariant('configured', {}),
  // ACCEL history (docs/DESIGN.md): the boost used to keep itself alive; the adopted spec is x3.0, 4 s, periodic.
  accelVariant('count while boosted (old), x2.5, boost 3 s', { countWhileBoosted: true, rateMultiplier: 2.5, boostSecPerTrigger: 3 }),
  accelVariant('no count while boosted, x2.5, boost 3 s', { countWhileBoosted: false, rateMultiplier: 2.5, boostSecPerTrigger: 3 }),
  accelVariant('no count while boosted, x3.0, boost 3 s', { countWhileBoosted: false, rateMultiplier: 3.0, boostSecPerTrigger: 3 }),
  accelVariant('no count while boosted, x3.5, boost 3 s', { countWhileBoosted: false, rateMultiplier: 3.5, boostSecPerTrigger: 3 }),
  accelVariant('no count while boosted, x3.0, boost 4 s (adopted)', { countWhileBoosted: false, rateMultiplier: 3.0, boostSecPerTrigger: 4 }),
  accelVariant('no count while boosted, x3.0, boost 3 s, 8 balls per trigger', { countWhileBoosted: false, rateMultiplier: 3.0, boostSecPerTrigger: 3, ballsPerTrigger: 8 }),
  accelVariant('adopted with maxBoostSec 8', { countWhileBoosted: false, rateMultiplier: 3.0, boostSecPerTrigger: 4, maxBoostSec: 8 }),
];

// ---------------------------------------------------------------- play

function play(offers: Offer[], choose: Chooser): number {
  const sim = new Simulation(DURATION);
  let k = 0;
  while (!sim.ended) {
    while (k < offers.length && sim.timeSec >= offers[k].atSec && !sim.ended) {
      const cards = offers[k].cards.map((c) => c.id);
      const allowed = cards.map((id) => sim.canPick(id));
      sim.addMachine(choose(sim, cards, allowed));
      k += 1;
    }
    sim.step();
  }
  return sim.score;
}

/** Picks the first card of `order` that is offered and allowed. */
function prefer(order: MachineId[]): Chooser {
  return (_sim, cards, allowed) =>
    order.find((id) => cards.includes(id) && allowed[cards.indexOf(id)]) ?? cards[allowed.indexOf(true)];
}

const EARLY: MachineId[] = ['press', 'accelerator', 'speed', 'extend', 'splitter'];
const LATE: MachineId[] = ['splitter', 'press', 'extend', 'accelerator', 'speed'];

/** Strategies a player could follow from a one-line rule. */
const STRATEGIES: Record<string, Chooser> = {
  'SPLIT first (S>V>P>A>E)': prefer(['splitter', 'speed', 'press', 'accelerator', 'extend']),
  'EXTEND first (E>P>S>V>A)': prefer(['extend', 'press', 'splitter', 'speed', 'accelerator']),
  'P>A>V>E>S fixed': prefer(EARLY),
  'P>A>V early, S in the last 20 s': (sim, cards, allowed) => prefer(sim.remainingSec <= 20 ? LATE : EARLY)(sim, cards, allowed),
  'press while the budget has room, else SPLIT': (sim, cards, allowed) => {
    let flow = sim.baseRate;
    let used = 0;
    for (const m of sim.line) {
      if (m.id === 'splitter') flow *= BALANCE.machines.splitter.multiplier;
      if (m.id === 'press') used += flow * m.processed;
    }
    const left = Math.max(0, BALANCE.machines.press.capacityPerSec * sim.pressBudgetMultiplier - used);
    const order: MachineId[] =
      cards.includes('press') && left >= 0.5 * flow
        ? ['press', 'splitter', 'speed', 'accelerator', 'extend']
        : ['splitter', 'speed', 'press', 'accelerator', 'extend'];
    return prefer(order)(sim, cards, allowed);
  },
};

// ---------------------------------------------------------------- optimum

function cloneSim(s: Simulation): Simulation {
  const c = new Simulation(s.durationSec);
  Object.assign(c, {
    steps: (s as unknown as { steps: number }).steps,
    score: s.score,
    ballsOut: s.ballsOut,
    baseRate: s.baseRate,
    boostRemainingSec: s.boostRemainingSec,
    speedCount: s.speedCount,
    extendCount: s.extendCount,
    bonusTimeSec: s.bonusTimeSec,
    line: s.line.map((m) => ({ ...m })),
  });
  return c;
}

interface Optimum {
  score: number;
  picks: MachineId[];
  leaves: number;
}

/** Depth-first enumeration of every pick sequence. */
function optimum(offers: Offer[]): Optimum {
  const best: Optimum = { score: 0, picks: [], leaves: 0 };
  const picks: MachineId[] = [];
  function run(sim: Simulation, k: number): void {
    while (!sim.ended && !(k < offers.length && sim.timeSec >= offers[k].atSec)) sim.step();
    if (sim.ended) {
      best.leaves += 1;
      if (sim.score > best.score) {
        best.score = sim.score;
        best.picks = picks.slice();
      }
      return;
    }
    const options = [...new Set(offers[k].cards.map((c) => c.id))].filter((id) => sim.canPick(id));
    for (const id of options) {
      const next = cloneSim(sim);
      next.addMachine(id);
      picks.push(id);
      run(next, k + 1);
      picks.pop();
    }
  }
  run(new Simulation(DURATION), 0);
  return best;
}

// ---------------------------------------------------------------- random

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRatios(offers: Offer[], best: number, seed: number): number[] {
  const rng = mulberry32(seed * 7919);
  const out: number[] = [];
  for (let i = 0; i < RANDOM_RUNS; i++) {
    out.push(
      play(offers, (_sim, cards, allowed) => {
        const options = cards.filter((_, j) => allowed[j]);
        return options[Math.floor(rng() * options.length)];
      }) / best,
    );
  }
  return out;
}

// ---------------------------------------------------------------- report

interface Row {
  seed: number;
  best: Optimum;
  strategy: Record<string, number>;
  random: number[];
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function lineOrder(picks: MachineId[]): string {
  // Line machines in placement order (SPEED and EXTEND are not on the line).
  return picks.filter((id) => BALANCE.machineDefs.find((d) => d.id === id)?.onLine).map((id) => LETTER[id]).join('');
}

function splitsBeforeFirstAccel(picks: MachineId[]): number | null {
  const line = picks.filter((id) => BALANCE.machineDefs.find((d) => d.id === id)?.onLine);
  const i = line.indexOf('accelerator');
  return i < 0 ? null : line.slice(0, i).filter((id) => id === 'splitter').length;
}

function runSpec(label: string): void {
  const t0 = Date.now();
  const rows: Row[] = SEEDS.map((seed) => {
    const offers = generateOffers(seed, LONGEST);
    const best = optimum(offers);
    const strategy: Record<string, number> = {};
    for (const [name, choose] of Object.entries(STRATEGIES)) strategy[name] = play(offers, choose) / best.score;
    return { seed, best, strategy, random: randomRatios(offers, best.score, seed) };
  });
  const n = rows.length;

  console.log(`\n## ${label}  (${n} seeds, ${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
  console.log('| seed | optimum | picks | line | random mean |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.seed} | ${Math.round(r.best.score).toLocaleString('en-US')} | ${r.best.picks.map((id) => LETTER[id]).join(' ')} | ${lineOrder(r.best.picks)} | ${pct(mean(r.random))} |`,
    );
  }

  console.log('\n| card | seeds where the optimum contains it | at least 2 |');
  console.log('|---|---|---|');
  for (const id of CARDS) {
    const has = rows.filter((r) => r.best.picks.includes(id)).length;
    const two = rows.filter((r) => r.best.picks.filter((p) => p === id).length >= 2).length;
    console.log(`| ${id} (${LETTER[id]}) | ${has} / ${n} | ${two} / ${n} |`);
  }

  console.log('\n| strategy | mean of optimum | min | max |');
  console.log('|---|---|---|---|');
  for (const name of Object.keys(STRATEGIES)) {
    const v = rows.map((r) => r.strategy[name]);
    console.log(`| ${name} | ${pct(mean(v))} | ${pct(Math.min(...v))} | ${pct(Math.max(...v))} |`);
  }
  const all = rows.flatMap((r) => r.random).sort((a, b) => a - b);
  const q = (p: number): string => pct(all[Math.floor(all.length * p)]);
  console.log(`| random (${RANDOM_RUNS} runs per seed) | ${pct(mean(all))} | median ${q(0.5)} | p90 ${q(0.9)}, p99 ${q(0.99)} |`);

  const orders = new Map<string, number>();
  for (const r of rows) orders.set(lineOrder(r.best.picks), (orders.get(lineOrder(r.best.picks)) ?? 0) + 1);
  console.log(`\ndistinct line orders in optima: ${orders.size} / ${n}`);
  const dist = new Map<string, number>();
  for (const r of rows) {
    const k = splitsBeforeFirstAccel(r.best.picks);
    const key = k === null ? 'no ACCEL' : String(k);
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
  console.log(`SPLITs before the first ACCEL: ${[...dist.entries()].sort().map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  const scores = rows.map((r) => r.best.score);
  console.log(`optimum score range: ${Math.round(Math.min(...scores))} .. ${Math.round(Math.max(...scores))}`);
}

if (RUN_VARIANTS || VARIANT_FILTER) {
  for (const v of VARIANTS) {
    if (VARIANT_FILTER && !v.label.includes(VARIANT_FILTER)) continue;
    v.apply();
    runSpec(v.label);
  }
} else {
  runSpec('configured');
}
