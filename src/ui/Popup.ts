import Phaser from 'phaser';
import { FONT } from './icons';

/** Spawns a floating "+N" text that rises and fades out. */
export function spawnPopup(scene: Phaser.Scene, x: number, y: number, text: string, big: boolean): void {
  const t = scene.add
    .text(x, y, text, {
      fontFamily: FONT,
      fontSize: big ? '44px' : '30px',
      color: big ? '#ffd54f' : '#c8f7c5',
      fontStyle: 'bold',
    })
    .setOrigin(0.5)
    .setDepth(50);
  scene.tweens.add({
    targets: t,
    y: y - 70,
    alpha: 0,
    duration: 700,
    ease: 'Cubic.Out',
    onComplete: () => t.destroy(),
  });
}
