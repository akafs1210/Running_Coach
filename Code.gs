/**
 * Google Apps Script – Training Tracker Sync Backend
 * Sheet ID: 1n0-lXE6DWVEhtYrfCG_TbZeveecS4CDLFoDudfgyX4c
 *
 * Deployment:
 * 1. sheet.new → Erweiterungen → Apps Script → diesen Code einfügen
 * 2. Bereitstellen → Neue Bereitstellung → Web-App
 *    Ausführen als: Ich selbst | Zugriff: Jeder
 * 3. /exec-URL in App eintragen (Fortschritt → Sync)
 *
 * doGet?action=export  → gibt alle Einträge als JSON zurück (für Sync)
 * doPost               → schreibt neue Einträge
 */

const RAW_SHEET   = 'Sync_Eintraege';
const SHEET_KRAFT = 'Log_Kraft';
const SHEET_LAUF  = 'Log_Lauf';
const SHEET_RAD   = 'Log_Outdoor';
const SHEET_GEW   = 'Log_Gewicht';
const SHEET_KW    = 'Uebersicht_KW';

const COL_PURPLE  = '#4a1a7a';
const COL_HEADER  = '#6a3fa0';
const COL_ALT     = '#f3e8ff';
const COL_WHITE   = '#ffffff';
const COL_GOLD    = '#FFD700';
const COL_VAL_BG  = '#e8d5ff';

const TYPE_NAMES = {
  kraft_a:       'KRAFT A – Push',
  kraft_b:       'KRAFT B – Pull',
  kraft_manuell: 'KRAFT – Manuell',
  longrun:   'Longrun',
  threshold: 'Threshold',
  interval:  'Intervall',
  z2:        'Z2 – Grundlage',
  rennrad:   'Rennrad',
  mtb:       'MTB',
  ebike:     'E-Bike',
  wandern:   'Wandern',
  schwimmen: 'Schwimmen',
  surfen:    'Surfen',
};

// ── GET: Daten exportieren ─────────────────────────────────
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';

  if (action === 'export') {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(RAW_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return jsonResponse([]);
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    const entries = rows
      .filter(r => r[0])
      .map(r => { try { return JSON.parse(r[1]); } catch(e) { return null; } })
      .filter(Boolean);
    return jsonResponse(entries);
  }

  return jsonResponse({ ok: true, info: 'Training Tracker Sync API' });
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── POST: Einträge schreiben ───────────────────────────────
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const payload = JSON.parse(e.postData.contents);
    const entries = payload.entries || [];
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const rawSheet = getOrCreate(ss, RAW_SHEET, ['id', 'json', 'gespeichert_am']);
    const existingIds = new Set();
    if (rawSheet.getLastRow() > 1) {
      rawSheet.getRange(2, 1, rawSheet.getLastRow() - 1, 1)
        .getValues().forEach(r => existingIds.add(r[0]));
    }

    // Gelöschte Einträge aus Sync_Eintraege entfernen
    const deletedIds = new Set(payload.deletedIds || []);
    if (deletedIds.size > 0 && rawSheet.getLastRow() > 1) {
      const rows = rawSheet.getRange(2, 1, rawSheet.getLastRow() - 1, 1).getValues();
      for (let i = rows.length - 1; i >= 0; i--) {
        if (deletedIds.has(rows[i][0])) rawSheet.deleteRow(i + 2);
      }
    }

    const newEntries = entries.filter(e => e && e.id && !existingIds.has(e.id) && !deletedIds.has(e.id));
    newEntries.forEach(entry => {
      rawSheet.appendRow([entry.id, JSON.stringify(entry), new Date().toISOString()]);
      if (entry.type === 'gewicht') writeGewicht(ss, entry);
    });

    if (newEntries.length > 0 || deletedIds.size > 0) {
      rebuildKW(ss);
      rebuildLogKraft(ss);
      rebuildLogLauf(ss);
      rebuildLogRad(ss);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, written: newEntries.length })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log(err);
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// ── Gewicht (tabellarisch, kein Block) ────────────────────
function writeGewicht(ss, entry) {
  const sh = getOrCreate(ss, SHEET_GEW, ['ID','KW','Jahr','Datum','kg']);
  // Doppelte vermeiden
  if (sh.getLastRow() > 1) {
    const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => r[0]);
    if (ids.includes(entry.id)) return;
  }
  sh.appendRow([entry.id, entry.kw, entry.yr, entry.date, entry.kg || '']);
}

