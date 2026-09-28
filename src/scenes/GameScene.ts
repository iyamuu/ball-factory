import Phaser from 'phaser';
import { BALANCE, type MachineDef, type MachineId } from '../config/balance';
import { generateOffers, type Offer } from '../game/cards';
import { Rng } from '../game/rng';
import { Simulation } from '../game/simulation';
import { loadBest, saveBest } from '../game/storage';
import { WIDTH } from '../main';
import { RUNTIME, randomSeed } from '../runtime';
import { CardPanel } from '../ui/CardPanel';
import { drawMachineIcon, FONT } from '../ui/icons';
import { spawnPopup } from '../ui/Popup';
import { playerId, recordRound, screenInfo, type OfferRecord, type RoundRecord } from '../telemetry';
import { TELEMETRY } from '../config/telemetry';

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

const BALL_COLOR = 0xe8eef4;
/** Fill colour by number of times a ball has been pressed (index 0 = never). Deeper each time. */
const PRESSED_COLORS = [BALL_COLOR, 0xce93d8, 0xab47bc, 0x8e24aa, 0x6a1b9a];
/** Outline width by number of times pressed; grows so a second press is visible on an already purple ball. */
const PRESSED_STROKE = [0, 2, 4, 6, 8];

interface VisualBall {
  shape: Phaser.GameObjects.Arc;
  /** Index of the next line machine this ball has not passed yet. */
  nextMachine: number;
  /** How many visual splits this ball's lineage has gone through since the source. */
  splits: number;
  /** How many presses have processed this ball (drives colour and outline). */
  pressed: number;
  active: boolean;
}

interface MachineNode {
  container: Phaser.GameObjects.Container;
  /** Live status text under the icon (accelerator progress, press share). */
  status: Phaser.GameObjects.Text | null;
}

export interface RoundResult {
  score: number;
  previousBest: number;
  saved: boolean;
  /** Line machines in placement order. */
  line: MachineId[];
  speedCount: number;
  extendCount: number;
  /** Highest score rate reached during the round. */
  peakRate: number;
  /** Offer seed of this round (for logs and ?seed= comparison runs). */
  seed: number;
  /** Every offer of the round with the pick and how long it took. */
  offers: OfferRecord[];
  /** Round length including EXTEND. */
  roundLengthSec: number;
}

/** Testing hook exposed on window.__bf. */
interface DebugHook {
  sim: Simulation;
  isPaused: () => boolean;
  offersShown: () => number;
  pick: (index: number) => void;
  visibleBalls: () => number;
  ballXs: () => number[];
  remainingSec: () => number;
  offers: () => MachineId[][];
  seed: () => number;
  retry: () => void;
}

/** Offset of the restart button from the top-right corner, clear of the timer and score. */
const RETRY_INSET = 56;

export class GameScene extends Phaser.Scene {
  private sim!: Simulation;
  private offers: Offer[] = [];
  private nextOffer = 0;
  private paused = false;
  private ended = false;
  private simAccumulator = 0;
  private skipNextDelta = true;
  private fxRng!: Rng;
  private peakRate = 0;
  private seed = 0;
  private offerLog: OfferRecord[] = [];
  /** Wall-clock time (performance.now) at which the open offer appeared. */
  private offerShownAt = 0;

  private timerText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private rateText!: Phaser.GameObjects.Text;
  private sourceText!: Phaser.GameObjects.Text;
  private boostText!: Phaser.GameObjects.Text;
  private sourceShape!: Phaser.GameObjects.Arc;
  private boostRing!: Phaser.GameObjects.Arc;
  private machineNodes: MachineNode[] = [];
  private machineXs: number[] = [];
  private lineGfx!: Phaser.GameObjects.Graphics;
  private panel!: CardPanel;

  private balls: VisualBall[] = [];
  private spawnAcc = 0;
  private popupAcc = 0;
  private popupGain = 0;
  private pendingGainPopup = 0;

  constructor() {
    super('Game');
  }

