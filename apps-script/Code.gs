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

/**
 * Cells are written as plain numbers or literal text. A value that Sheets would read as a formula
 * (leading =, +, -, @, tab or newline) is prefixed with an apostrophe, since anyone can post here.
 */
function num(v) {
  var n = Number(v);
  return isFinite(n) ? n : '';
}

function text(v, maxLen) {
  var s = v === undefined || v === null ? '' : String(v);
  if (s.length > maxLen) s = s.slice(0, maxLen);
  if (/^[=+\-@\t\r\n]/.test(s)) s = "'" + s;
  return s;
}

function toRow(r, body) {
  var letters = function (ids) {
    return (Array.isArray(ids) ? ids : []).map(function (id) { return LETTER[id] || '?'; }).join('');
  };
  var offers = r.offers.map(function (o) { return letters(o && o.cards) + '>' + (LETTER[o && o.pick] || '?'); }).join(' ');
  var picks = letters(r.offers.map(function (o) { return o && o.pick; }));
  var decision = r.offers.map(function (o) { var d = num(o && o.decisionSec); return d === '' ? '?' : d.toFixed(1); }).join(' ');
  var s = r.screen || {};
  var screen = [num(s.w), num(s.h), 'x' + num(s.dpr), s.touch ? 'touch' : 'mouse'].join(' ');
  return [
    new Date(), text(r.time, 40), text(r.player, 32), text(r.build, 64), num(r.seed), num(r.durationSec),
    num(r.roundLengthSec), num(r.score), num(r.peakRate), num(r.speedCount), num(r.extendCount),
    letters(r.line), text(offers, 400), text(picks, 40), text(decision, 200), text(screen, 60),
    text(body, MAX_BODY_BYTES),
  ];
}

function reply(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}
