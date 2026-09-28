/**
 * Round telemetry settings. The game posts one JSON record per finished round to a Google Apps
 * Script web app that appends it to a private Google Sheet (setup: docs/TELEMETRY.md).
 * Sending is fire-and-forget and can never affect the game.
 */
export const TELEMETRY = {
  /**
   * Web app URL of the Apps Script deployment ("https://script.google.com/macros/s/.../exec").
   * Empty: nothing is sent, rounds are only kept in the local log. The deploy workflow fills it
   * from the repository variable TELEMETRY_URL; a literal string here works too.
   */
  endpoint: import.meta.env.VITE_TELEMETRY_URL ?? '',
  /** Build identifier stored with every record (the deploy workflow passes the commit SHA). */
  build: import.meta.env.VITE_BUILD ?? 'dev',
  /** Finished rounds kept in localStorage for COPY LOG on the result screen (oldest dropped). */
  localRounds: 20,
  /** Record format version, stored in every record. Bump when fields change meaning. */
  version: 1,
  storage: {
    logKey: 'ball-factory.log.v1',
    playerKey: 'ball-factory.player.v1',
  },
} as const;
