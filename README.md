# ball-factory

Browser mini-game prototype: balls are produced automatically, and every few seconds you pick one of three
machines to add to the line. The goal of this prototype is to test whether a single ~70 second round is fun.

Built with Vite + Phaser + TypeScript. No server, no assets, shapes and numbers only.

## Run locally

```sh
npm install
npm run dev
```

Then open the URL that Vite prints (default `http://localhost:5173/ball-factory/`).

Other scripts:

```sh
npm run build     # type-check + production build into dist/
npm run preview   # serve the production build locally
npm run balance   # brute-force balance check of the configured numbers (tools/balance)
```

## Deployment

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds the project and publishes `dist/`
to GitHub Pages (Pages source must be set to "GitHub Actions").

Public URL format:

```
https://<owner>.github.io/ball-factory/
```

For this repository: https://iyamuu.github.io/ball-factory/

Preview without merging: push a branch to `preview` (for example `git push -f origin my-branch:preview`).
`.github/workflows/preview-trigger.yml` then redeploys the site from `main`, and `deploy.yml` also builds
the `preview` branch into https://iyamuu.github.io/ball-factory/preview/. Both builds share the browser
storage of the site (best score, speed, sound).

## Tuning

All gameplay numbers (round length, base production, card timing, machine effects, screen shake) live in
`src/config/balance.ts`.

## Round telemetry (optional)

At the end of a round the game can post one JSON record (seed, every offer and pick, decision times, score,
build, screen size) to a Google Apps Script web app that appends it to a private Google Sheet. Nothing is
sent unless the endpoint is configured; the last 20 rounds are always kept in the browser and can be copied
from the result screen with COPY LOG. Setup steps and the script: `docs/TELEMETRY.md`, `apps-script/Code.gs`.
Settings: `src/config/telemetry.ts`.
