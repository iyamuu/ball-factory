import Phaser from 'phaser';
import type { MachineId } from '../config/balance';

function fillPolygon(g: Phaser.GameObjects.Graphics, pts: { x: number; y: number }[]): void {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.fillPath();
}

/** Draws the shape used for a machine, centred on (x, y), with a bounding size of `size`. */
export function drawMachineIcon(
  g: Phaser.GameObjects.Graphics,
  id: MachineId,
  x: number,
  y: number,
  size: number,
  color: number,
): void {
  const r = size / 2;
  g.fillStyle(color, 1);
  switch (id) {
    case 'splitter': {
      // Circle cut in two by a dark bar.
      g.fillCircle(x, y, r);
      g.fillStyle(0x101418, 1);
      g.fillRect(x - size * 0.06, y - r, size * 0.12, size);
      break;
    }
    case 'accelerator': {
      // Right-pointing triangle.
      g.fillTriangle(x - r, y - r, x - r, y + r, x + r, y);
      break;
    }
    case 'press': {
      // Diamond.
      fillPolygon(
        g,
        [
          { x, y: y - r },
          { x: x + r, y },
          { x, y: y + r },
          { x: x - r, y },
        ],
      );
      break;
    }
    case 'speed': {
      // Two stacked chevrons.
      const t = size * 0.18;
      fillPolygon(
        g,
        [
          { x: x - r, y: y - r },
          { x: x - r + t, y: y - r },
          { x: x + t * 0.5, y },
          { x: x - r + t, y: y + r },
          { x: x - r, y: y + r },
          { x: x - t * 0.5, y },
        ],
      );
      fillPolygon(
        g,
        [
          { x: x - t * 0.5, y: y - r },
          { x: x - t * 0.5 + t, y: y - r },
          { x: x + r, y },
          { x: x - t * 0.5 + t, y: y + r },
          { x: x - t * 0.5, y: y + r },
          { x: x + r - t, y },
        ],
      );
      break;
    }
  }
}

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
