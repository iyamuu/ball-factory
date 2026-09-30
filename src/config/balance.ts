/**
 * All gameplay numbers live here. Everything is a provisional value for the prototype.
 * Time values are in seconds unless the name says otherwise.
 */

export type MachineId = 'splitter' | 'accelerator' | 'press' | 'speed' | 'extend';

export interface MachineDef {
  id: MachineId;
  /** Short label shown on the card. Keep it to a word or two. */
  label: string;
  /** Number shown on the card below the label (e.g. "x2"). */
  figure: string;
  /** One-line effect description shown on the card. */
  desc: string;
  /** Display colour. */
  color: number;
  /** True if the machine is placed on the line. Speed upgrades the source instead. */
  onLine: boolean;
}

/** Machine effect numbers. Defined first so card text below can be derived from them. */
const MACHINES = {
  splitter: {
    /** Each ball passing through becomes this many balls. */
    multiplier: 2,
  },
  accelerator: {
    /** Logical balls that must pass through to add one burst of boost time. */
    ballsPerTrigger: 10,
    /** Boost time added per trigger. 4 s: with 3 s the optimum lost EXTEND on one more seed (docs/DESIGN.md). */
    boostSecPerTrigger: 4,
    /** Remaining boost time is capped here. */
    maxBoostSec: 6,
    /**
     * Production rate multiplier while boost is active. Not stacked across accelerators.
     * Chosen by brute force (docs/DESIGN.md): with a periodic boost (countWhileBoosted false), 2.5
     * let a one-line strategy reach 56% of the optimum; 3.0 keeps it at 50% with every card in the
     * optimum of at least 16 of 20 seeds.
     */
    rateMultiplier: 3.0,
    /**
     * true: while boost is active the shared press budget is multiplied by rateMultiplier too,
     * so the boost speeds up the whole factory instead of only pushing more balls past the
     * presses. Chosen by brute force: without this ACCEL is in the optimum of 1 of 6 seeds,
     * with it in 6 of 6 (docs/DESIGN.md).
     */
    scalesPressBudget: true,
    /**
     * false: only balls passing while the boost is off count toward the next trigger, so the boost is
     * periodic (at 2 balls/s: 5 s off, 4 s on) and stronger the more balls reach the accelerator
     * unboosted (SPLIT in front of it).
     * true: balls passing during the boost count too. With the numbers above that kept the boost on
     * for the rest of the round once it started (the boosted flow delivered 10 balls before the
     * boost ran out), which contradicted the card text (docs/DESIGN.md).
     */
    countWhileBoosted: false,
  },
  press: {
    /** Value multiplier for processed balls. */
    multiplier: 3,
    /** Balls per second that can be processed. Balls above this pass through unchanged. */
    capacityPerSec: 8,
    /**
     * true: capacityPerSec is one budget shared by every press on the line, spent in line order.
     * false: every press has its own capacityPerSec.
     *
     * Chosen by brute force over every pick sequence (3^9) of seeded rounds: with a per-press
     * budget and x2, PRESS ties with SPLIT while the flow is below the budget and is never
     * chosen once above it; with a multiplier above 2 and a per-press budget, PRESS alone
     * dominates. A shared budget with x3 gives optima that contain both SPLIT and PRESS with
     * the budget binding (see docs/DESIGN.md).
     */
    shared: true,
  },
  speed: {
    /** Source base rate multiplier. */
    multiplier: 1.5,
    /**
     * true: each SPEED also multiplies the shared press budget by `multiplier`, so the presses keep
     * up with the faster source. Chosen by brute force: without this SPEED is in the optimum of
     * 1 of 6 seeds, with it in 5 of 6 (docs/DESIGN.md).
     */
    scalesPressBudget: true,
  },
  extend: {
    /** Seconds added to the round. Offers keep coming every intervalSec until the round ends. */
    seconds: 5,
    /** EXTEND picks allowed per round. Offers may still show it afterwards, greyed out. */
    maxPerRound: 3,
  },
} as const;

