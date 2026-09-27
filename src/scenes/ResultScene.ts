import Phaser from 'phaser';
import { WIDTH, HEIGHT } from '../main';
import { FONT } from '../ui/icons';
import type { RoundResult } from './GameScene';

export class ResultScene extends Phaser.Scene {
  constructor() {
    super('Result');
  }

  create(data: RoundResult): void {
    const { score, previousBest, saved } = data;
    const isNewBest = score > previousBest;
    const best = Math.max(score, previousBest);

    (window as unknown as { __bfResult: RoundResult }).__bfResult = data;

    this.add
      .text(WIDTH / 2, 150, 'SCORE', { fontFamily: FONT, fontSize: '36px', color: '#9fb3c8' })
      .setOrigin(0.5);
    this.add
      .text(WIDTH / 2, 250, score.toLocaleString('en-US'), {
        fontFamily: FONT,
        fontSize: '128px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    let diffText: string;
    let diffColor: string;
    if (isNewBest) {
      diffText = previousBest > 0 ? `NEW BEST  +${(score - previousBest).toLocaleString('en-US')}` : 'NEW BEST';
      diffColor = '#ffd54f';
    } else {
      diffText = `BEST ${best.toLocaleString('en-US')}   ${(score - previousBest).toLocaleString('en-US')}`;
      diffColor = '#9fb3c8';
    }
    this.add
      .text(WIDTH / 2, 360, diffText, { fontFamily: FONT, fontSize: '40px', color: diffColor, fontStyle: 'bold' })
      .setOrigin(0.5);

    // Retry button
    const btn = this.add.rectangle(WIDTH / 2, 520, 360, 110, 0x4fc3f7, 1);
    btn.setStrokeStyle(4, 0xe8eef4, 1);
    btn.setInteractive({ useHandCursor: true });
    this.add
      .text(WIDTH / 2, 520, 'RETRY', { fontFamily: FONT, fontSize: '52px', color: '#101418', fontStyle: 'bold' })
      .setOrigin(0.5);
    btn.on('pointerdown', () => this.scene.start('Game'));

    if (!saved) {
      this.add
        .text(WIDTH - 24, HEIGHT - 20, 'no save', { fontFamily: FONT, fontSize: '18px', color: '#5f6f80' })
        .setOrigin(1, 1);
    }
  }
}
