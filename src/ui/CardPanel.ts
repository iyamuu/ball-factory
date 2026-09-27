import Phaser from 'phaser';
import type { MachineDef } from '../config/balance';
import { WIDTH, HEIGHT } from '../main';
import { drawMachineIcon, FONT } from './icons';

const CARD_W = 240;
const CARD_H = 300;
const GAP = 60;

/**
 * Full-screen overlay with the offered cards. Blocks input to the scene below
 * and calls `onPick` with the chosen card index.
 */
export class CardPanel extends Phaser.GameObjects.Container {
  private cards: Phaser.GameObjects.Container[] = [];
  private onPick: ((index: number) => void) | null = null;

  constructor(scene: Phaser.Scene) {
    super(scene, 0, 0);
    scene.add.existing(this);
    this.setDepth(100);

    const dim = scene.add.rectangle(WIDTH / 2, HEIGHT / 2, WIDTH, HEIGHT, 0x000000, 0.55);
    dim.setInteractive(); // swallow taps outside the cards
    this.add(dim);

    this.setVisible(false);
    this.setActive(false);
  }

  show(defs: MachineDef[], onPick: (index: number) => void): void {
    this.clearCards();
    this.onPick = onPick;

    const total = defs.length * CARD_W + (defs.length - 1) * GAP;
    const startX = WIDTH / 2 - total / 2 + CARD_W / 2;

    defs.forEach((def, i) => {
      const card = this.makeCard(def, startX + i * (CARD_W + GAP), HEIGHT / 2 + 20, i);
      this.cards.push(card);
      this.add(card);
      card.setScale(0.85);
      card.setAlpha(0);
      this.scene.tweens.add({
        targets: card,
        scale: 1,
        alpha: 1,
        duration: 160,
        delay: i * 50,
        ease: 'Back.Out',
      });
    });

    this.setVisible(true);
    this.setActive(true);
  }

  hide(): void {
    this.setVisible(false);
    this.setActive(false);
    this.clearCards();
    this.onPick = null;
  }

  private clearCards(): void {
    for (const c of this.cards) c.destroy();
    this.cards = [];
  }

  private makeCard(def: MachineDef, x: number, y: number, index: number): Phaser.GameObjects.Container {
    const scene = this.scene;
    const c = scene.add.container(x, y);

    const bg = scene.add.rectangle(0, 0, CARD_W, CARD_H, 0x1c232b, 1);
    bg.setStrokeStyle(4, def.color, 1);
    bg.setInteractive({ useHandCursor: true });
    bg.on('pointerdown', () => {
      if (this.onPick) this.onPick(index);
    });
    bg.on('pointerover', () => c.setScale(1.04));
    bg.on('pointerout', () => c.setScale(1));

    const g = scene.add.graphics();
    drawMachineIcon(g, def.id, 0, -78, 84, def.color);

    const label = scene.add
      .text(0, 8, def.label, { fontFamily: FONT, fontSize: '28px', color: '#e8eef4', fontStyle: 'bold' })
      .setOrigin(0.5);
    const figure = scene.add
      .text(0, 56, def.figure, { fontFamily: FONT, fontSize: '38px', color: Phaser.Display.Color.IntegerToColor(def.color).rgba, fontStyle: 'bold' })
      .setOrigin(0.5);
    const desc = scene.add
      .text(0, 112, def.desc, {
        fontFamily: FONT,
        fontSize: '17px',
        color: '#9fb3c8',
        align: 'center',
        wordWrap: { width: CARD_W - 24 },
      })
      .setOrigin(0.5);

    c.add([bg, g, label, figure, desc]);
    return c;
  }
}
