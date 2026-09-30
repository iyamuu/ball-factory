import Phaser from 'phaser';
import { BALANCE } from '../config/balance';
import type { FeverEvent, FeverLottery, HoldColor } from '../game/fever';
import { WIDTH, HEIGHT } from '../main';
import { FONT } from './icons';

/** Hold and reel frame colour per hold colour. */
export const HOLD_COLORS: Record<HoldColor, number> = {
  white: 0xe8eef4,
  blue: 0x4fc3f7,
  green: 0x81c784,
  red: 0xef5350,
  gold: 0xffd54f,
};

const REEL_Y = 632;
const DIGIT_W = 76;
const DIGIT_H = 96;
const DIGIT_GAP = 12;
const HOLD_R = 14;
/** Distance from the left edge of the reel to the nearest hold; holds sit left of the reel. */
const HOLD_INSET = 48;
const HOLD_GAP = 40;
/** Rainbow stops, left to right. Rainbow is reserved for a certain win (gold hold, FEVER). */
const RAINBOW = ['#ff3b3b', '#ff9f1a', '#ffe81a', '#3bff5a', '#1ad1ff', '#5a5aff', '#d21aff'];

/**
 * Big extruded rainbow text: a stack of dark-gold copies offset down-right for depth, a thick dark
 * outline and a flowing rainbow face with a white glow. Call `tick()` every frame to move the rainbow.
 */
export class RainbowText extends Phaser.GameObjects.Container {
  private face: Phaser.GameObjects.Text;
  private phase = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, text: string, sizePx: number) {
    super(scene, x, y);
    scene.add.existing(this);
    const style = {
      fontFamily: FONT,
      fontSize: `${sizePx}px`,
      fontStyle: 'italic bold',
      align: 'center',
    };
    // The canvas is sized for upright glyphs: pad it for the italic slant, the outline and the glow.
    const padX = Math.round(sizePx * 0.3);
    const padY = Math.round(sizePx * 0.2);
    const layers = Math.max(4, Math.round(sizePx / 18));
    const step = Math.max(1.5, sizePx / 70);
    // Back to front: the deepest layer is the darkest, so the block reads as lit from the top left.
    for (let i = layers; i >= 1; i--) {
      const shade = Phaser.Display.Color.Interpolate.ColorWithColor(
        Phaser.Display.Color.ValueToColor(0x6b3d00),
        Phaser.Display.Color.ValueToColor(0xffc233),
        layers,
        layers - i,
      );
      const layer = scene.add
        .text(i * step, i * step, text, { ...style, color: Phaser.Display.Color.RGBToString(shade.r, shade.g, shade.b) })
        .setOrigin(0.5)
        .setPadding(padX, padY, padX, padY)
        .setStroke('#2a1400', sizePx / 9);
      this.add(layer);
    }
    this.face = scene.add
      .text(0, 0, text, { ...style, color: '#ffffff' })
      .setOrigin(0.5)
      .setPadding(padX, padY, padX, padY)
      .setStroke('#2a1400', sizePx / 9)
      .setShadow(0, 0, '#ffffff', sizePx / 8, true, false);
    this.add(this.face);
    this.paint();
  }

  /** Moves the rainbow along the face. `dtSec` is wall-clock time. */
  tick(dtSec: number): void {
    this.phase = (this.phase + dtSec * 0.8) % 1;
    this.paint();
  }

  private paint(): void {
    const t = this.face;
    const w = Math.max(1, t.width);
    // Two copies of the spectrum over twice the width, shifted by the phase: a seamless loop.
    const g = t.context.createLinearGradient(-this.phase * w, 0, (2 - this.phase) * w, t.height * 0.4);
    const n = RAINBOW.length;
    for (let k = 0; k <= 2 * n; k++) g.addColorStop(k / (2 * n), RAINBOW[k % n]);
    t.setFill(g);
  }
}

interface DigitBox {
  frame: Phaser.GameObjects.Rectangle;
  text: Phaser.GameObjects.Text;
}

/**
 * Presentation of the fever lottery: the row of holds, the three-digit reel with its reach, the
 * FEVER cut-in (big extruded rainbow text slammed onto the screen) and the FEVER badge that shows
 * the time left. Holds nothing of its own: every frame it redraws from the lottery state.
 */
