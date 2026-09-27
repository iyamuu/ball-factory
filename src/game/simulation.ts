import { BALANCE, type MachineId } from '../config/balance';

export interface LineMachine {
  id: MachineId;
  /** Accelerator only: logical balls accumulated toward the next trigger (fraction kept). */
  accum: number;
}

export interface StepResult {
  /** Score gained during this step. */
  gained: number;
  /** Number of accelerator triggers fired during this step. */
  triggers: number;
  /** True if boost went from inactive to active during this step. */
  boostStarted: boolean;
}

/**
 * Pure production model. Balls are tracked as fractional quantities ("batches"), not as objects,
 * so cost does not grow with production. Rendering is handled separately with a capped pool.
 *
 * Per step:
 *   rate  = baseRate * (boost active ? accel multiplier : 1)   -- boost state from the previous step
 *   batch = rate * dt balls, value = baseValue
 *   batch passes through the line in order: Splitter multiplies count, Accelerator accumulates
 *   count and adds boost time per trigger, Doubler multiplies value
 *   score += count * value
 */
export class Simulation {
  timeSec = 0;
  score = 0;
  ballsOut = 0;
  baseRate: number = BALANCE.production.baseRate;
  boostRemainingSec = 0;
  line: LineMachine[] = [];
  speedCount = 0;

  private readonly accel = BALANCE.machines.accelerator;

  get boostActive(): boolean {
    return this.boostRemainingSec > 0;
  }

  /** Balls per second leaving the source right now. */
  get sourceRate(): number {
    return this.baseRate * (this.boostActive ? this.accel.rateMultiplier : 1);
  }

  /** Score per second at the end of the line right now. */
  get scoreRate(): number {
    let count = this.sourceRate;
    let value = BALANCE.production.baseValue;
    for (const m of this.line) {
      if (m.id === 'splitter') count *= BALANCE.machines.splitter.multiplier;
      else if (m.id === 'doubler') value *= BALANCE.machines.doubler.multiplier;
    }
    return count * value;
  }

  addMachine(id: MachineId): void {
    if (id === 'speed') {
      this.baseRate *= BALANCE.machines.speed.multiplier;
      this.speedCount += 1;
      return;
    }
    this.line.push({ id, accum: 0 });
  }

  step(dt: number): StepResult {
    const wasActive = this.boostActive;
    const rate = this.sourceRate;

    // Boost that was active during this step is consumed now; boost added below applies next step.
    this.boostRemainingSec = Math.max(0, this.boostRemainingSec - dt);

    let count = rate * dt;
    let value = BALANCE.production.baseValue;
    let triggers = 0;

    for (const m of this.line) {
      switch (m.id) {
        case 'splitter':
          count *= BALANCE.machines.splitter.multiplier;
          break;
        case 'doubler':
          value *= BALANCE.machines.doubler.multiplier;
          break;
        case 'accelerator':
          m.accum += count;
          while (m.accum >= this.accel.ballsPerTrigger) {
            m.accum -= this.accel.ballsPerTrigger;
            this.boostRemainingSec = Math.min(
              this.boostRemainingSec + this.accel.boostSecPerTrigger,
              this.accel.maxBoostSec,
            );
            triggers += 1;
          }
          break;
        case 'speed':
          break;
      }
    }

    const gained = count * value;
    this.score += gained;
    this.ballsOut += count;
    this.timeSec += dt;

    return { gained, triggers, boostStarted: !wasActive && this.boostActive };
  }
}
