import Phaser from 'phaser';
import { BALANCE, type MachineDef, type MachineId } from '../config/balance';
import { generateOffers, type Offer } from '../game/cards';
import { Rng } from '../game/rng';
import { Simulation } from '../game/simulation';
import type { FeverEvent } from '../game/fever';
import { loadBest, loadSoundEnabled, loadSpeed, saveBest, saveSoundEnabled, saveSpeed } from '../game/storage';
import { Sfx, type SfxName } from '../audio/sfx';
import { WIDTH, HEIGHT } from '../main';
import { RUNTIME, randomSeed } from '../runtime';
import { CardPanel } from '../ui/CardPanel';
import { drawMachineIcon, FONT } from '../ui/icons';
import { spawnPopup } from '../ui/Popup';
import { FeverFx } from '../ui/FeverFx';
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
  /** Fever lottery summary, or null when the lottery was off. */
  fever: { hits: number; bonus: number; longestChain: number } | null;
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
  /** True while the TAP screen before the first round is showing. */
  waiting: () => boolean;
  /** Starts the round from the TAP screen (same as tapping it). */
  start: () => void;
  speed: () => number;
  setSpeed: (speed: number) => void;
  /** Times each sound effect was requested this round (played or not). */
  sounds: () => Record<SfxName, number>;
  soundEnabled: () => boolean;
  /** Heat stage reached so far this round (0..3). */
  fever: () => number;
  /** Fever lottery state, or null with ?fever=0. */
  lottery: () => Simulation['fever'];
  /** True while the FEVER cut-in holds the round. */
  cutIn: () => boolean;
}

/** Background colour per heat stage (0 = normal). Deeper and warmer as the stage rises. */
const HEAT_BACKGROUND = [0x101418, 0x121a2e, 0x1e1432, 0x2c1410];
/** Line colour per heat stage. */
const HEAT_LINE = [0x2b3642, 0x2f4a6a, 0x5a3a7a, 0x8a4a2a];
/** "+N" popup colour per heat stage. */
const HEAT_POPUP = ['#c8f7c5', '#9fd8ff', '#e0a8ff', '#ffc27a'];
/** Hold colours in lottery order, for the hold sound. */
const HOLD_ORDER = BALANCE.fever.colors as readonly string[];

/** Offset of the restart button from the top-right corner, clear of the timer and score. */
const RETRY_INSET = 56;
/** Horizontal distance from the restart button to the speed button on its left. */
const SPEED_BUTTON_GAP = 116;
/** Horizontal distance from the speed button to the speaker on its left. */
const SPEAKER_GAP = 96;
/**
 * Speed picked with the button on this page. It wins over ?speed= and the saved speed, so a retry
 * keeps the player's pick even when the URL has ?speed= or storage is unavailable.
 */
let pickedSpeed: number | undefined;
/**
 * The first round of a page load waits for a tap: browsers allow sound only after a user gesture,
 * and the player gets to start when ready. Later rounds (retry, RETRY on the result screen) start
 * at once, as the gesture has already happened.
 */