  create(): void {
    this.sim = new Simulation(RUNTIME.roundDurationSec);
    this.seed = RUNTIME.fixedSeed ?? randomSeed();
    const extend = BALANCE.machines.extend;
    const longestRoundSec = RUNTIME.roundDurationSec + extend.maxPerRound * extend.seconds;
    this.offers = generateOffers(this.seed, longestRoundSec);
    this.nextOffer = 0;
    this.paused = false;
    this.ended = false;
    this.simAccumulator = 0;
    this.skipNextDelta = true;
    this.spawnAcc = 0;
    this.popupAcc = 0;
    this.popupGain = 0;
    this.pendingGainPopup = 0;
    this.peakRate = 0;
    this.offerLog = [];
    this.fxRng = new Rng((Date.now() & 0xffffffff) >>> 0);
    this.machineNodes = [];
    this.machineXs = [];
    this.balls = [];

    this.buildStaticUi();
    this.buildBallPool();
    this.panel = new CardPanel(this);
    this.buildRetryButton();
    this.layoutMachines();
    this.refreshTexts();
    this.refreshSource();

    const hook: DebugHook = {
      sim: this.sim,
      isPaused: () => this.paused,
      offersShown: () => this.nextOffer,
      pick: (i) => this.pickCard(i),
      visibleBalls: () => this.activeBallCount,
      ballXs: () => this.balls.filter((b) => b.active).map((b) => b.shape.x),
      remainingSec: () => this.sim.remainingSec,
      offers: () => this.offers.map((o) => o.cards.map((c) => c.id)),
      seed: () => this.seed,
      retry: () => this.retry(),
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
    const step = this.sim.stepSec;
    let steps = 0;
    while (this.simAccumulator >= step && steps < MAX_STEPS_PER_FRAME) {
      this.simAccumulator -= step;
      this.runSimStep();
      steps += 1;
      if (this.paused || this.ended) break;
    }

    // Visuals are cosmetic: clamp so balls do not teleport after a long frame.
    this.updateBalls(Math.min(dt, 0.1));
    this.refreshTexts();
    this.refreshSource();
    this.refreshMachineStatus();
    this.flushGainPopup();
  }

  // ---------------------------------------------------------------- simulation

  private runSimStep(): void {
    const res = this.sim.step();
    this.popupGain += res.gained;
    this.popupAcc += this.sim.stepSec;
    this.peakRate = Math.max(this.peakRate, this.sim.scoreRate);

    if (res.boostStarted) {
      this.flashBoost();
      this.shake(0.5);
    }

    if (this.popupAcc >= BALANCE.visuals.popupIntervalSec) {
      this.popupAcc = 0;
      const n = Math.floor(this.popupGain);
      this.popupGain -= n;
      // Collected here and shown once per frame, so several steps in one frame make one popup.
      this.pendingGainPopup += n;
    }

    if (this.sim.ended) {
      this.endRound();
      return;
    }

    // Offers keep coming every interval while the round lasts; EXTEND can make later ones reachable.
    const next = this.offers[this.nextOffer];
    if (next && this.sim.timeSec >= next.atSec) this.showOffer(next);
  }

  private showOffer(offer: Offer): void {
    // Production, the round timer and boost time all stop while the panel is open.
    this.paused = true;
    this.offerShownAt = performance.now();
    const disabled = offer.cards.map((c) => !this.sim.canPick(c.id));
    this.panel.show(offer.cards, (i) => this.pickCard(i), disabled);
  }

  private pickCard(index: number): void {
    if (!this.paused || this.ended) return;
    const offer = this.offers[this.nextOffer];
    const def: MachineDef | undefined = offer?.cards[index];
    if (!def || !this.sim.canPick(def.id)) return; // missing or greyed-out card

    this.offerLog.push({
      index: this.nextOffer,
      atSec: offer.atSec,
      cards: offer.cards.map((c) => c.id),
      pick: def.id,
      decisionSec: Math.round(performance.now() - this.offerShownAt) / 1000,
    });
    this.nextOffer += 1;
    this.panel.hide();
    this.paused = false;

    const beforeRate = this.sim.scoreRate;
    const beforeRemaining = this.sim.remainingSec;
    if (!this.sim.addMachine(def.id)) return;
    if (def.onLine) this.layoutMachines(); // SPEED and EXTEND do not change the line
    this.refreshSource();

    const afterRate = this.sim.scoreRate;
    this.peakRate = Math.max(this.peakRate, afterRate);
    // Show what the pick did to the rate, e.g. "12.0 -> 24.0 /s". A machine whose effect is
    // deferred (ACCEL changes nothing until it triggers) shows its description instead.
    if (this.sim.remainingSec !== beforeRemaining) {
      // Time was added: the effect lives at the timer, not in the centre.
      this.showTimeGain(this.sim.remainingSec - beforeRemaining);
    } else {
      const message =
        afterRate !== beforeRate ? `${beforeRate.toFixed(1)} → ${afterRate.toFixed(1)} /s` : def.desc;
      spawnPopup(this, WIDTH / 2, 300, message, true);
    }
    if (afterRate >= beforeRate * 1.5) this.shake(1);
  }

  private endRound(): void {
    this.ended = true;
    this.panel.hide();
    const score = Math.floor(this.sim.score);
    const previousBest = loadBest();
    const saved = score > previousBest ? saveBest(score) : true;
    const result: RoundResult = {
      score,
      previousBest,
      saved,
      line: this.sim.line.map((m) => m.id),
      speedCount: this.sim.speedCount,
      extendCount: this.sim.extendCount,
      peakRate: this.peakRate,
      seed: this.seed,
      offers: this.offerLog,
      roundLengthSec: this.sim.durationSec + this.sim.bonusTimeSec,
    };
    // Fire-and-forget: the record is stored locally and posted when an endpoint is configured.
    recordRound(this.roundRecord(false));
    this.scene.start('Result', result);
  }

  /** One tap restarts with a new seed at any time, also while an offer is open. The part played is logged. */
  private retry(): void {
    if (this.ended) return;
    this.ended = true;
    this.panel.hide();
    recordRound(this.roundRecord(true));
    this.scene.restart();
  }

  private roundRecord(abandoned: boolean): RoundRecord {
    return {
      v: TELEMETRY.version,
      build: TELEMETRY.build,
      player: playerId(),
      time: new Date().toISOString(),
      seed: this.seed,
      durationSec: this.sim.durationSec,
      roundLengthSec: this.sim.durationSec + this.sim.bonusTimeSec,
      abandoned,
      playedSec: Math.round(this.sim.timeSec * 100) / 100,
      score: Math.floor(this.sim.score),
      peakRate: Math.round(this.peakRate * 10) / 10,
      line: this.sim.line.map((m) => m.id),
      speedCount: this.sim.speedCount,
      extendCount: this.sim.extendCount,
      offers: this.offerLog,
      screen: screenInfo(),
    };
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

    // Source: rate under it, boost time left above it while boosted.
    this.boostRing = this.add.circle(SOURCE_X, LINE_Y, 46, 0xffb74d, 0).setStrokeStyle(5, 0xffb74d, 0);
    this.sourceShape = this.add.circle(SOURCE_X, LINE_Y, 36, 0x81c784, 1);
    this.sourceText = this.add
      .text(SOURCE_X, LINE_Y + 62, '', { fontFamily: FONT, fontSize: '24px', color: '#9fb3c8' })
      .setOrigin(0.5);
    this.boostText = this.add
      .text(SOURCE_X, LINE_Y - 66, '', { fontFamily: FONT, fontSize: '22px', color: '#ffb74d', fontStyle: 'bold' })
      .setOrigin(0.5);

    // Bin
    this.add.rectangle(BIN_X, LINE_Y, 60, 90, 0x2b3642, 1).setStrokeStyle(4, 0x9fb3c8, 1);
  }

  /** Circular arrow in the top-right corner, above the card panel so it works during an offer. */
  private buildRetryButton(): void {
    // WIDTH comes from main.ts, which imports this scene: read it here, not at module load.
    const c = this.add.container(WIDTH - RETRY_INSET, RETRY_INSET).setDepth(200);
    const bg = this.add.circle(0, 0, 26, 0x1c232b, 1).setStrokeStyle(3, 0x9fb3c8, 1);
    const g = this.add.graphics();
    g.lineStyle(4, 0xe8eef4, 1);
    g.beginPath();
    g.arc(0, 0, 12, Phaser.Math.DegToRad(-60), Phaser.Math.DegToRad(230), false);
    g.strokePath();
    // Arrow head at the start of the arc (top right).
    g.fillStyle(0xe8eef4, 1);
    g.fillTriangle(4, -16, 14, -8, 3, -3);
    // Larger hit area than the drawing so a thumb finds it.
    const hit = this.add.zone(0, 0, 72, 72).setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => this.retry());
    c.add([bg, g, hit]);
  }