export class FeverFx {
  private holdDots: Phaser.GameObjects.Arc[] = [];
  private digits: DigitBox[] = [];
  private reachLabel: Phaser.GameObjects.Text;
  private reachDim: Phaser.GameObjects.Rectangle;
  private badge: RainbowText | null = null;
  private badgeInfo: Phaser.GameObjects.Text;
  private live: RainbowText[] = [];
  private framePhase = 0;
  private reel: Phaser.GameObjects.Container;
  /** Spin offsets per digit so the three do not roll in step. */
  private spinOffset = [0, 3, 6];

  constructor(private scene: Phaser.Scene) {
    this.reachDim = scene.add.rectangle(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, 0x000000, 0).setDepth(88);
    this.reel = scene.add.container(0, 0).setDepth(95);
    // WIDTH comes from main.ts, which imports the scene that imports this file: read it here, not at module load.
    const holdX0 = WIDTH / 2 - (DIGIT_W * 1.5 + DIGIT_GAP) - HOLD_INSET;
    for (let i = 0; i < BALANCE.fever.maxHolds; i++) {
      const dot = scene.add.circle(holdX0 - i * HOLD_GAP, REEL_Y, HOLD_R, 0x000000, 0).setStrokeStyle(2, 0x3a4652, 1);
      dot.setDepth(95);
      this.holdDots.push(dot);
    }
    for (let i = 0; i < 3; i++) {
      const x = WIDTH / 2 + (i - 1) * (DIGIT_W + DIGIT_GAP);
      const frame = scene.add.rectangle(x, REEL_Y, DIGIT_W, DIGIT_H, 0x0b0f13, 1).setStrokeStyle(3, 0x3a4652, 1);
      const text = scene.add
        .text(x, REEL_Y, '-', { fontFamily: FONT, fontSize: '64px', color: '#5f6f80', fontStyle: 'bold' })
        .setOrigin(0.5);
      this.digits.push({ frame, text });
      this.reel.add([frame, text]);
    }
    this.reachLabel = scene.add
      .text(WIDTH / 2, REEL_Y - DIGIT_H / 2 - 30, 'REACH', { fontFamily: FONT, fontSize: '40px', color: '#ffd54f', fontStyle: 'italic bold' })
      .setOrigin(0.5)
      .setStroke('#2a1400', 6)
      .setVisible(false);
    this.reel.add(this.reachLabel);
    this.badgeInfo = scene.add
      .text(WIDTH / 2 + 250, REEL_Y, '', { fontFamily: FONT, fontSize: '34px', color: '#ffffff', fontStyle: 'bold' })
      .setOrigin(0, 0.5)
      .setStroke('#2a1400', 6)
      .setDepth(96)
      .setVisible(false);
  }

