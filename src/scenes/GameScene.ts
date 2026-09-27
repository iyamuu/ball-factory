import Phaser from 'phaser';
import { BALANCE, type MachineDef, type MachineId } from '../config/balance';
import { generateOffers, type Offer } from '../game/cards';
import { Rng } from '../game/rng';
import { Simulation } from '../game/simulation';
import { loadBest, saveBest } from '../game/storage';
import { WIDTH } from '../main';
import { RUNTIME } from '../runtime';
import { CardPanel } from '../ui/CardPanel';
import { drawMachineIcon, FONT } from '../ui/icons';
import { spawnPopup } from '../ui/Popup';

const LINE_Y = 440;
const SOURCE_X = 110;
const BIN_X = 1170;
const FIRST_MACHINE_X = 250;
const LAST_MACHINE_X = 1090;
const MAX_SPACING = 110;
/** Upper bound on simulation steps run in one frame (2 s of sim time at the default step). */
const MAX_STEPS_PER_FRAME = 40;
/** A frame longer than this is treated as a stall, not as elapsed play time. */
const MAX_FRAME_SEC = 1;

interface VisualBall {
  shape: Phaser.GameObjects.Arc;
  /** Index of the next line machine this ball has not passed yet. */
  nextMachine: number;
  active: boolean;
}

export interface RoundResult {
  score: number;
  previousBest: number;
  saved: boolean;
}

/** Testing hook exposed on window.__bf. */
interface DebugHook {
  sim: Simulation;
  isPaused: () => boolean;
  offersShown: () => number;
  pick: (index: number) => void;
  visibleBalls: () => number;
  remainingSec: () => number;
  offers: () => MachineId[][];
}

export class GameScene extends Phaser.Scene {
  private sim!: Simulation;
  private offers: Offer[] = [];
  private nextOffer = 0;
  private paused = false;
  private ended = false;
  private simAccumulator = 0;
  private skipNextDelta = true;
  private fxRng!: Rng;

  private timerText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private rateText!: Phaser.GameObjects.Text;
  private sourceText!: Phaser.GameObjects.Text;
  private sourceShape!: Phaser.GameObjects.Arc;
  private boostRing!: Phaser.GameObjects.Arc;
  private machineNodes: Phaser.GameObjects.Container[] = [];
  private machineXs: number[] = [];
  private lineGfx!: Phaser.GameObjects.Graphics;
  private panel!: CardPanel;

  private balls: VisualBall[] = [];
  private spawnAcc = 0;
  private popupAcc = 0;
  private popupGain = 0;

  constructor() {
    super('Game');
  }

  create(): void {
    this.sim = new Simulation();
    this.offers = generateOffers(RUNTIME.seed, RUNTIME.roundDurationSec);
    this.nextOffer = 0;
    this.paused = false;
    this.ended = false;
    this.simAccumulator = 0;
    this.skipNextDelta = true;
    this.spawnAcc = 0;
    this.popupAcc = 0;
    this.popupGain = 0;
    this.fxRng = new Rng((Date.now() & 0xffffffff) >>> 0);
    this.machineNodes = [];
    this.machineXs = [];
    this.balls = [];

    this.buildStaticUi();
    this.buildBallPool();
    this.panel = new CardPanel(this);
    this.layoutMachines();
    this.refreshTexts();

    const hook: DebugHook = {
      sim: this.sim,
      isPaused: () => this.paused,
      offersShown: () => this.nextOffer,
      pick: (i) => this.pickCard(i),
      visibleBalls: () => this.balls.filter((b) => b.active).length,
      remainingSec: () => Math.max(0, RUNTIME.roundDurationSec - this.sim.timeSec),
      offers: () => this.offers.map((o) => o.cards.map((c) => c.id)),
    };
    (window as unknown as { __bf: DebugHook }).__bf = hook;
  }