  private buildBallPool(): void {
    for (let i = 0; i < BALANCE.visuals.maxBalls; i++) {
      const shape = this.add.circle(0, 0, 9, BALL_COLOR, 1).setVisible(false).setDepth(10);
      this.balls.push({ shape, nextMachine: 0, splits: 0, pressed: 0, active: false });
    }
  }

  private refreshTexts(): void {
    this.timerText.setText(String(Math.ceil(this.sim.remainingSec)));
    this.scoreText.setText(Math.floor(this.sim.score).toLocaleString('en-US'));
    this.rateText.setText(`${this.sim.scoreRate.toFixed(1)} /s`);
  }

  private refreshSource(): void {
    this.sourceText.setText(`${this.sim.sourceRate.toFixed(1)} /s`);
    const active = this.sim.boostActive;
    this.boostRing.setStrokeStyle(5, 0xffb74d, active ? 1 : 0);
    this.boostText.setText(active ? `${this.sim.boostRemainingSec.toFixed(1)}s` : '');
  }

  /** Accelerator: balls counted toward the next trigger. Press: share of balls processed. */
  private refreshMachineStatus(): void {
    const accel = BALANCE.machines.accelerator;
    this.sim.line.forEach((m, i) => {
      const status = this.machineNodes[i]?.status;
      if (!status) return;
      if (m.id === 'accelerator') {
        status.setText(`${Math.floor(m.accum)}/${accel.ballsPerTrigger}`);
        // While the boost runs the count is on hold (unless configured to keep counting): show it in
        // the boost colour, the same as the ring around the source.
        const held = this.sim.boostActive && !accel.countWhileBoosted;
        status.setColor(held ? '#ffb74d' : '#9fb3c8');
      } else if (m.id === 'press') {
        status.setText(`${Math.round(m.processed * 100)}%`);
        status.setColor(m.processed >= 0.999 ? '#9fb3c8' : '#ffb74d');
      }
    });
  }

