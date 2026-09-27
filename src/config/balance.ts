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
    /** Boost time added per trigger. */
    boostSecPerTrigger: 3,
    /** Remaining boost time is capped here. */
    maxBoostSec: 6,
    /**
     * Production rate multiplier while boost is active. Not stacked across accelerators.
     * 2.0 chosen by brute force: at 1.5 ACCEL never appeared in an optimal pick sequence on six
     * seeds; at 2.0 it appears in three of six without displacing SPLIT/PRESS (docs/DESIGN.md).
     */
    rateMultiplier: 2.0,
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
     * Offer seed. null: a new random seed every round (shown on the result screen, and the
     * player can replay the same seed). A number fixes the sequence for every round, which
     * is what the ?seed= URL parameter does for testing and comparison.
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
      desc: `Every ${MACHINES.accelerator.ballsPerTrigger} balls: speed x${MACHINES.accelerator.rateMultiplier} for ${MACHINES.accelerator.boostSecPerTrigger}s`,
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
      desc: `Source speed x${MACHINES.speed.multiplier}`,
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

  shake: {
    /** Set to false to disable all camera shake. */
    enabled: true,
    durationMs: 120,
    intensity: 0.004,
  },

  storage: {
    key: 'ball-factory.v1',
  },
} as const;