  /** Redraws holds, reel and badge from the lottery. `dtSec` is wall-clock time since the last frame. */
  update(lottery: FeverLottery, dtSec: number): void {
    for (const t of this.live) t.tick(dtSec);
    this.framePhase = (this.framePhase + dtSec) % 1;

    this.holdDots.forEach((dot, i) => {
      const h = lottery.holds[i];
      if (!h) dot.setFillStyle(0x000000, 0).setStrokeStyle(2, 0x3a4652, 1);
      else if (h.color === 'gold') dot.setFillStyle(this.rainbowAt(i * 0.15), 1).setStrokeStyle(3, 0xffffff, 1);
      else dot.setFillStyle(HOLD_COLORS[h.color], 1).setStrokeStyle(2, 0xffffff, 0.6);
    });

    const fever = lottery.feverActive;
    this.reel.setVisible(!fever);
    this.badgeInfo.setVisible(fever);
    if (fever) {
      this.badgeInfo.setText(`${lottery.feverRemainingSec.toFixed(1)}s  x${BALANCE.fever.scoreMultiplier}${lottery.chain > 1 ? `  ${lottery.chain} CHAIN` : ''}`);
    }

    const d = lottery.draw;
    const F = BALANCE.fever;
    for (let i = 0; i < 3; i++) {
      const box = this.digits[i];
      if (!d) {
        box.text.setColor('#5f6f80');
        box.frame.setStrokeStyle(3, 0x3a4652, 1);
        continue;
      }
      // Gold means a certain win: the frame goes rainbow from the start of the draw.
      const frameColor = d.color === 'gold' ? this.rainbowAt(i * 0.12) : HOLD_COLORS[d.color];
      box.frame.setStrokeStyle(4, frameColor, 1);
      const stopAt = i === 0 ? F.leftStopSec : i === 2 ? F.rightStopSec : d.duration;
      const final = d.digits[i];
      let shown: number;
      if (d.elapsed >= stopAt - 1e-9) {
        shown = final;
        box.text.setColor(d.reach && i !== 1 ? '#ffd54f' : '#ffffff');
      } else if (i === 1 && d.reach && d.elapsed >= F.rightStopSec) {
        // Reach: the centre slows down and rolls onto its final digit (one off on a near miss).
        const r = stopAt - d.elapsed;
        const n = Math.floor(2.5 * r + 1.5 * r * r);
        shown = (((final - 1 - n) % 9) + 9) % 9 + 1;
        box.text.setColor('#ffffff');
      } else {
        shown = (Math.floor(d.elapsed * 18) + this.spinOffset[i]) % 9 + 1;
        box.text.setColor('#9fb3c8');
      }
      box.text.setText(String(shown));
    }
    const reaching = !!d && d.reach && d.elapsed >= F.rightStopSec && d.elapsed < d.duration;
    this.reachLabel.setVisible(reaching);
    if (reaching) {
      const pulse = 0.5 + 0.5 * Math.sin(this.framePhase * Math.PI * 8);
      this.reachLabel.setScale(1 + 0.08 * pulse);
      this.reachDim.setFillStyle(0x000000, 0.35);
    } else {
      this.reachDim.setFillStyle(0x000000, 0);
    }
  }

  /** One-off effects for lottery events (the reel itself is drawn in update). */
  handle(e: FeverEvent, lottery: FeverLottery): void {
    switch (e.type) {
      case 'hold': {
        const dot = this.holdDots[lottery.holds.length - 1];
        if (dot) this.scene.tweens.add({ targets: dot, scale: 1.6, duration: 120, yoyo: true, ease: 'Quad.Out' });
        if (dot && (e.color === 'red' || e.color === 'gold')) this.sparkle(dot.x, dot.y, 8, 50);
        break;
      }
      case 'rightStop':
        if (e.reach) {
          this.reachLabel.setScale(0.3);
          this.scene.tweens.add({ targets: this.reachLabel, scale: 1, duration: 200, ease: 'Back.Out' });
        }
        break;
      case 'result':
        if (e.hit) for (const b of this.digits) this.scene.tweens.add({ targets: b.text, scale: 1.4, duration: 120, yoyo: true });
        break;
      case 'feverContinue':
        this.slam('CONTINUE!', 110, HEIGHT / 2 - 40, 900);
        this.sparkle(WIDTH / 2, HEIGHT / 2 - 40, 18, 360);
        this.showBadge();
        break;
      case 'feverEnd':
        this.hideBadge();
        break;
      default:
        break;
    }
  }

  /**
   * FEVER cut-in: white flash, rotating light rays, "FEVER!!" slammed down from 3x with a heavy shake
   * and a burst of stars, then shrunk into the badge. `onDone` runs after BALANCE.fever.cutInMs.
   */
  cutIn(shake: (strength: number) => void, onDone: () => void): void {
    const s = this.scene;
    const total = BALANCE.fever.cutInMs;
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2 - 20;

    const dim = s.add.rectangle(cx, HEIGHT / 2, WIDTH, HEIGHT, 0x000000, 0.6).setDepth(150);
    const rays = s.add.graphics().setDepth(151).setPosition(cx, cy);
    const n = 18;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = a0 + (Math.PI / n) * 0.9;
      rays.fillStyle(i % 2 ? 0xffd54f : 0xffffff, 0.22);
      rays.fillTriangle(0, 0, Math.cos(a0) * 900, Math.sin(a0) * 900, Math.cos(a1) * 900, Math.sin(a1) * 900);
    }
    rays.setScale(0.2);
    s.tweens.add({ targets: rays, scale: 1, duration: 260, ease: 'Cubic.Out' });
    s.tweens.add({ targets: rays, angle: 40, duration: total, ease: 'Linear' });

