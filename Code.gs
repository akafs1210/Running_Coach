/**
 * Google Apps Script – Training Tracker Backend
 * Empfängt POST-Requests von der Trainings-App und schreibt Einträge in Google Sheets.
 *
 * Deployment:
 * 1. Neues Google Sheet erstellen
 * 2. Erweiterungen → Apps Script → diesen Code einfügen
 * 3. Bereitstellen → Neue Bereitstellung → Web-App
 *    - Ausführen als: Ich selbst
 *    - Zugriff: Jeder
 * 4. Bereitgestellte URL in die Trainings-App eintragen
 */

const SHEET_NAME_KRAFT  = 'Log_Kraft';
const SHEET_NAME_LAUF   = 'Log_Lauf';
const SHEET_NAME_RAD    = 'Log_Rad';
const SHEET_NAME_GEWICHT = 'Log_Gewicht';
const SHEET_NAME_UEBERSICHT = 'Übersicht_KW';

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const payload = JSON.parse(e.postData.contents);
    const entries = payload.entries || [];

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    entries.forEach(entry => {
      try {
        writeEntry(ss, entry);
      } catch(err) {
        Logger.log('Fehler bei Eintrag ' + entry.id + ': ' + err);
      }
    });

    rebuildUebersicht(ss);

    return ContentService.createTextOutput(JSON.stringify({ok:true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ok:false, error: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ok:true}))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length)
        .setBackground('#1a1a2e').setFontColor('#ffffff').setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function entryExists(sheet, id) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) return true;
  }
  return false;
}

function writeEntry(ss, entry) {
  const type = entry.type;

  if (type === 'kraft_a' || type === 'kraft_b') {
    const sheet = getOrCreateSheet(ss, SHEET_NAME_KRAFT, [
      'ID','KW','Jahr','Datum','Typ','Übung','Satz','kg','Wdh/m/Sek','KGW','Gefühl','Notizen'
    ]);
    if (entryExists(sheet, entry.id)) return;
    const exercises = entry.exercises || [];
    exercises.forEach(ex => {
      (ex.sets || []).forEach((s, si) => {
        sheet.appendRow([
          entry.id, entry.kw, entry.yr, entry.date,
          type === 'kraft_a' ? 'Push' : 'Pull',
          ex.name, si+1, s.kg||'', s.reps||'',
          entry.kgw||'', entry.feeling||'', entry.notes||''
        ]);
      });
    });
    return;
  }

  if (['longrun','threshold','interval','z2'].includes(type)) {
    const sheet = getOrCreateSheet(ss, SHEET_NAME_LAUF, [
      'ID','KW','Jahr','Datum','Typ','km','Zeit_min','Pace','HR_Avg','HR_Max','Knie','Temp','Notizen'
    ]);
    if (entryExists(sheet, entry.id)) return;
    sheet.appendRow([
      entry.id, entry.kw, entry.yr, entry.date, type,
      entry.km||'', entry.timeMin||'', entry.pace||'',
      entry.hrAvg||'', entry.hrMax||'', entry.knie||'', entry.temp||'', entry.notes||''
    ]);
    return;
  }

  if (['rennrad','mtb','ebike','wandern','schwimmen','surfen'].includes(type)) {
    const sheet = getOrCreateSheet(ss, SHEET_NAME_RAD, [
      'ID','KW','Jahr','Datum','Typ','km','Zeit_min','HR_Avg','Höhenmeter','Fueling','Notizen'
    ]);
    if (entryExists(sheet, entry.id)) return;
    sheet.appendRow([
      entry.id, entry.kw, entry.yr, entry.date, type,
      entry.km||'', entry.timeMin||'', entry.hrAvg||'',
      entry.elevation||'', entry.fueling||entry.conditions||'', entry.notes||''
    ]);
    return;
  }

  if (type === 'gewicht') {
    const sheet = getOrCreateSheet(ss, SHEET_NAME_GEWICHT, [
      'ID','KW','Jahr','Datum','kg'
    ]);
    if (entryExists(sheet, entry.id)) return;
    sheet.appendRow([entry.id, entry.kw, entry.yr, entry.date, entry.kg||'']);
    return;
  }
}

function rebuildUebersicht(ss) {
  const sheet = getOrCreateSheet(ss, SHEET_NAME_UEBERSICHT, [
    'KW','Jahr','Gewicht_Avg','Lauf_km_Ist','Rad_km_Ist','Kraft_Einheiten'
  ]);

  // Collect data from all log sheets
  const kwData = {};

  function ensureKW(kw, yr) {
    const key = `${yr}-${String(kw).padStart(2,'0')}`;
    if (!kwData[key]) kwData[key] = {kw, yr, weights:[], laufKm:0, radKm:0, kraft:0};
    return kwData[key];
  }

  const laufSheet = ss.getSheetByName(SHEET_NAME_LAUF);
  if (laufSheet) {
    const rows = laufSheet.getDataRange().getValues().slice(1);
    rows.forEach(r => {
      const kw = r[1], yr = r[2], km = parseFloat(r[5])||0;
      if (kw && yr) ensureKW(kw,yr).laufKm += km;
    });
  }

  const radSheet = ss.getSheetByName(SHEET_NAME_RAD);
  if (radSheet) {
    const rows = radSheet.getDataRange().getValues().slice(1);
    rows.forEach(r => {
      const kw = r[1], yr = r[2], km = parseFloat(r[5])||0;
      if (kw && yr) ensureKW(kw,yr).radKm += km;
    });
  }

  const kraftSheet = ss.getSheetByName(SHEET_NAME_KRAFT);
  if (kraftSheet) {
    // Count unique entry IDs per KW
    const rows = kraftSheet.getDataRange().getValues().slice(1);
    const seen = {};
    rows.forEach(r => {
      const id = r[0], kw = r[1], yr = r[2];
      if (kw && yr) {
        const key = `${yr}-${kw}-${id}`;
        if (!seen[key]) { seen[key] = true; ensureKW(kw,yr).kraft++; }
      }
    });
  }

  const gewichtSheet = ss.getSheetByName(SHEET_NAME_GEWICHT);
  if (gewichtSheet) {
    const rows = gewichtSheet.getDataRange().getValues().slice(1);
    rows.forEach(r => {
      const kw = r[1], yr = r[2], kg = parseFloat(r[4]);
      if (kw && yr && !isNaN(kg)) ensureKW(kw,yr).weights.push(kg);
    });
  }

  // Rebuild overview sheet (clear data rows, keep header)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow-1);

  const keys = Object.keys(kwData).sort();
  keys.forEach(key => {
    const d = kwData[key];
    const avgW = d.weights.length ? (d.weights.reduce((a,b)=>a+b,0)/d.weights.length).toFixed(1) : '';
    sheet.appendRow([d.kw, d.yr, avgW, d.laufKm.toFixed(1), d.radKm.toFixed(1), d.kraft]);
  });
}
