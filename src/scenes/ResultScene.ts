import Phaser from 'phaser';
import { BALANCE, type MachineId } from '../config/balance';
import { WIDTH, HEIGHT } from '../main';
import { drawMachineIcon, FONT } from '../ui/icons';
import type { RoundResult } from './GameScene';

export class ResultScene extends Phaser.Scene {
  constructor() {
    super('Result');
  }

  create(data: RoundResult): void {
    const { score, previousBest, saved, line, speedCount, peakRate } = data;
    const isNewBest = score > previousBest;
    const best = Math.max(score, previousBest);

    (window as unknown as { __bfResult: RoundResult }).__bfResult = data;

    this.add
      .text(WIDTH / 2, 110, 'SCORE', { fontFamily: FONT, fontSize: '32px', color: '#9fb3c8' })
      .setOrigin(0.5);
    this.add
      .text(WIDTH / 2, 200, score.toLocaleString('en-US'), {
        fontFamily: FONT,
        fontSize: '120px',
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
      .text(WIDTH / 2, 295, diffText, { fontFamily: FONT, fontSize: '36px', color: diffColor, fontStyle: 'bold' })
      .setOrigin(0.5);

    // Build: source speed upgrades, then the line in order, then the peak rate.
    this.drawBuild(380, line, speedCount);
    this.add
      .text(WIDTH / 2, 450, `PEAK ${peakRate.toFixed(1)} /s`, { fontFamily: FONT, fontSize: '28px', color: '#9fb3c8' })
      .setOrigin(0.5);

    // Retry button
    const btn = this.add.rectangle(WIDTH / 2, 570, 360, 100, 0x4fc3f7, 1);
    btn.setStrokeStyle(4, 0xe8eef4, 1);
    btn.setInteractive({ useHandCursor: true });
    this.add
      .text(WIDTH / 2, 570, 'RETRY', { fontFamily: FONT, fontSize: '48px', color: '#101418', fontStyle: 'bold' })
      .setOrigin(0.5);
    btn.on('pointerdown', () => this.scene.start('Game'));

    if (!saved) {
      this.add
        .text(WIDTH - 24, HEIGHT - 20, 'no save', { fontFamily: FONT, fontSize: '18px', color: '#5f6f80' })
        .setOrigin(1, 1);
    }
  }

  private drawBuild(y: number, line: MachineId[], speedCount: number): void {
    const items: { id: MachineId; count?: number }[] = [];
    if (speedCount > 0) items.push({ id: 'speed', count: speedCount });
    for (const id of line) items.push({ id });
    if (items.length === 0) return;

    const size = 44;
    const spacing = Math.min(80, (WIDTH - 200) / items.length);
    const startX = WIDTH / 2 - ((items.length - 1) * spacing) / 2;
    const g = this.add.graphics();
    items.forEach((item, i) => {
      const def = BALANCE.machineDefs.find((d) => d.id === item.id)!;
      const x = startX + i * spacing;
      drawMachineIcon(g, item.id, x, y, size, def.color);
      if (item.count && item.count > 1) {
        this.add
          .text(x, y + 38, `x${item.count}`, { fontFamily: FONT, fontSize: '18px', color: '#9fb3c8' })
          .setOrigin(0.5);
      }
    });
  }
}