let needsStartTap = true;

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
  /** Playback speed: sim seconds per wall-clock second. Changes nothing but how fast the round runs. */
  private speed: number = BALANCE.playback.defaultSpeed;
  /** Sim-time played at each speed, for telemetry. */
  private speedSec: Record<string, number> = {};
  private speedText!: Phaser.GameObjects.Text;
  private sfx!: Sfx;
  private speakerGfx!: Phaser.GameObjects.Graphics;
  /** Best score before this round; passing it mid-round triggers the BEST effect once. */
  private previousBest = 0;
  private bestPassed = false;
  /** "/s" readout while it counts up after a pick; null shows the live value. */
  private rateDisplay: { value: number } | null = null;
  /** Heat stage shown on screen; follows sim.heatStage. */
  private heatShown = 0;
  private feverFx: FeverFx | null = null;
  /** True while the FEVER cut-in plays: the round is held like during an offer, without the panel. */
  private cutInActive = false;
  /** sim.feverBonus when the current FEVER chain started, for the tally at its end. */
  private feverBonusAtStart = 0;
  /** Heat stage and, with the lottery, the continue chance it gives; always shown under the timer. */
  private heatText!: Phaser.GameObjects.Text;
  private heatSub!: Phaser.GameObjects.Text;
  /** True while the TAP screen is up: nothing advances until the first tap. */
  private waitingForStart = false;
  private startOverlay: Phaser.GameObjects.Container | null = null;

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
    this.seed = RUNTIME.fixedSeed ?? randomSeed();
    this.sim = new Simulation(RUNTIME.roundDurationSec, { trackHeat: true, feverSeed: RUNTIME.fever ? this.seed : undefined });
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
    this.speed = pickedSpeed ?? RUNTIME.speed ?? loadSpeed() ?? BALANCE.playback.defaultSpeed;
    this.speedSec = {};
    this.previousBest = loadBest();
    this.bestPassed = false;
    this.rateDisplay = null;
    this.heatShown = 0;
    this.cutInActive = false;
    this.cameras.main.setBackgroundColor(HEAT_BACKGROUND[0]);
    // The Sfx object outlives scene restarts so the unlocked audio context is kept; the per-round
    // counters start again.
    this.sfx ??= new Sfx(RUNTIME.sound ?? loadSoundEnabled() ?? BALANCE.sound.enabled);
    this.sfx.resetCounts();
    this.sfx.stopFeverBgm();
    this.feverBonusAtStart = 0;
    // Browsers allow audio only after a user gesture. The capture-phase DOM listeners run before
    // Phaser dispatches the same event to a card or button, so the first tap's sound plays too.
    this.sfx.bindUnlock(this.game.canvas);
    this.fxRng = new Rng((Date.now() & 0xffffffff) >>> 0);
    this.machineNodes = [];
    this.machineXs = [];
    this.balls = [];

    this.buildStaticUi();
    this.buildBallPool();
    this.feverFx = this.sim.fever ? new FeverFx(this) : null;
    this.panel = new CardPanel(this);
    this.buildRetryButton();
    this.buildSpeedButton();
    this.buildSpeakerButton();
    this.waitingForStart = needsStartTap && !RUNTIME.autostart;
    if (this.waitingForStart) this.buildStartOverlay();
    else needsStartTap = false;
    this.layoutMachines();
    this.refreshHeat();
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
      waiting: () => this.waitingForStart,
      start: () => this.startRound(),
      speed: () => this.speed,
      setSpeed: (speed) => this.setSpeed(speed),
      sounds: () => ({ ...this.sfx.counts }),
      soundEnabled: () => this.sfx.enabled,
      fever: () => this.heatShown,
      lottery: () => this.sim.fever,
      cutIn: () => this.cutInActive,
    };
    (window as unknown as { __bf: DebugHook }).__bf = hook;
  }

  update(_time: number, deltaMs: number): void {
    if (this.sim.fever && this.feverFx) this.feverFx.update(this.sim.fever, Math.min(deltaMs / 1000, 0.1));
    if (this.waitingForStart || this.ended || this.paused || this.cutInActive) return;

    // The first delta after create() includes scene construction time; do not count it as play time.
    if (this.skipNextDelta) {
      this.skipNextDelta = false;
      return;
    }

    // Fixed-step simulation, independent of frame rate. The full elapsed time is kept so a slow
    // device does not stretch the round; only the catch-up work per frame is bounded, and any
    // remainder is carried over to the next frame. A single frame longer than MAX_FRAME_SEC is
    // treated as a stall (debugger, OS sleep) rather than play time. The playback speed scales the
    // sim time per frame; the numbers in BALANCE are all in sim time, so the score does not change.
    const dt = Math.min(deltaMs / 1000, MAX_FRAME_SEC);
    this.simAccumulator += dt * this.speed;
    const step = this.sim.stepSec;
    let steps = 0;
    while (this.simAccumulator >= step && steps < MAX_STEPS_PER_FRAME) {
      this.simAccumulator -= step;
      this.runSimStep();
      steps += 1;
      if (this.paused || this.ended || this.cutInActive) break;
    }

    // Visuals are cosmetic: clamp so balls do not teleport after a long frame. They follow sim time,
    // so balls move and spawn faster at a higher speed.
    this.updateBalls(Math.min(dt, 0.1) * this.speed);
    this.refreshTexts();
    this.refreshSource();
    this.refreshMachineStatus();
    this.flushGainPopup();
  }

  // ---------------------------------------------------------------- simulation

  private runSimStep(): void {
    const res = this.sim.step();
    // The simulation keeps the score rate of this step (trackHeat), for the peak and the heat stage.
    const rate = this.sim.rate;
    this.popupGain += res.gained;
    // Popups are paced in wall-clock time so their fixed lifetime still keeps them from stacking.
    this.popupAcc += this.sim.stepSec / this.speed;
    const key = String(this.speed);
    this.speedSec[key] = (this.speedSec[key] ?? 0) + this.sim.stepSec;
    this.peakRate = Math.max(this.peakRate, rate);

    if (res.boostStarted) {
      this.flashBoost();
      this.shake(0.5);
      this.sfx.accel();
    }

    // Compare the floored score, which is what the screen shows and endRound() saves.
    if (!this.bestPassed && this.previousBest > 0 && Math.floor(this.sim.score) > this.previousBest) {
      this.bestPassed = true;
      this.showBestPassed();
    }
    this.checkHeat();
    for (const e of res.fever) this.onFeverEvent(e);

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
    // A hit holds the round for the cut-in; the offer check runs when it is over.
    if (this.cutInActive) return;
    this.checkOffer();
  }

  private checkOffer(): void {
    // Offers keep coming every interval while the round lasts; EXTEND can make later ones reachable.
    const next = this.offers[this.nextOffer];
    if (next && this.sim.timeSec >= next.atSec) this.showOffer(next);
  }

  private showOffer(offer: Offer): void {
    // Production, the round timer and boost time all stop while the panel is open.
    this.paused = true;
    this.offerShownAt = performance.now();
    this.sfx.offer();
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
    // Show what the pick did: the multiplier in the centre while the "/s" readout counts up to
    // the new value. A machine whose effect is deferred (ACCEL changes nothing until it
    // triggers) shows its description instead; time added lives at the timer.
    if (this.sim.remainingSec !== beforeRemaining) {
      this.showTimeGain(this.sim.remainingSec - beforeRemaining);
      this.sfx.extend();
    } else {
      this.sfx.pick(beforeRate > 0 ? afterRate / beforeRate : 1);
      if (afterRate > beforeRate) {
        this.showMultiplier(afterRate / beforeRate, def.color);
        this.countUpRate(beforeRate, afterRate);
      } else {
        spawnPopup(this, WIDTH / 2, 300, def.desc, true);
      }
    }
    if (afterRate >= beforeRate * 1.5) this.shake(1);
    this.sim.noteRate(afterRate);
    this.checkHeat();
  }

  /** Sound and one-off effects for lottery events. The reel and holds redraw themselves every frame. */
  private onFeverEvent(e: FeverEvent): void {
    const lottery = this.sim.fever;
    if (!lottery || !this.feverFx) return;
    // The end of a FEVER run is revealed after the continue draw (continueDraw).
    if (e.type === 'feverContinue' || e.type === 'feverEnd') {
      this.continueDraw(e);
      return;
    }
    this.feverFx.handle(e, lottery);
    switch (e.type) {
      case 'hold':
        this.sfx.hold(HOLD_ORDER.indexOf(e.color));
        break;
      case 'leftStop':
        this.sfx.reelStop();
        break;
      case 'rightStop':
        this.sfx.reelStop();
        if (e.reach && lottery.draw) this.sfx.reach((lottery.draw.duration - lottery.draw.elapsed) / this.speed);
        break;
      case 'result':
        if (!e.hit) this.sfx.miss();
        else this.sfx.reelStop();
        break;
      case 'feverStart':
        this.sfx.feverHit();
        this.cutInActive = true;
        this.feverBonusAtStart = this.sim.feverBonus;
        this.feverFx.cutIn(
          (s) => this.shake(s),
          () => {
            if (this.ended) return;
            this.cutInActive = false;
            this.sfx.startFeverBgm(1);
            // The frame that ends the cut-in must not count the hold as play time.
            this.skipNextDelta = true;
            this.checkOffer();
          },
        );
        break;
      default:
        break;
    }
  }

  /**
   * FEVER ran out: hold the round for the continue draw, then reveal the result the lottery already
   * drew. At the chain cap there is no draw.
   */
  private continueDraw(e: Extract<FeverEvent, { type: 'feverContinue' | 'feverEnd' }>): void {
    const lottery = this.sim.fever;
    const fx = this.feverFx;
    if (!lottery || !fx) return;
    const reveal = (): void => {
      fx.handle(e, lottery);
      if (e.type === 'feverContinue') {
        this.sfx.feverContinue(e.chain);
        this.sfx.startFeverBgm(e.chain);
        this.shake(1.5 + 0.5 * Math.min(3, e.chain - 1));
      } else {
        this.sfx.stopFeverBgm();
        this.sfx.feverEnd();
        fx.showEnd(this.sim.feverBonus - this.feverBonusAtStart);
      }
    };
    if (e.type === 'feverEnd' && e.capped) {
      reveal();
      return;
    }
    const table = BALANCE.fever.continueByHeat;
    const chance = table[Math.min(table.length - 1, this.sim.heatStage)];
    this.cutInActive = true;
    this.sfx.drumroll(BALANCE.fever.continueDrawMs / 1000);
    fx.continueDraw(chance, e.type === 'feverContinue', e.type === 'feverContinue' ? e.chain - 1 : e.chain, () => {
      if (this.ended) return;
      this.cutInActive = false;
      // The frame that ends the draw must not count the hold as play time.
      this.skipNextDelta = true;
      reveal();
      this.checkOffer();
    });
  }

  /** Shows the heat stage the simulation reached (it never drops within a round). */
  private checkHeat(): void {
    const stage = this.sim.heatStage;
    if (stage === this.heatShown) return;
    this.heatShown = stage;
    this.sfx.heat(stage);
    // Background and line shift to the stage colour; a short flash marks the moment.
    const from = Phaser.Display.Color.IntegerToColor(this.cameras.main.backgroundColor.color);
    const to = Phaser.Display.Color.IntegerToColor(HEAT_BACKGROUND[stage]);
    const mix = { t: 0 };
    this.tweens.add({
      targets: mix,
      t: 1,
      duration: 600,
      onUpdate: () => {
        const c = Phaser.Display.Color.Interpolate.ColorWithColor(from, to, 1, mix.t);
        this.cameras.main.setBackgroundColor(Phaser.Display.Color.GetColor(c.r, c.g, c.b));
      },
    });
    this.lineGfx.clear();
    this.lineGfx.lineStyle(6, HEAT_LINE[stage], 1);
    this.lineGfx.lineBetween(SOURCE_X, LINE_Y, BIN_X, LINE_Y);
    const flash = this.add.rectangle(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, HEAT_LINE[stage], 0.35).setDepth(40);
    this.tweens.add({ targets: flash, alpha: 0, duration: 500, onComplete: () => flash.destroy() });
    this.refreshHeat();
    this.heatText.setScale(1.6);
    this.tweens.add({ targets: this.heatText, scale: 1, duration: 300, ease: 'Back.Out' });
    this.shake(1);
  }

  /** "HEAT n" and the continue chance it gives, under the timer. */
  private refreshHeat(): void {
    const stage = this.heatShown;
    this.heatText.setText(`HEAT ${stage}`).setColor(HEAT_POPUP[stage]);
    const table = BALANCE.fever.continueByHeat;
    this.heatSub.setText(this.sim.fever ? `CONTINUE ${Math.round(table[Math.min(table.length - 1, stage)] * 100)}%` : '');
  }

  /** Big "x3" in the card colour: punches in, then rises and fades. */
  private showMultiplier(ratio: number, color: number): void {
    const label = `x${Number.isInteger(ratio) ? ratio : ratio.toFixed(1)}`;
    const t = this.add
      .text(WIDTH / 2, 300, label, {
        fontFamily: FONT,
        fontSize: '96px',
        color: Phaser.Display.Color.IntegerToColor(color).rgba,
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(50)
      .setScale(0.4);
    this.tweens.add({ targets: t, scale: 1, duration: 180, ease: 'Back.Out' });
    this.tweens.add({
      targets: t,
      y: 240,
      alpha: 0,
      delay: 250,
      duration: BALANCE.feedback.multiplierPopupMs - 250,
      ease: 'Cubic.In',
      onComplete: () => t.destroy(),
    });
  }

  /** The "/s" readout rolls from the old to the new value instead of jumping. */
  private countUpRate(from: number, to: number): void {
    const display = { value: from };
    this.rateDisplay = display;
    this.rateText.setColor('#ffd54f');
    this.tweens.add({
      targets: display,
      value: to,
      duration: BALANCE.feedback.rateCountUpMs,
      ease: 'Cubic.Out',
      onComplete: () => {
        if (this.rateDisplay === display) this.rateDisplay = null;
        this.rateText.setColor('#9fb3c8');
      },
    });
  }

  /** Score just passed the previous best: "BEST" beside the score, score flashes, arpeggio. */
  private showBestPassed(): void {
    this.sfx.best();
    const t = this.add
      .text(WIDTH / 2 + 200, 110, 'BEST', { fontFamily: FONT, fontSize: '40px', color: '#ffd54f', fontStyle: 'bold' })
      .setOrigin(0, 0.5)
      .setDepth(50)
      .setScale(0.4);
    this.tweens.add({ targets: t, scale: 1, duration: 200, ease: 'Back.Out' });
    this.tweens.add({ targets: t, alpha: 0, delay: 1400, duration: 600, onComplete: () => t.destroy() });
    this.scoreText.setColor('#ffd54f');
    this.tweens.add({
      targets: this.scoreText,
      scale: 1.15,
      duration: 160,
      yoyo: true,
      ease: 'Quad.Out',
      onComplete: () => this.scoreText.setColor('#ffffff'),
    });
  }

  private endRound(): void {
    this.ended = true;
    this.sfx.stopFeverBgm();
    this.panel.hide();
    this.pendingGainPopup = 0;
    const score = Math.floor(this.sim.score);
    const previousBest = loadBest();
    // Same condition as the NEW BEST label on the result screen, so a first-ever best gets the fanfare too.
    if (score > previousBest) this.sfx.fanfare();
    else this.sfx.end();
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
      fever: this.sim.fever
        ? { hits: this.sim.fever.hits, bonus: Math.floor(this.sim.feverBonus), longestChain: this.sim.fever.longestChain }
        : null,
    };
    // Fire-and-forget: the record is stored locally and posted when an endpoint is configured.
    recordRound(this.roundRecord(false));
    this.scene.start('Result', result);
  }

  /** One tap restarts with a new seed at any time, also while an offer is open. The part played is logged. */
  private retry(): void {
    if (this.ended) return;
    this.ended = true;
    this.sfx.stopFeverBgm();
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
      speed: this.speed,
      speedSec: Object.fromEntries(Object.entries(this.speedSec).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      muted: !this.sfx.enabled,
      fever: this.heatShown,
      lottery: this.sim.fever
        ? {
            draws: this.sim.fever.draws,
            hits: this.sim.fever.hits,
            reaches: this.sim.fever.reaches,
            feverSec: Math.round(this.sim.fever.feverSec * 100) / 100,
            longestChain: this.sim.fever.longestChain,
            lostHolds: this.sim.fever.lostHolds,
            bonus: Math.floor(this.sim.feverBonus),
          }
        : null,
    };
  }

  // ---------------------------------------------------------------- visuals

  private buildStaticUi(): void {
    this.timerText = this.add
      .text(40, 34, '', { fontFamily: FONT, fontSize: '44px', color: '#e8eef4', fontStyle: 'bold' })
      .setOrigin(0, 0);

    // Under the timer, clear of the multiplier popup at the centre and of the lottery reel at the bottom.
    this.heatText = this.add
      .text(40, 104, '', { fontFamily: FONT, fontSize: '30px', color: HEAT_POPUP[0], fontStyle: 'bold' })
      .setOrigin(0, 0);
    this.heatSub = this.add.text(40, 140, '', { fontFamily: FONT, fontSize: '20px', color: '#9fb3c8' }).setOrigin(0, 0);

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

  /** Full-screen TAP prompt above every button; the first tap unlocks audio and starts the round. */
  private buildStartOverlay(): void {
    const c = this.add.container(0, 0).setDepth(300);
    const dim = this.add.rectangle(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, 0x000000, 0.55).setInteractive();
    const label = this.add
      .text(WIDTH / 2, HEIGHT / 2, 'TAP', { fontFamily: FONT, fontSize: '96px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0.5);
    this.tweens.add({ targets: label, scale: 1.08, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
    dim.on('pointerdown', () => this.startRound());
    c.add([dim, label]);
    this.startOverlay = c;
  }

  private startRound(): void {
    if (!this.waitingForStart) return;
    this.waitingForStart = false;
    needsStartTap = false;
    this.startOverlay?.destroy();
    this.startOverlay = null;
    // The frame after the tap carries the wait; play time starts from the next one.
    this.skipNextDelta = true;
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

  /** "1x" left of the restart button; each tap moves to the next offered speed. Usable during an offer. */
  private buildSpeedButton(): void {
    const c = this.add.container(WIDTH - RETRY_INSET - SPEED_BUTTON_GAP, RETRY_INSET).setDepth(200);
    const bg = this.add.rectangle(0, 0, 104, 52, 0x1c232b, 1).setStrokeStyle(3, 0x9fb3c8, 1);
    this.speedText = this.add
      .text(0, 0, '', { fontFamily: FONT, fontSize: '26px', color: '#e8eef4', fontStyle: 'bold' })
      .setOrigin(0.5);
    const hit = this.add.zone(0, 0, 112, 72).setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => {
      const speeds = BALANCE.playback.speeds as readonly number[];
      this.setSpeed(speeds[(speeds.indexOf(this.speed) + 1) % speeds.length]);
    });
    c.add([bg, this.speedText, hit]);
    this.refreshSpeedButton();
  }

  private setSpeed(speed: number): void {
    if (!(BALANCE.playback.speeds as readonly number[]).includes(speed)) return;
    this.speed = speed;
    pickedSpeed = speed;
    saveSpeed(speed);
    this.refreshSpeedButton();
  }

  private refreshSpeedButton(): void {
    this.speedText.setText(`${this.speed}x`);
    // Anything but normal speed is shown in the boost colour so a sped-up round is obvious.
    this.speedText.setColor(this.speed === 1 ? '#e8eef4' : '#ffb74d');
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
    const rate = this.rateDisplay ? this.rateDisplay.value : this.sim.scoreRate;
    this.rateText.setText(`${rate.toFixed(1)} /s`);
  }

  /** Speaker left of the speed button in the top-right row; a tap toggles all sound. */
  private buildSpeakerButton(): void {
    const c = this.add.container(WIDTH - RETRY_INSET - SPEED_BUTTON_GAP - SPEAKER_GAP, RETRY_INSET).setDepth(200);
    c.add(this.add.circle(0, 0, 26, 0x1c232b, 1).setStrokeStyle(3, 0x9fb3c8, 1));
    this.speakerGfx = this.add.graphics();
    const hit = this.add.zone(0, 0, 72, 72).setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => {
      this.sfx.setEnabled(!this.sfx.enabled);
      saveSoundEnabled(this.sfx.enabled);
      this.drawSpeaker();
    });
    c.add([this.speakerGfx, hit]);
    this.drawSpeaker();
  }

  private drawSpeaker(): void {
    const g = this.speakerGfx;
    const on = this.sfx.enabled;
    const color = on ? 0x9fb3c8 : 0x5f6f80;
    g.clear();
    g.fillStyle(color, 1);
    g.fillRect(-14, -6, 8, 12);
    g.fillTriangle(-6, -8, 6, -16, 6, 16);
    g.fillTriangle(-6, -8, 6, 16, -6, 8);
    g.lineStyle(3, color, 1);
    if (on) {
      g.beginPath();
      g.arc(6, 0, 10, Phaser.Math.DegToRad(-40), Phaser.Math.DegToRad(40), false);
      g.strokePath();
      g.beginPath();
      g.arc(6, 0, 16, Phaser.Math.DegToRad(-40), Phaser.Math.DegToRad(40), false);
      g.strokePath();
    } else {
      g.lineStyle(3, 0xef5350, 1);
      g.lineBetween(-16, -16, 20, 16);
    }
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
    // After the round ends only the ending cue plays; a popup that fell on the last step is dropped.
    // While an offer is open only its cue plays; a popup that fell on the same step waits for the pick.
    if (this.pendingGainPopup <= 0 || this.ended || this.paused || this.cutInActive) return;
    const fever = this.sim.fever?.feverActive === true;
    spawnPopup(this, WIDTH / 2 + 230, 215, `+${this.pendingGainPopup}`, false, fever ? '#ffe81a' : HEAT_POPUP[this.heatShown]);
    this.sfx.gain(this.pendingGainPopup, this.heatShown + (fever ? 2 : 0));
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