// ── Hilfs: Datum YYYY-MM-DD → DD.MM. ──────────────────────
function fmtDate(dateStr) {
  const p = (dateStr || '').split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.` : (dateStr || '');
}

// ── Hilfs: Sheet leeren (Inhalt + Format) ─────────────────
function clearSheet(ss, name) {
  let sh = ss.getSheetByName(name);
  if (sh) {
    sh.clear();
    sh.clearFormats();
  } else {
    sh = ss.insertSheet(name);
  }
  return sh;
}

// ── Hilfs: Info-Zeile schreiben (Label | Wert Paare) ───────
function writeInfoRow(sh, row, pairs, numCols) {
  const vals = [];
  pairs.forEach(([label, value]) => { vals.push(label, value); });
  // Auf numCols auffüllen
  while (vals.length < numCols) vals.push('');
  sh.getRange(row, 1, 1, numCols).setValues([vals]);
  for (let c = 1; c <= numCols; c += 2) {
    sh.getRange(row, c)
      .setBackground(COL_HEADER).setFontColor(COL_WHITE).setFontWeight('bold');
    if (c + 1 <= numCols) {
      sh.getRange(row, c + 1)
        .setBackground(COL_VAL_BG).setFontColor('#000000').setFontWeight('normal');
    }
  }
  sh.setRowHeight(row, 22);
}

// ── Hilfs: Titel-Zeile schreiben ──────────────────────────
function writeTitleRow(sh, row, text, numCols) {
  const r = sh.getRange(row, 1, 1, numCols);
  r.merge();
  r.setValue(text)
    .setBackground(COL_PURPLE).setFontColor(COL_GOLD)
    .setFontWeight('bold').setFontSize(11)
    .setHorizontalAlignment('left').setVerticalAlignment('middle');
  sh.setRowHeight(row, 28);
}

// ────────────────────────────────────────────────────────────
// LOG_KRAFT  (Block-Format: eine Tabelle pro Einheit)
// ────────────────────────────────────────────────────────────
function rebuildLogKraft(ss) {
  const raw = ss.getSheetByName(RAW_SHEET);
  if (!raw || raw.getLastRow() < 2) return;

  const entries = [];
  raw.getRange(2, 1, raw.getLastRow() - 1, 2).getValues().forEach(r => {
    try {
      const e = JSON.parse(r[1]);
      if (['kraft_a', 'kraft_b', 'kraft_manuell'].includes(e.type)) entries.push(e);
    } catch(x) {}
  });
  if (!entries.length) return;
  entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const sh = clearSheet(ss, SHEET_KRAFT);
  sh.setColumnWidth(1, 200);
  for (let c = 2; c <= 7; c++) sh.setColumnWidth(c, 65);
  sh.setColumnWidth(8, 180);

  entries.forEach(entry => writeKraftBlock(sh, entry));
}

function writeKraftBlock(sh, entry) {
  const COLS = 8;
  const exercises = entry.exercises || [];
  const dateShort = fmtDate(entry.date);
  const title = `KW${entry.kw || ''} – ${TYPE_NAMES[entry.type] || entry.type} – ${dateShort}`;
  let row = sh.getLastRow() + 1;

  writeTitleRow(sh, row, title, COLS);
  row++;

  writeInfoRow(sh, row, [
    ['Datum', dateShort],
    ['Notizen', entry.notes || ''],
    ['', ''],
    ['', ''],
  ], COLS);
  row++;

  // Spalten-Header
  sh.getRange(row, 1, 1, COLS)
    .setValues([['Übung', 'S1 kg', 'S1 Wdh', 'S2 kg', 'S2 Wdh', 'S3 kg', 'S3 Wdh', 'Notizen']])
    .setBackground(COL_HEADER).setFontColor(COL_WHITE).setFontWeight('bold')
    .setHorizontalAlignment('center');
  sh.getRange(row, 1).setHorizontalAlignment('left');
  sh.setRowHeight(row, 22);
  row++;

  exercises.forEach((ex, idx) => {
    const sets = ex.sets || [];
    const s = [0, 1, 2].map(i => sets[i] || {});
    const v = (set, field, alt) => set[field] !== undefined && set[field] !== null && set[field] !== '' ? set[field] : (set[alt] || '');
    const label = String.fromCharCode(65 + idx) + ': ' + (ex.name || '');
    const bg = idx % 2 === 0 ? COL_WHITE : COL_ALT;
    sh.getRange(row, 1, 1, COLS)
      .setValues([[label, v(s[0],'v1','kg'), v(s[0],'v2','reps'), v(s[1],'v1','kg'), v(s[1],'v2','reps'), v(s[2],'v1','kg'), v(s[2],'v2','reps'), '']])
      .setBackground(bg).setFontColor('#000000').setFontWeight('normal');
    sh.getRange(row, 2, 1, 6).setHorizontalAlignment('center');
    sh.setRowHeight(row, 21);
    row++;
  });

  sh.appendRow(['—']);
  sh.setRowHeight(sh.getLastRow(), 12);
  sh.getRange(sh.getLastRow(), 1, 1, COLS).setBackground(COL_WHITE).setFontColor(COL_WHITE);
  sh.appendRow(['—']);
  sh.setRowHeight(sh.getLastRow(), 12);
  sh.getRange(sh.getLastRow(), 1, 1, COLS).setBackground(COL_WHITE).setFontColor(COL_WHITE);
}

// ────────────────────────────────────────────────────────────
// LOG_LAUF  (Block-Format: ein Block pro Lauf-Einheit)
// ────────────────────────────────────────────────────────────
const LAUF_TYPES = ['longrun', 'threshold', 'interval', 'z2'];

function rebuildLogLauf(ss) {
  const raw = ss.getSheetByName(RAW_SHEET);
  if (!raw || raw.getLastRow() < 2) return;

  const entries = [];
  raw.getRange(2, 1, raw.getLastRow() - 1, 2).getValues().forEach(r => {
    try {
      const e = JSON.parse(r[1]);
      if (LAUF_TYPES.includes(e.type)) entries.push(e);
    } catch(x) {}
  });
  if (!entries.length) return;
  entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const sh = clearSheet(ss, SHEET_LAUF);
  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(2, 80);
  sh.setColumnWidth(3, 130);
  sh.setColumnWidth(4, 80);
  sh.setColumnWidth(5, 130);
  sh.setColumnWidth(6, 80);
  sh.setColumnWidth(7, 130);
  sh.setColumnWidth(8, 80);

  entries.forEach(entry => writeLaufBlock(sh, entry));
}

function writeLaufBlock(sh, entry) {
  const COLS = 8;
  const dateShort = fmtDate(entry.date);
  const title = `KW${entry.kw || ''} – ${TYPE_NAMES[entry.type] || entry.type} – ${dateShort}`;
  let row = sh.getLastRow() + 1;

  writeTitleRow(sh, row, title, COLS);
  row++;

  // Zeile 1: Distanz, Zeit, Pace, Typ
  const timeMin = entry.timeMin || '';
  const timeStr = timeMin ? (Math.floor(timeMin / 60) + 'h ' + (timeMin % 60) + 'min') : '';
  writeInfoRow(sh, row, [
    ['Distanz', (entry.km || '') + (entry.km ? ' km' : '')],
    ['Zeit', timeStr],
    ['Pace', entry.pace || ''],
    ['Typ', TYPE_NAMES[entry.type] || entry.type],
  ], COLS);
  row++;

  // Zeile 2: HR Avg, HR Max, Knie, Notizen
  writeInfoRow(sh, row, [
    ['HR Ø (bpm)', entry.hrAvg || ''],
    ['HR Max', entry.hrMax || ''],
    ['Knie', entry.knie || ''],
    ['Notizen', entry.notes || ''],
  ], COLS);
  row++;

  sh.appendRow(['—']);
  sh.setRowHeight(sh.getLastRow(), 12);
  sh.getRange(sh.getLastRow(), 1, 1, COLS).setBackground(COL_WHITE).setFontColor(COL_WHITE);
  sh.appendRow(['—']);
  sh.setRowHeight(sh.getLastRow(), 12);
  sh.getRange(sh.getLastRow(), 1, 1, COLS).setBackground(COL_WHITE).setFontColor(COL_WHITE);
}

// ────────────────────────────────────────────────────────────
// LOG_RAD / LOG_OUTDOOR  (Block-Format: ein Block pro Rad/Outdoor-Einheit)
// ────────────────────────────────────────────────────────────
const RAD_TYPES = ['rennrad', 'mtb', 'ebike', 'wandern', 'schwimmen', 'surfen'];

function rebuildLogRad(ss) {
  const raw = ss.getSheetByName(RAW_SHEET);
  if (!raw || raw.getLastRow() < 2) return;

  const entries = [];
  raw.getRange(2, 1, raw.getLastRow() - 1, 2).getValues().forEach(r => {
    try {
      const e = JSON.parse(r[1]);
      if (RAD_TYPES.includes(e.type)) entries.push(e);
    } catch(x) {}
  });
  if (!entries.length) return;
  entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Alten Log_Rad Tab löschen falls noch vorhanden
  const oldRad = ss.getSheetByName('Log_Rad');
  if (oldRad) ss.deleteSheet(oldRad);

  const sh = clearSheet(ss, SHEET_RAD);
  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(2, 80);
  sh.setColumnWidth(3, 130);
  sh.setColumnWidth(4, 80);
  sh.setColumnWidth(5, 130);
  sh.setColumnWidth(6, 80);
  sh.setColumnWidth(7, 130);
  sh.setColumnWidth(8, 180);

  entries.forEach(entry => writeRadBlock(sh, entry));
}

function writeRadBlock(sh, entry) {
  const COLS = 8;
  const dateShort = fmtDate(entry.date);
  const title = `KW${entry.kw || ''} – ${TYPE_NAMES[entry.type] || entry.type} – ${dateShort}`;
  let row = sh.getLastRow() + 1;

  writeTitleRow(sh, row, title, COLS);
  row++;

  const timeMin = entry.timeMin || '';
  const timeStr = timeMin ? (Math.floor(timeMin / 60) + 'h ' + (timeMin % 60) + 'min') : '';
  writeInfoRow(sh, row, [
    ['Distanz', (entry.km || '') + (entry.km ? ' km' : '')],
    ['Zeit', timeStr],
    ['HR Ø (bpm)', entry.hrAvg || ''],
    ['Typ', TYPE_NAMES[entry.type] || entry.type],
  ], COLS);
  row++;

  writeInfoRow(sh, row, [
    ['Höhenmeter', entry.elevation ? entry.elevation + ' m' : ''],
    ['Fueling', entry.fueling || entry.conditions || ''],
    ['Notizen', entry.notes || ''],
    ['', ''],
  ], COLS);
  row++;

  sh.appendRow(['—']);
  sh.setRowHeight(sh.getLastRow(), 12);
  sh.getRange(sh.getLastRow(), 1, 1, COLS).setBackground(COL_WHITE).setFontColor(COL_WHITE);
  sh.appendRow(['—']);
  sh.setRowHeight(sh.getLastRow(), 12);
  sh.getRange(sh.getLastRow(), 1, 1, COLS).setBackground(COL_WHITE).setFontColor(COL_WHITE);
}

// ── Übersicht KW neu aufbauen ──────────────────────────────
function rebuildKW(ss) {
  const sheet = getOrCreate(ss, SHEET_KW,
    ['KW','Jahr','Gewicht_Avg','Lauf_km','Rad_km','Kraft_Einheiten']);

  const kwData = {};
  function kw(k, y) {
    const key = `${y}-${String(k).padStart(2,'0')}`;
    if (!kwData[key]) kwData[key] = {k,y,w:[],lauf:0,rad:0,kraft:new Set()};
    return kwData[key];
  }

  const raw = ss.getSheetByName(RAW_SHEET);
  if (raw && raw.getLastRow() > 1) {
    raw.getRange(2,1,raw.getLastRow()-1,2).getValues().forEach(r => {
      try {
        const e = JSON.parse(r[1]);
        const d = kw(e.kw, e.yr);
        if (LAUF_TYPES.includes(e.type)) d.lauf += parseFloat(e.km)||0;
        if (['rennrad','mtb','ebike'].includes(e.type)) d.rad += parseFloat(e.km)||0;
        if (['kraft_a','kraft_b'].includes(e.type)) d.kraft.add(e.id);
        if (e.type==='gewicht' && e.kg) d.w.push(parseFloat(e.kg));
      } catch(x) {}
    });
  }

  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow()-1);
  Object.keys(kwData).sort().forEach(key => {
    const d = kwData[key];
    const avg = d.w.length ? (d.w.reduce((a,b)=>a+b,0)/d.w.length).toFixed(1) : '';
    sheet.appendRow([d.k, d.y, avg, d.lauf.toFixed(1), d.rad.toFixed(1), d.kraft.size]);
  });
}

// ── Hilfs-Funktion ────────────────────────────────────────
function getOrCreate(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length) {
      sh.getRange(1,1,1,headers.length).setValues([headers])
        .setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }
  return sh;
}
