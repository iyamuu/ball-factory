import { BALANCE, type MachineId } from '../config/balance';

export interface LineMachine {
  id: MachineId;
  /** Accelerator: logical balls accumulated toward the next trigger (fraction kept). */
  accum: number;
  /** Press: share of balls processed in the last step, 0..1. */
  processed: number;
}

export interface StepResult {
  /** Score gained during this step. */
  gained: number;
  /** Number of accelerator triggers fired during this step. */
  triggers: number;
  /** True if boost went from inactive to active during this step. */
  boostStarted: boolean;
}

/** A group of balls that share the same value. A batch is a list of groups. */
interface Group {
  count: number;
  value: number;
}

/**
 * Pure production model. Balls are tracked as fractional quantities ("batches"), not as objects,
 * so cost does not grow with production. Rendering is handled separately with a capped pool.
 *
 * Per step:
 *   rate  = baseRate * (boost active ? accel multiplier : 1)   -- boost state from the previous step
 *   batch = rate * dt balls at baseValue
 *   the batch passes through the line in order: Splitter multiplies count, Accelerator accumulates
 *   count and adds boost time per trigger, Press doubles the value of up to its capacity and lets
 *   the rest through unchanged
 *   score += sum(count * value)
 */
export class Simulation {
  /** Elapsed fixed steps. Time is derived from this so it stays exact at whole seconds. */
  private steps = 0;
  score = 0;
  ballsOut = 0;
  baseRate: number = BALANCE.production.baseRate;
  boostRemainingSec = 0;
  line: LineMachine[] = [];
  speedCount = 0;
  extendCount = 0;
  /** Seconds added to the round by EXTEND cards. */
  bonusTimeSec = 0;
  /** Base round length; EXTEND adds to it. */
  readonly durationSec: number;

  constructor(durationSec: number = BALANCE.round.durationSec) {
    this.durationSec = durationSec;
  }

  /** Elapsed simulation time. One multiplication, so offer times and the round end compare exactly. */
  get timeSec(): number {
    return this.steps * this.stepSec;
  }

  /** Time left in the round, including seconds added by EXTEND. */
  get remainingSec(): number {
    return Math.max(0, this.durationSec + this.bonusTimeSec - this.timeSec);
  }

  get ended(): boolean {
    return this.remainingSec <= 0;
  }

  /** Length of one simulation step. */
  readonly stepSec: number = BALANCE.round.simStepSec;

  /** True while another EXTEND may be picked this round. */
  get canExtend(): boolean {
    return this.extendCount < BALANCE.machines.extend.maxPerRound;
  }

  /** Whether a card can be picked in the current state (per-round caps live here). */
  canPick(id: MachineId): boolean {
    return id !== 'extend' || this.canExtend;
  }

  private readonly accel = BALANCE.machines.accelerator;

  get boostActive(): boolean {
    return this.boostRemainingSec > 0;
  }

  /** Balls per second leaving the source right now. */
  get sourceRate(): number {
    return this.baseRate * (this.boostActive ? this.accel.rateMultiplier : 1);
  }

  /** Score per second at the end of the line right now (no state is changed). */
  get scoreRate(): number {
    const groups = this.runLine([{ count: this.sourceRate, value: BALANCE.production.baseValue }], 1, false);
    return groups.reduce((s, g) => s + g.count * g.value, 0);
  }

  /** Applies a picked card. Returns false (and changes nothing) when canPick(id) is false. */
  addMachine(id: MachineId): boolean {
    if (!this.canPick(id)) return false;
    switch (id) {
      case 'speed':
        this.baseRate *= BALANCE.machines.speed.multiplier;
        this.speedCount += 1;
        break;
      case 'extend':
        this.bonusTimeSec += BALANCE.machines.extend.seconds;
        this.extendCount += 1;
        break;
      default:
        this.line.push({ id, accum: 0, processed: 1 });
    }
    return true;
  }

  /** Advances the model by one fixed step (BALANCE.round.simStepSec). */
  step(): StepResult {
    const dt = this.stepSec;
    const wasActive = this.boostActive;
    const rate = this.sourceRate;

    // Boost that was active during this step is consumed now; boost added below applies next step.
    this.boostRemainingSec = Math.max(0, this.boostRemainingSec - dt);

    const counter = { triggers: 0 };
    const groups = this.runLine([{ count: rate * dt, value: BALANCE.production.baseValue }], dt, true, counter);
    const triggers = counter.triggers;

    let gained = 0;
    let count = 0;
    for (const g of groups) {
      gained += g.count * g.value;
      count += g.count;
    }
    this.score += gained;
    this.ballsOut += count;
    this.steps += 1;

    return { gained, triggers, boostStarted: !wasActive && this.boostActive };
  }

  /**
   * Passes a batch through the line. With `mutate` true, accelerators accumulate and add boost
   * time (counted into `counter`) and presses record their processed share; with false, nothing
   * is changed.
   */
  private runLine(groups: Group[], dt: number, mutate: boolean, counter = { triggers: 0 }): Group[] {
    const press = BALANCE.machines.press;
    // Shared mode: one processing budget for the whole line, spent by presses in order.
    let pressBudget = press.capacityPerSec * dt;
    for (const m of this.line) {
      switch (m.id) {
        case 'splitter':
          for (const g of groups) g.count *= BALANCE.machines.splitter.multiplier;
          break;
        case 'accelerator': {
          if (!mutate) break;
          m.accum += groups.reduce((s, g) => s + g.count, 0);
          while (m.accum >= this.accel.ballsPerTrigger) {
            m.accum -= this.accel.ballsPerTrigger;
            this.boostRemainingSec = Math.min(
              this.boostRemainingSec + this.accel.boostSecPerTrigger,
              this.accel.maxBoostSec,
            );
            counter.triggers += 1;
          }
          break;
        }
        case 'press': {
          const total = groups.reduce((s, g) => s + g.count, 0);
          const capacity = press.shared ? pressBudget : press.capacityPerSec * dt;
          const share = total <= 0 ? 1 : Math.min(1, capacity / total);
          if (press.shared) pressBudget = Math.max(0, pressBudget - total * share);
          if (mutate) m.processed = share;
          // A proportional share of every group is processed; the rest passes unchanged.
          const next: Group[] = [];
          for (const g of groups) {
            if (share > 0) next.push({ count: g.count * share, value: g.value * press.multiplier });
            if (share < 1) next.push({ count: g.count * (1 - share), value: g.value });
          }
          groups = mergeGroups(next);
          break;
        }
        case 'speed':
        case 'extend':
          break;
      }
    }
    return groups;
  }
}

/** Merges groups with equal value so the list stays short after several presses. */
function mergeGroups(groups: Group[]): Group[] {
  const byValue = new Map<number, Group>();
  for (const g of groups) {
    const existing = byValue.get(g.value);
    if (existing) existing.count += g.count;
    else byValue.set(g.value, { count: g.count, value: g.value });
  }
  return [...byValue.values()];
}
