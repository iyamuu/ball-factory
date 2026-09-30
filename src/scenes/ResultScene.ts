import Phaser from 'phaser';
import { BALANCE, type MachineId } from '../config/balance';
import { WIDTH, HEIGHT } from '../main';
import { drawMachineIcon, FONT } from '../ui/icons';
import type { RoundResult } from './GameScene';
import { formatLog } from '../telemetry';

export class ResultScene extends Phaser.Scene {
  constructor() {
    super('Result');
  }

  create(data: RoundResult): void {
    const { score, previousBest, saved, line, speedCount, extendCount, peakRate } = data;
    const isNewBest = score > previousBest;
    const best = Math.max(score, previousBest);

    (window as unknown as { __bfResult: RoundResult }).__bfResult = data;

    this.add
      .text(WIDTH / 2, 100, 'SCORE', { fontFamily: FONT, fontSize: '32px', color: '#9fb3c8' })
      .setOrigin(0.5);
    this.add
      .text(WIDTH / 2, 190, score.toLocaleString('en-US'), {
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
      .text(WIDTH / 2, 285, diffText, { fontFamily: FONT, fontSize: '36px', color: diffColor, fontStyle: 'bold' })
      .setOrigin(0.5);

    // Build: source upgrades and time extensions first, then the line in order, then the peak rate.
    this.drawBuild(365, line, [
      { id: 'speed', count: speedCount },
      { id: 'extend', count: extendCount },
    ]);
    this.add
      .text(WIDTH / 2, 435, `PEAK ${peakRate.toFixed(1)} /s`, { fontFamily: FONT, fontSize: '28px', color: '#9fb3c8' })
      .setOrigin(0.5);
    if (data.fever) {
      const f = data.fever;
      const text = f.hits > 0
        ? `FEVER ${f.hits}x  +${f.bonus.toLocaleString('en-US')}${f.longestChain > 1 ? `  (${f.longestChain} CHAIN)` : ''}`
        : 'FEVER -';
      this.add
        .text(WIDTH / 2, 478, text, { fontFamily: FONT, fontSize: '28px', color: f.hits > 0 ? '#ffd54f' : '#5f6f80', fontStyle: 'bold' })
        .setOrigin(0.5);
    }

    const btn = this.add.rectangle(WIDTH / 2, 560, 360, 100, 0x4fc3f7, 1);
    btn.setStrokeStyle(4, 0xe8eef4, 1);
    btn.setInteractive({ useHandCursor: true });
    this.add
      .text(WIDTH / 2, 560, 'RETRY', { fontFamily: FONT, fontSize: '48px', color: '#101418', fontStyle: 'bold' })
      .setOrigin(0.5);
    btn.on('pointerdown', () => this.scene.start('Game'));

    if (!saved) {
      this.add
        .text(WIDTH - 24, HEIGHT - 20, 'no save', { fontFamily: FONT, fontSize: '18px', color: '#5f6f80' })
        .setOrigin(1, 1);
    }

    // Copies the local round log (JSON) for playtests without a telemetry endpoint.
    const copy = this.add
      .text(24, HEIGHT - 20, 'COPY LOG', { fontFamily: FONT, fontSize: '18px', color: '#5f6f80' })
      .setOrigin(0, 1)
      .setPadding(12, 10, 12, 10);
    copy.setInteractive({ useHandCursor: true });
    copy.on('pointerdown', () => {
      void this.copyLog()
        .then((ok) => {
          // The player may have left the scene (RETRY) before the clipboard call settled.
          if (copy.active) copy.setText(ok ? 'COPIED' : 'COPY FAILED');
        })
        .catch(() => undefined);
    });
  }

  private async copyLog(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(formatLog());
      return true;
    } catch {
      return false;
    }
  }

  private drawBuild(y: number, line: MachineId[], upgrades: { id: MachineId; count: number }[]): void {
    const items: { id: MachineId; count?: number }[] = [];
    for (const u of upgrades) if (u.count > 0) items.push(u);
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
