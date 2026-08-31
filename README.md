# Arthur's Training Coach 2026/2027

KI-gestützter Multi-Sport-Coach (Strava + Telegram) und Offline-Trainings-Tracker-App.

**Ziele:** Hyrox Double · Wings for Life 21 km (10.05.2027)

---

## Was ist hier drin?

| Datei/Ordner | Beschreibung |
|---|---|
| `index.html` | Offline-Trainings-Tracker-App (GitHub Pages) |
| `Code.gs` | Google Apps Script für Sync-Backend |
| `bot.py` | Telegram-Bot (KI-Coach via Strava) |
| `cli.py` | CLI-Interface |
| `coach/` | Claude-Agent-Logik und System-Prompt |
| `strava_mcp/` | MCP-Server für Strava-Tools |

---

## Teil 1 – Trainings-Tracker App (index.html)

Single-file, offline-fähige PWA. Läuft im Browser, kein Server nötig.

**GitHub Pages:**
1. Repo → Settings → Pages → Deploy from branch: `main` / `/ (root)`
2. URL: `https://akafs1210.github.io/Running_Coach/`
3. Am iPhone: Safari → Teilen → „Zum Home-Bildschirm" → wie eine App nutzen

**Features:**
- 4 Tabs: Heute · Plan · Eintragen · Fortschritt
- 48 Wochen Trainingsplan eingebettet (KW 24/2026 – KW 19/2027)
- Kraft A (Push) + B (Pull) mit automatischer Gewichts-Vorbefüllung
- Alle Sportarten: Lauf (Threshold/Intervall/Z2/Longrun), Rennrad, MTB, Wandern, Schwimmen, Surfen
- Diagramme (Weight, Lauf-km/Woche, Rad-km/Woche) ohne externe Libraries
- HF-Zonen-Spickzettel (anpassbar)
- localStorage – funktioniert vollständig offline
- Optionaler Google Sheets Sync

**Google Sheets Sync (Code.gs):**
1. Neues Google Sheet erstellen
2. Erweiterungen → Apps Script → `Code.gs` einfügen
3. Bereitstellen → Web-App → Ausführen als: Ich selbst · Zugriff: Jeder
4. Die `/exec`-URL in der App unter Fortschritt → Sync eintragen

---

## Teil 2 – KI-Coach (Telegram Bot)

### Setup

```bash
cd Running_Coach
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Umgebungsvariablen

```bash
cp .env.example .env
# .env ausfüllen (ANTHROPIC_API_KEY, STRAVA_CLIENT_ID)
```

**Benötigt werden:**
- `ANTHROPIC_API_KEY` – https://console.anthropic.com
- `STRAVA_CLIENT_ID` – Numerische ID von https://www.strava.com/settings/api
- `STRAVA_CLIENT_SECRET` – Bereits in `.env` vorhanden
- `TELEGRAM_BOT_TOKEN` – Bereits in `.env` vorhanden
- `TELEGRAM_ALLOWED_USER_ID` – Bereits in `.env` vorhanden

### Strava-Authentifizierung (einmalig)

```bash
python auth.py
```
→ Browser öffnet sich, Strava autorisieren → Tokens werden in `.tokens.json` gespeichert.

### Bot starten

```bash
python bot.py
```

Telegram-Befehle:
| Befehl | Beschreibung |
|---|---|
| `/reset` | Konversation zurücksetzen |
| `/memory` | Gespeicherte Fakten anzeigen |
| `/clearmemory` | Fakten löschen |

---

## Deployment auf Railway (24/7)

1. Dieses Repo auf GitHub pushen
2. [railway.app](https://railway.app) → Neues Projekt → GitHub Repo verbinden
3. Database → PostgreSQL hinzufügen (für persistente Chat-History)
4. Variables hinzufügen: alle aus `.env` + Strava-Tokens aus `.tokens.json`
5. `Procfile` sagt Railway: `python bot.py`

---

## Wichtige Infos

- **Strava Client ID fehlt noch** – von https://www.strava.com/settings/api holen und in `.env` eintragen
- **HF-Zonen** basieren auf HRmax 195 bpm (Leistungsdiagnostik folgt) – in der App unter Heute → HF-Zonen anpassen
- **Übungen ändern sich** – in der App unter Eintragen den Übungsnamen antippen und direkt bearbeiten
- **Dynamisch bleiben** – die App unterstützt alle Aktivitätstypen unabhängig vom Wochenplan
