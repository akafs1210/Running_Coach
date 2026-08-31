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

const RAW_SHEET   = 'Sync_Eintraege';   // Rohdaten für App-Sync
const SHEET_KRAFT = 'Log_Kraft';
const SHEET_LAUF  = 'Log_Lauf';
const SHEET_RAD   = 'Log_Rad';
const SHEET_GEW   = 'Log_Gewicht';
const SHEET_KW    = 'Uebersicht_KW';

// ── GET: Daten exportieren ─────────────────────────────────
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';

  if (action === 'export') {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(RAW_SHEET);
    if (!sheet || sheet.getLastRow() < 2) {
      return jsonResponse([]);
    }
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

    // Bestehende IDs aus Raw-Sheet laden
    const rawSheet = getOrCreate(ss, RAW_SHEET, ['id', 'json', 'gespeichert_am']);
    const existingIds = new Set();
    if (rawSheet.getLastRow() > 1) {
      rawSheet.getRange(2, 1, rawSheet.getLastRow() - 1, 1)
        .getValues().forEach(r => existingIds.add(r[0]));
    }

    const newEntries = entries.filter(e => e && e.id && !existingIds.has(e.id));

    newEntries.forEach(entry => {
      // Raw-Sheet (für App-Sync)
      rawSheet.appendRow([entry.id, JSON.stringify(entry), new Date().toISOString()]);
      // Strukturierte Sheets (für menschliche Lesbarkeit)
      writeStructured(ss, entry);
    });

    if (newEntries.length > 0) rebuildKW(ss);

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

// ── Strukturierte Sheets ───────────────────────────────────
function writeStructured(ss, entry) {
  const type = entry.type;

  if (type === 'kraft_a' || type === 'kraft_b') {
    const sh = getOrCreate(ss, SHEET_KRAFT,
      ['ID','KW','Jahr','Datum','Typ','Übung','Satz','kg','Wdh','KGW','Gefühl','Notizen']);
    (entry.exercises || []).forEach(ex => {
      (ex.sets || []).forEach((s, si) => {
        sh.appendRow([entry.id, entry.kw, entry.yr, entry.date,
          type==='kraft_a'?'Push':'Pull', ex.name, si+1,
          s.kg||'', s.reps||'', entry.kgw||'', entry.feeling||'', entry.notes||'']);
      });
    });
    return;
  }

  if (['longrun','threshold','interval','z2'].includes(type)) {
    const sh = getOrCreate(ss, SHEET_LAUF,
      ['ID','KW','Jahr','Datum','Typ','km','Zeit_min','Pace','HR_Avg','HR_Max','Knie','Notizen']);
    sh.appendRow([entry.id, entry.kw, entry.yr, entry.date, type,
      entry.km||'', entry.timeMin||'', entry.pace||'',
      entry.hrAvg||'', entry.hrMax||'', entry.knie||'', entry.notes||'']);
    return;
  }

  if (['rennrad','mtb','ebike','wandern','schwimmen','surfen'].includes(type)) {
    const sh = getOrCreate(ss, SHEET_RAD,
      ['ID','KW','Jahr','Datum','Typ','km','Zeit_min','HR_Avg','Höhenmeter','Fueling','Notizen']);
    sh.appendRow([entry.id, entry.kw, entry.yr, entry.date, type,
      entry.km||'', entry.timeMin||'', entry.hrAvg||'',
      entry.elevation||'', entry.fueling||entry.conditions||'', entry.notes||'']);
    return;
  }

  if (type === 'gewicht') {
    const sh = getOrCreate(ss, SHEET_GEW, ['ID','KW','Jahr','Datum','kg']);
    sh.appendRow([entry.id, entry.kw, entry.yr, entry.date, entry.kg||'']);
    return;
  }
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
        if (['longrun','threshold','interval','z2'].includes(e.type)) d.lauf += parseFloat(e.km)||0;
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