  update(_time: number, deltaMs: number): void {
    if (this.ended || this.paused) return;

    // The first delta after create() includes scene construction time; do not count it as play time.
    if (this.skipNextDelta) {
      this.skipNextDelta = false;
      return;
    }

    // Fixed-step simulation, independent of frame rate. The full elapsed time is kept so a slow
    // device does not stretch the round; only the catch-up work per frame is bounded, and any
    // remainder is carried over to the next frame. A single frame longer than MAX_FRAME_SEC is
    // treated as a stall (debugger, OS sleep) rather than play time.
    const dt = Math.min(deltaMs / 1000, MAX_FRAME_SEC);
    this.simAccumulator += dt;
    const step = BALANCE.round.simStepSec;
    let steps = 0;
    while (this.simAccumulator >= step && steps < MAX_STEPS_PER_FRAME) {
      this.simAccumulator -= step;
      this.runSimStep(step);
      steps += 1;
      if (this.paused || this.ended) break;
    }

    // Visuals are cosmetic: clamp so balls do not teleport after a long frame.
    this.updateBalls(Math.min(dt, 0.1));
    this.refreshTexts();
  }

  // ---------------------------------------------------------------- simulation

  private runSimStep(step: number): void {
    const before = this.sim.scoreRate;
    const res = this.sim.step(step);
    this.popupGain += res.gained;
    this.popupAcc += step;

    if (res.boostStarted) {
      this.flashBoost();
      this.shake(0.5);
    }
    if (this.sim.scoreRate !== before) this.refreshSource();

    if (this.popupAcc >= BALANCE.visuals.popupIntervalSec) {
      this.popupAcc = 0;
      const n = Math.floor(this.popupGain);
      this.popupGain -= n;
      if (n > 0) {
        const x = WIDTH / 2 + this.fxRng.range(-120, 120);
        spawnPopup(this, x, 300, `+${n}`, false);
      }
    }

    if (this.sim.timeSec >= RUNTIME.roundDurationSec) {
      this.endRound();
      return;
    }

    if (this.nextOffer < this.offers.length && this.sim.timeSec >= this.offers[this.nextOffer].atSec) {
      this.showOffer(this.offers[this.nextOffer]);
    }
  }

  private showOffer(offer: Offer): void {
    // Production, the round timer and boost time all stop while the panel is open.
    this.paused = true;
    this.panel.show(offer.cards, (i) => this.pickCard(i));
  }

  private pickCard(index: number): void {
    if (!this.paused || this.ended) return;
    const offer = this.offers[this.nextOffer];
    const def: MachineDef | undefined = offer?.cards[index];
    if (!def) return;

    this.nextOffer += 1;
    this.panel.hide();
    this.paused = false;

    const beforeRate = this.sim.scoreRate;
    this.sim.addMachine(def.id);
    this.layoutMachines();
    this.refreshSource();

    const afterRate = this.sim.scoreRate;
    if (afterRate >= beforeRate * 1.5) {
      this.shake(1);
      spawnPopup(this, WIDTH / 2, 300, `x${(afterRate / beforeRate).toFixed(1)}`, true);
    }
  }

  private endRound(): void {
    this.ended = true;
    this.panel.hide();
    const score = Math.floor(this.sim.score);
    const previousBest = loadBest();
    const saved = score > previousBest ? saveBest(score) : true;
    const result: RoundResult = { score, previousBest, saved };
    this.scene.start('Result', result);
  }

  // ---------------------------------------------------------------- visuals

