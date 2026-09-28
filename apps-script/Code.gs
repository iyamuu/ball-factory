/**
 * Ball Factory round telemetry collector (Google Apps Script, bound to a Google Sheet).
 *
 * The game POSTs one JSON record per finished round (src/telemetry.ts, RoundRecord). Each record
 * becomes one row on the sheet named SHEET_NAME. Anyone can post (the web app is deployed with
 * access "Anyone"); only the sheet owner can read the sheet.
 *
 * Setup: docs/TELEMETRY.md
 */

var SHEET_NAME = 'rounds';
var MAX_BODY_BYTES = 20000;
var HEADER = [
  'received', 'time', 'player', 'build', 'seed', 'durationSec', 'roundLengthSec', 'score',
  'peakRate', 'speedCount', 'extendCount', 'line', 'offers', 'picks', 'decisionSec',
  'screen', 'raw',
];
var LETTER = { splitter: 'S', accelerator: 'A', press: 'P', speed: 'V', extend: 'E' };

function doPost(e) {
  try {
    var body = e && e.postData && e.postData.contents;
    if (!body || body.length > MAX_BODY_BYTES) return reply('rejected');
    var r = JSON.parse(body);
    if (!r || r.v !== 1 || typeof r.score !== 'number' || !Array.isArray(r.offers)) return reply('rejected');

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      getSheet().appendRow(toRow(r, body));
    } finally {
      lock.releaseLock();
    }
    return reply('ok');
  } catch (err) {
    return reply('error');
  }
}

/** GET is only used to check that the deployment is alive. */
function doGet() {
  return reply('ball-factory telemetry');
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function toRow(r, body) {
  var letters = function (ids) { return (ids || []).map(function (id) { return LETTER[id] || '?'; }).join(''); };
  var offers = r.offers.map(function (o) { return letters(o.cards) + '>' + (LETTER[o.pick] || '?'); }).join(' ');
  var picks = letters(r.offers.map(function (o) { return o.pick; }));
  var decision = r.offers.map(function (o) { return Number(o.decisionSec).toFixed(1); }).join(' ');
  var s = r.screen || {};
  var screen = [s.w, s.h, 'x' + s.dpr, s.touch ? 'touch' : 'mouse'].join(' ');
  return [
    new Date(), r.time, r.player, r.build, r.seed, r.durationSec, r.roundLengthSec, r.score,
    r.peakRate, r.speedCount, r.extendCount, letters(r.line), offers, picks, decision, screen, body,
  ];
}

function reply(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}
