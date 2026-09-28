// Compiles the game model plus main.ts to CommonJS (the package is "type": "module") and runs it.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const here = __dirname;
const dist = path.join(here, 'dist');
const tscBin = path.join(here, '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const tsc = spawnSync(tscBin, ['-p', path.join(here, 'tsconfig.json')], { stdio: 'inherit', shell: process.platform === 'win32' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
fs.writeFileSync(path.join(dist, 'package.json'), '{ "type": "commonjs" }\n');
require(path.join(dist, 'tools', 'balance', 'main.js'));