export const BALANCE = {
  round: {
    /** Round length. */
    durationSec: 70,
    /** Simulation step. Production is integrated at this fixed step, independent of frame rate. */
    simStepSec: 0.05,
  },

  production: {
    /** Balls per second produced by the source at the start of a round. */
    baseRate: 2,
    /** Score value of one ball before any Press. */
    baseValue: 1,
  },

  cards: {
    /** Sim-time of the first offer. */
    firstOfferAtSec: 3,
    /** Sim-time between offers (measured from the previous offer). */
    intervalSec: 8,
    /** Number of cards shown per offer. Must be <= number of machine kinds. */
    choices: 3,
    /**
     * Offer seed. null: a new random seed every round. A number fixes the sequence for every
     * round, which is what the ?seed= URL parameter does for testing and comparison.
     */
    seed: null as number | null,
  },

  machines: MACHINES,

  /** Card definitions. Order here is the order used by the seeded draw. Text is derived from MACHINES. */
  machineDefs: [
    {
      id: 'splitter',
      label: 'SPLIT',
      figure: `x${MACHINES.splitter.multiplier}`,
      desc: `Balls x${MACHINES.splitter.multiplier}`,
      color: 0x4fc3f7,
      onLine: true,
    },
    {
      id: 'accelerator',
      label: 'ACCEL',
      figure: `${MACHINES.accelerator.ballsPerTrigger} > ${MACHINES.accelerator.boostSecPerTrigger}s`,
      desc: `Every ${MACHINES.accelerator.ballsPerTrigger}${MACHINES.accelerator.countWhileBoosted ? '' : ' unboosted'} balls: ${
        MACHINES.accelerator.scalesPressBudget ? 'source and presses' : 'speed'
      } x${MACHINES.accelerator.rateMultiplier} for ${MACHINES.accelerator.boostSecPerTrigger}s`,
      color: 0xffb74d,
      onLine: true,
    },
    {
      id: 'press',
      label: 'PRESS',
      figure: `x${MACHINES.press.multiplier}`,
      desc: MACHINES.press.shared
        ? `Value x${MACHINES.press.multiplier}. All presses share ${MACHINES.press.capacityPerSec} balls/s`
        : `Value x${MACHINES.press.multiplier}, up to ${MACHINES.press.capacityPerSec} balls/s`,
      color: 0xba68c8,
      onLine: true,
    },
    {
      id: 'speed',
      label: 'SPEED',
      figure: `x${MACHINES.speed.multiplier}`,
      desc: MACHINES.speed.scalesPressBudget
        ? `Source and presses x${MACHINES.speed.multiplier}`
        : `Source speed x${MACHINES.speed.multiplier}`,
      color: 0x81c784,
      onLine: false,
    },
    {
      id: 'extend',
      label: 'EXTEND',
      figure: `+${MACHINES.extend.seconds}s`,
      desc: `Round +${MACHINES.extend.seconds}s (max ${MACHINES.extend.maxPerRound} per round)`,
      color: 0xfff176,
      onLine: false,
    },
  ] as MachineDef[],

  visuals: {
    /**
     * Safety limit on ball shapes drawn at once. Production is not limited by this, and with the
     * values below the limit is normally not reached: at most maxSpawnPerSec * 2^maxVisualSplits
     * balls enter the line per second, and a ball takes about 4 s to cross it.
     */
    maxBalls: 300,
    /** Shapes kept free for the source so the start of the line never runs dry while splitters copy balls. */
    sourceReserve: 40,
    /** Maximum ball shapes spawned per second at the source. */
    maxSpawnPerSec: 8,
    /**
     * How many times one source ball (and its copies) can be split visually. Each split doubles,
     * so a source ball becomes at most 2^maxVisualSplits shapes. Splitters beyond that let the
     * balls pass unchanged; production is not affected.
     */
    maxVisualSplits: 3,
    /** Half height of the band, in pixels, that balls are spread over after a split. */
    laneHalfWidthPx: 40,
    /** Pixels per second a ball shape travels along the line. */
    ballSpeedPx: 260,
    /** Interval between "+N" popups. */
    popupIntervalSec: 0.5,
  },

  playback: {
    /**
     * Speeds offered by the speed button: simulation seconds per wall-clock second. Every number in
     * this file is in simulation time, so the speed changes only how long a round takes to watch,
     * never the score. Offers still pause the round, so the time to decide is not shortened.
     */
    speeds: [1, 1.25, 1.5, 2],
    /** Speed for a player who has not picked one (and when storage is unavailable). */
    defaultSpeed: 1,
  },

  shake: {
    /** Set to false to disable all camera shake. */
    enabled: true,
    durationMs: 120,
    intensity: 0.004,
  },

  sound: {
    /** Default for a player who has not toggled the speaker button. All sounds are synthesised (src/audio/sfx.ts). */
    enabled: true,
    /** Master volume, 0..1. */
    masterVolume: 0.5,
    /** Shortest wall-clock gap between two "+N" coin sounds (they are also paced by popupIntervalSec). */
    minGainGapSec: 0.2,
  },

  heat: {
    /**
     * Score rate without the ACCEL boost (/s) at which heat stage 1, 2 and 3 start. The stage never drops
     * within a round, and a boost does not count, so a stage is earned by the line itself. Heat raises
     * the FEVER continue chance (fever.continueByHeat). Chosen from `npm run balance -- --rates` on 20
     * seeds: 25 is reached by half of random-pick rounds around 50 s and by the simple rule at 35 s; 100
     * by the simple rule around 50 s and by about a quarter of random rounds at the end; 500 by half of
     * optimal rounds and fewer than half of simple-rule rounds at the end, and by no random rounds.
     * (The first thresholds, 30 / 150 / 1000, were on the rate with the boost.)
     */
    thresholds: [25, 100, 500],
  },

  /**
   * Fever lottery (docs/DESIGN.md). Every score milestone adds a hold; holds are drawn one at a time
   * on a three-digit reel; a hit starts FEVER, which multiplies the score for a while and may continue.
   * Results come from a generator seeded by the round seed, so a seed and a pick sequence always give
   * the same round. The ?fever=0 URL parameter turns the lottery off for comparison.
   */
  fever: {
    enabled: true,
    /** Milestone k (0-based) is at milestoneBase * milestoneGrowth^k points; each one adds a hold. */
    milestoneBase: 50,
    milestoneGrowth: 1.8,
    /** Holds kept at once; milestones passed while full are lost. */
    maxHolds: 4,
    /** Hold colours, coolest first. The last one is a certain hit. */
    colors: ['white', 'blue', 'green', 'red', 'gold'] as const,
    /**
     * Relative weight of each colour when a hold is added. These used to rise with the heat stage; that
     * added only 0.1-0.25 hits per round (`npm run balance -- --fever`), so heat now acts on the
     * continue chance instead.
     */
    colorWeights: [60, 20, 10, 7, 3],
    /** Hit chance per colour. Red is the one near 50%, where anticipation peaks. */
    hitChance: [0.03, 0.12, 0.3, 0.5, 1],
    /** Share of misses shown with a reach (the first two digits match). Hits always reach. */
    reachOnMiss: 0.25,
    /**
     * After this many misses in a row the next hold is a hit (pity ceiling). With 8, a quarter of
     * random-pick rounds (about 8 draws) never hit; with 5, 2% (`npm run balance -- --fever`).
     */
    ceiling: 5,
    /** Draw length without a reach and with one (sim seconds). */
    drawSec: 1.5,
    reachDrawSec: 4,
    /** Sim-time into a draw at which the left and right digits stop. */
    leftStopSec: 1.0,
    rightStopSec: 1.5,
    /**
     * Score multiplier while FEVER runs, by chain: the hit itself, the first continuation, and so on.
     * The last value holds for longer chains, so a chain pays more the longer it runs. Chosen with
     * `npm run balance -- --fever` (20 seeds x 50 lottery seeds, docs/DESIGN.md): with continueByHeat
     * and maxChain below this adds 10% (random picks) to 15% (optimum) on average and at most 45% at
     * p95. x1.3 / x1.6 / x2 reached 56% at p95; x1.5 / x2 / x2.5 with a flat 50% continue chance, 114%.
     */
    chainMultipliers: [1.3, 1.5, 1.8],
    /** FEVER length per hit or continuation (sim seconds). */
    durationSec: 5,
    /**
     * Chance that FEVER continues for another durationSec when it runs out, by heat stage 0..3. Centred
     * on 50%, where anticipation peaks, and higher for a stronger line.
     */
    continueByHeat: [0.35, 0.42, 0.5, 0.55],
    /** Longest chain; at this chain FEVER ends without a continue draw. Caps the luck in top scores. */
    maxChain: 5,
    /** Wall-clock length of the continue draw shown when FEVER runs out, during which the round is paused. */
    continueDrawMs: 800,
    /** Wall-clock length of the hit cut-in, during which the round is paused. */
    cutInMs: 1200,
  },

  feedback: {
    /** The "/s" readout counts up from the old to the new value after a pick, over this long. */
    rateCountUpMs: 600,
    /** Multiplier shown in the centre after a pick ("x3"), lifetime. */
    multiplierPopupMs: 900,
  },

  storage: {
    key: 'ball-factory.v1',
    /** Last speed picked with the speed button. Kept apart from the best score. */
    speedKey: 'ball-factory.speed.v1',
    /** Speaker button state ("1" or "0"). */
    soundKey: 'ball-factory.sound.v1',
  },
} as const;