    const flash = s.add.rectangle(cx, HEIGHT / 2, WIDTH, HEIGHT, 0xffffff, 0.9).setDepth(155);
    s.tweens.add({ targets: flash, alpha: 0, duration: 260, onComplete: () => flash.destroy() });

    const title = this.track(new RainbowText(s, cx, cy, 'FEVER!!', 190).setDepth(160).setScale(3).setAlpha(0));
    s.tweens.add({
      targets: title,
      scale: 1,
      alpha: 1,
      duration: 170,
      ease: 'Cubic.In',
      onComplete: () => {
        shake(4);
        this.sparkle(cx, cy, 28, 520);
        s.tweens.add({ targets: title, scale: 1.08, duration: 90, yoyo: true, ease: 'Quad.Out' });
      },
    });

    s.time.delayedCall(total - 260, () => {
      s.tweens.add({ targets: [dim, rays], alpha: 0, duration: 240 });
      s.tweens.add({ targets: title, scale: 0.3, y: REEL_Y, alpha: 0, duration: 240, ease: 'Cubic.In' });
    });
    s.time.delayedCall(total, () => {
      dim.destroy();
      rays.destroy();
      this.untrack(title);
      this.showBadge();
      onDone();
    });
  }

  private showBadge(): void {
    if (!this.badge) {
      this.badge = this.track(new RainbowText(this.scene, WIDTH / 2 + 40, REEL_Y, 'FEVER', 88).setDepth(96));
    }
    this.badge.setScale(0.5);
    this.scene.tweens.add({ targets: this.badge, scale: 1, duration: 200, ease: 'Back.Out' });
  }

  private hideBadge(): void {
    const b = this.badge;
    if (!b) return;
    this.badge = null;
    // Quick, so it is gone before the reel shows through it.
    this.scene.tweens.add({ targets: b, alpha: 0, scale: 0.6, duration: 150, onComplete: () => this.untrack(b) });
  }

  /** Big rainbow text that punches in, holds, then rises and fades. */
  private slam(text: string, size: number, y: number, lifeMs: number): void {
    const t = this.track(new RainbowText(this.scene, WIDTH / 2, y, text, size).setDepth(160).setScale(2.2).setAlpha(0));
    this.scene.tweens.add({ targets: t, scale: 1, alpha: 1, duration: 150, ease: 'Cubic.In' });
    this.scene.tweens.add({
      targets: t,
      alpha: 0,
      y: y - 60,
      delay: lifeMs - 300,
      duration: 300,
      onComplete: () => this.untrack(t),
    });
  }

  /** Burst of small stars from (x, y). */
  private sparkle(x: number, y: number, count: number, radius: number): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const dist = radius * (0.5 + Math.random() * 0.5);
      const star = this.scene.add
        .star(x, y, 4, 3, 10, i % 3 === 0 ? 0xffffff : this.rainbowAt(i / count), 1)
        .setDepth(165);
      this.scene.tweens.add({
        targets: star,
        x: x + Math.cos(a) * dist,
        y: y + Math.sin(a) * dist,
        angle: 180,
        scale: 0.2,
        alpha: 0,
        duration: 500 + Math.random() * 300,
        ease: 'Cubic.Out',
        onComplete: () => star.destroy(),
      });
    }
  }

  private rainbowAt(offset: number): number {
    const c = Phaser.Display.Color.HSVToRGB((this.framePhase + offset) % 1, 0.75, 1) as Phaser.Types.Display.ColorObject;
    return Phaser.Display.Color.GetColor(c.r, c.g, c.b);
  }

  private track<T extends RainbowText>(t: T): T {
    this.live.push(t);
    return t;
  }

  private untrack(t: RainbowText): void {
    this.live = this.live.filter((x) => x !== t);
    t.destroy();
  }
}