  /** One fixed lane to the right of the rate text; lifetime matches the interval so popups do not stack. */
  private flushGainPopup(): void {
    if (this.pendingGainPopup <= 0) return;
    spawnPopup(this, WIDTH / 2 + 230, 215, `+${this.pendingGainPopup}`, false);
    this.pendingGainPopup = 0;
  }

  /** "+5" floats up beside the timer while the timer punches and flashes yellow. */
  private showTimeGain(seconds: number): void {
    this.refreshTexts();
    // Place it clear of the timer at its punched (1.35x) width so the two never overlap.
    const x = this.timerText.x + this.timerText.width * 1.35 + 14;
    const t = this.add
      .text(x, this.timerText.y + 4, `+${Math.round(seconds)}`, {
        fontFamily: FONT,
        fontSize: '40px',
        color: '#fff176',
        fontStyle: 'bold',
      })
      .setOrigin(0, 0)
      .setDepth(50);
    this.tweens.add({ targets: t, y: t.y - 40, alpha: 0, duration: 900, ease: 'Cubic.Out', onComplete: () => t.destroy() });

    this.timerText.setColor('#fff176');
    this.tweens.add({
      targets: this.timerText,
      scale: 1.35,
      duration: 140,
      yoyo: true,
      ease: 'Quad.Out',
      onComplete: () => this.timerText.setColor('#e8eef4'),
    });
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
    for (const n of this.machineNodes) n.container.destroy();
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
    this.refreshMachineStatus();
  }

