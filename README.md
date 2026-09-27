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
```

## Deployment

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds the project and publishes `dist/`
to GitHub Pages (Pages source must be set to "GitHub Actions").

Public URL format:

```
https://<owner>.github.io/ball-factory/
```

For this repository: https://iyamuu.github.io/ball-factory/

## Tuning

All gameplay numbers (round length, base production, card timing, machine effects, screen shake) live in
`src/config/balance.ts`.
