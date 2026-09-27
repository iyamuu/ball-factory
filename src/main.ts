import Phaser from 'phaser';
import { GameScene } from './scenes/GameScene';
import { ResultScene } from './scenes/ResultScene';

export const WIDTH = 1280;
export const HEIGHT = 720;

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: WIDTH,
  height: HEIGHT,
  backgroundColor: '#101418',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  // Phaser's delta smoothing replaces frames slower than 200 ms with an older value, which
  // silently drops elapsed time on slow devices. The simulation runs on a fixed step from the
  // raw delta instead, so the round length matches wall-clock time.
  fps: { smoothStep: false },
  scene: [GameScene, ResultScene],
});