  private makeMachineNode(id: MachineId, x: number): MachineNode {
    const def = BALANCE.machineDefs.find((d) => d.id === id)!;
    const c = this.add.container(x, LINE_Y).setDepth(5);
    const g = this.add.graphics();
    drawMachineIcon(g, id, 0, 0, 56, def.color);
    const label = this.add
      .text(0, 52, def.figure, { fontFamily: FONT, fontSize: '20px', color: '#9fb3c8' })
      .setOrigin(0.5);
    c.add([g, label]);

    let status: Phaser.GameObjects.Text | null = null;
    if (id === 'accelerator' || id === 'press') {
      status = this.add.text(0, 76, '', { fontFamily: FONT, fontSize: '18px', color: '#9fb3c8' }).setOrigin(0.5);
      c.add(status);
    }

    c.setScale(0.6);
    this.tweens.add({ targets: c, scale: 1, duration: 200, ease: 'Back.Out' });
    return { container: c, status };
  }

  // Visual balls are cosmetic. Production is computed in Simulation; the shapes only show its
  // structure: a capped stream from the source, more balls after each splitter, and the share
  // of balls a press processes (purple with an outline) versus lets through (white).
  private updateBalls(dt: number): void {
    const v = BALANCE.visuals;
    this.spawnAcc += Math.min(this.sim.sourceRate, v.maxSpawnPerSec) * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      this.spawnBall(SOURCE_X + 36, LINE_Y + this.fxRng.range(-10, 10), 0, true);
    }

    const dx = v.ballSpeedPx * dt;
    for (const b of this.balls) {
      if (!b.active) continue;
      b.shape.x += dx;

      while (b.nextMachine < this.machineXs.length && b.shape.x >= this.machineXs[b.nextMachine]) {
        const machine = this.sim.line[b.nextMachine];
        b.nextMachine += 1;
        if (machine.id === 'splitter' && b.splits < v.maxVisualSplits) {
          // Every ball of a lineage doubles at each of the first maxVisualSplits splitters it meets,
          // so one source ball becomes exactly 2^maxVisualSplits shapes and never more.
          b.splits += 1;
          const y = LINE_Y + this.fxRng.range(-v.laneHalfWidthPx, v.laneHalfWidthPx);
          const twin = this.spawnBall(b.shape.x, y, b.nextMachine, false);
          if (twin) {
            twin.splits = b.splits;
            twin.pressed = b.pressed;
            this.applyPressedStyle(twin);
          }
        } else if (machine.id === 'press' && this.fxRng.next() < machine.processed) {
          // The processed share of balls gets a deeper colour and a thicker outline each time,
          // so a second press on an already processed ball is visible.
          b.pressed += 1;
          this.applyPressedStyle(b);
        }
      }

      if (b.shape.x >= BIN_X - 20) {
        b.active = false;
        b.shape.setVisible(false);
      }
    }
  }

  /** Takes a shape from the pool. Copies made by splitters leave `sourceReserve` shapes for the source. */
  private spawnBall(x: number, y: number, nextMachine: number, fromSource: boolean): VisualBall | null {
    const v = BALANCE.visuals;
    if (!fromSource && this.activeBallCount >= v.maxBalls - v.sourceReserve) return null;
    const b = this.balls.find((ball) => !ball.active);
    if (!b) return null;
    b.active = true;
    b.nextMachine = nextMachine;
    b.splits = 0;
    b.pressed = 0;
    b.shape.setPosition(x, y).setVisible(true);
    this.applyPressedStyle(b);
    return b;
  }

  private applyPressedStyle(b: VisualBall): void {
    const level = Math.min(b.pressed, PRESSED_COLORS.length - 1);
    b.shape.setFillStyle(PRESSED_COLORS[level], 1);
    if (level === 0) b.shape.setStrokeStyle(); // no arguments: stroke off (a width of 0 would keep isStroked true)
    else b.shape.setStrokeStyle(PRESSED_STROKE[level], BALL_COLOR, 1);
  }

  private get activeBallCount(): number {
    let n = 0;
    for (const b of this.balls) if (b.active) n++;
    return n;
  }
}