  private buildStaticUi(): void {
    this.timerText = this.add
      .text(40, 34, '', { fontFamily: FONT, fontSize: '44px', color: '#e8eef4', fontStyle: 'bold' })
      .setOrigin(0, 0);

    this.scoreText = this.add
      .text(WIDTH / 2, 130, '0', { fontFamily: FONT, fontSize: '112px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5);

    this.rateText = this.add
      .text(WIDTH / 2, 215, '', { fontFamily: FONT, fontSize: '30px', color: '#9fb3c8' })
      .setOrigin(0.5);

    this.lineGfx = this.add.graphics();
    this.lineGfx.lineStyle(6, 0x2b3642, 1);
    this.lineGfx.lineBetween(SOURCE_X, LINE_Y, BIN_X, LINE_Y);

    // Source
    this.boostRing = this.add.circle(SOURCE_X, LINE_Y, 46, 0xffb74d, 0).setStrokeStyle(5, 0xffb74d, 0);
    this.sourceShape = this.add.circle(SOURCE_X, LINE_Y, 36, 0x81c784, 1);
    this.sourceText = this.add
      .text(SOURCE_X, LINE_Y + 62, '', { fontFamily: FONT, fontSize: '24px', color: '#9fb3c8' })
      .setOrigin(0.5);

    // Bin
    this.add.rectangle(BIN_X, LINE_Y, 60, 90, 0x2b3642, 1).setStrokeStyle(4, 0x9fb3c8, 1);
  }

  private buildBallPool(): void {
    for (let i = 0; i < BALANCE.visuals.maxBalls; i++) {
      const shape = this.add.circle(0, 0, 9, 0xe8eef4, 1).setVisible(false).setDepth(10);
      this.balls.push({ shape, nextMachine: 0, active: false });
    }
  }

  private refreshTexts(): void {
    const remaining = Math.max(0, RUNTIME.roundDurationSec - this.sim.timeSec);
    this.timerText.setText(String(Math.ceil(remaining)));
    this.scoreText.setText(Math.floor(this.sim.score).toLocaleString('en-US'));
    this.rateText.setText(`${this.sim.scoreRate.toFixed(1)} /s`);
  }

  private refreshSource(): void {
    this.sourceText.setText(`${this.sim.sourceRate.toFixed(1)}`);
    this.boostRing.setStrokeStyle(5, 0xffb74d, this.sim.boostActive ? 1 : 0);
  }

  private flashBoost(): void {
    this.tweens.add({
      targets: this.sourceShape,
      scale: 1.25,
      duration: 120,
      yoyo: true,
    });
  }

  private shake(strength: number): void {
    if (!RUNTIME.shakeEnabled) return;
    this.cameras.main.shake(BALANCE.shake.durationMs, BALANCE.shake.intensity * strength);
  }

  private layoutMachines(): void {
    for (const n of this.machineNodes) n.destroy();
    this.machineNodes = [];
    this.machineXs = [];

    const line = this.sim.line;
    const n = line.length;
    if (n === 0) return;
    const spacing = Math.min(MAX_SPACING, (LAST_MACHINE_X - FIRST_MACHINE_X) / Math.max(1, n - 1));

    line.forEach((m, i) => {
      const x = FIRST_MACHINE_X + i * spacing;
      this.machineXs.push(x);
      this.machineNodes.push(this.makeMachineNode(m.id, x));
    });
  }

  private makeMachineNode(id: MachineId, x: number): Phaser.GameObjects.Container {
    const def = BALANCE.machineDefs.find((d) => d.id === id)!;
    const c = this.add.container(x, LINE_Y).setDepth(5);
    const g = this.add.graphics();
    drawMachineIcon(g, id, 0, 0, 56, def.color);
    const label = this.add
      .text(0, 52, def.figure, { fontFamily: FONT, fontSize: '20px', color: '#9fb3c8' })
      .setOrigin(0.5);
    c.add([g, label]);
    c.setScale(0.6);
    this.tweens.add({ targets: c, scale: 1, duration: 200, ease: 'Back.Out' });
    return c;
  }

  // Visual balls are cosmetic: capped pool, capped spawn rate. Production is computed in Simulation.
  private updateBalls(dt: number): void {
    const v = BALANCE.visuals;
    this.spawnAcc += Math.min(this.sim.sourceRate, v.maxSpawnPerSec) * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      this.spawnBall(SOURCE_X + 36, LINE_Y + this.fxRng.range(-10, 10), 0, 1);
    }

    const dx = v.ballSpeedPx * dt;
    for (const b of this.balls) {
      if (!b.active) continue;
      b.shape.x += dx;

      while (b.nextMachine < this.machineXs.length && b.shape.x >= this.machineXs[b.nextMachine]) {
        const id = this.sim.line[b.nextMachine].id;
        b.nextMachine += 1;
        if (id === 'splitter') {
          const twin = this.spawnBall(b.shape.x, b.shape.y - 14, b.nextMachine, b.shape.scale);
          if (twin) b.shape.y += 14;
        } else if (id === 'doubler') {
          b.shape.setScale(Math.min(2.2, b.shape.scale * 1.3));
        }
      }

      if (b.shape.x >= BIN_X - 20) {
        b.active = false;
        b.shape.setVisible(false);
      }
    }
  }

  private spawnBall(x: number, y: number, nextMachine: number, scale: number): VisualBall | null {
    const b = this.balls.find((ball) => !ball.active);
    if (!b) return null;
    b.active = true;
    b.nextMachine = nextMachine;
    b.shape.setPosition(x, y).setScale(scale).setVisible(true);
    return b;
  }
}
