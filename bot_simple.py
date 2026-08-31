"""
Telegram-Bot ohne MCP – läuft auf Python 3.9+.
Ruft Strava direkt per HTTP ab und gibt die Daten als Kontext an Claude.
"""
import asyncio, json, logging, os, time, urllib.request, urllib.parse
from datetime import datetime, timezone

from anthropic import Anthropic
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

load_dotenv()

logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s: %(message)s", level=logging.INFO)
log = logging.getLogger(__name__)

log.info("ENV VARS: %s", [k for k in os.environ if 'TELEGRAM' in k or 'ANTHROPIC' in k or 'STRAVA' in k])

BOT_TOKEN   = os.environ["TELEGRAM_BOT_TOKEN"]
ALLOWED_UID = int(os.environ["TELEGRAM_ALLOWED_USER_ID"])
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

client = Anthropic(api_key=ANTHROPIC_KEY)

# ── Konversations-History ─────────────────────────────────
histories: dict[int, list] = {}
MAX_HISTORY = 10

# ── Strava ────────────────────────────────────────────────
TOKENS_FILE = os.path.join(os.path.dirname(__file__), ".tokens.json")
CLIENT_ID     = os.environ.get("STRAVA_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("STRAVA_CLIENT_SECRET", "")

def _load_tokens() -> dict:
    if os.path.exists(TOKENS_FILE):
        with open(TOKENS_FILE) as f:
            return json.load(f)
    return {
        "access_token": os.environ.get("STRAVA_ACCESS_TOKEN", ""),
        "refresh_token": os.environ.get("STRAVA_REFRESH_TOKEN", ""),
        "expires_at": int(os.environ.get("STRAVA_TOKEN_EXPIRES_AT", 0)),
    }

def _save_tokens(tok: dict):
    with open(TOKENS_FILE, "w") as f:
        json.dump(tok, f, indent=2)

def _get_access_token() -> str:
    tok = _load_tokens()
    if tok["expires_at"] - time.time() < 300:
        # Refresh
        data = urllib.parse.urlencode({
            "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
            "refresh_token": tok["refresh_token"], "grant_type": "refresh_token"
        }).encode()
        req = urllib.request.Request("https://www.strava.com/oauth/token", data=data, method="POST")
        with urllib.request.urlopen(req) as r:
            new = json.loads(r.read())
        tok.update({"access_token": new["access_token"], "refresh_token": new["refresh_token"], "expires_at": new["expires_at"]})
        _save_tokens(tok)
    return tok["access_token"]

def _strava(path: str, params: dict = None):
    token = _get_access_token()
    url = f"https://www.strava.com/api/v3{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        log.warning("Strava API Fehler: %s", e)
        return {}

def fetch_strava_context() -> str:
    """Holt die letzten 15 Aktivitäten + Athletenprofil als Kontext-String."""
    try:
        athlete = _strava("/athlete")
        acts = _strava("/athlete/activities", {"per_page": 15})

        if not isinstance(acts, list):
            return "Strava: Keine Aktivitäten geladen."

        lines = [
            f"Athlet: {athlete.get('firstname','')} {athlete.get('lastname','')}",
            f"Gewicht: {athlete.get('weight','?')} kg",
            "",
            "Letzte Aktivitäten:"
        ]
        for a in acts:
            date = a.get("start_date_local", "")[:10]
            typ  = a.get("type", "?")
            dist = a.get("distance", 0) / 1000
            move = a.get("moving_time", 0)
            h, m = divmod(move // 60, 60)
            dur  = f"{h}h{m:02d}min" if h else f"{m}min"
            hr   = a.get("average_heartrate")
            pace_str = ""
            if dist > 0.1 and move > 0 and typ in ("Run","Walk"):
                pace_sec = move / dist
                pace_str = f" | {int(pace_sec//60)}:{int(pace_sec%60):02d}/km"
            elev = a.get("total_elevation_gain", 0)
            hr_str = f" | Ø {hr:.0f} bpm" if hr else ""
            elev_str = f" | ↑{elev:.0f}m" if elev > 5 else ""
            lines.append(f"  {date} {typ:15} {dist:.1f}km {dur}{pace_str}{hr_str}{elev_str} – {a.get('name','')}")

        return "\n".join(lines)
    except Exception as e:
        return f"Strava-Daten konnten nicht geladen werden: {e}"

# ── System-Prompt ──────────────────────────────────────────
from coach.prompts import SYSTEM_PROMPT

# ── Claude ─────────────────────────────────────────────────
def ask_claude(chat_id: int, user_msg: str) -> str:
    history = histories.setdefault(chat_id, [])

    # Strava-Kontext bei jeder Anfrage holen
    strava_ctx = fetch_strava_context()
    system_with_data = f"{SYSTEM_PROMPT}\n\n---\nAktuelle Strava-Daten (gerade abgerufen):\n{strava_ctx}"

    history.append({"role": "user", "content": user_msg})

    # History trimmen
    if len(history) > MAX_HISTORY * 2:
        history[:] = history[-(MAX_HISTORY * 2):]

    resp = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1024,
        system=system_with_data,
        messages=history,
    )
    answer = resp.content[0].text
    history.append({"role": "assistant", "content": answer})
    return answer

# ── Telegram Handler ───────────────────────────────────────
def guard(uid: int) -> bool:
    return uid == ALLOWED_UID

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not guard(update.effective_user.id): return
    await update.message.reply_text(
        "Hallo Arthur! Ich bin dein Sport-Coach 🏋️🏃🚴\n"
        "Frag mich alles über dein Training, deine Strava-Daten oder den Wochenplan."
    )

async def cmd_reset(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not guard(update.effective_user.id): return
    histories.pop(update.effective_chat.id, None)
    await update.message.reply_text("Konversation zurückgesetzt.")

async def cmd_strava(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not guard(update.effective_user.id): return
    await update.message.reply_text("Lade Strava-Daten…")
    ctx_str = fetch_strava_context()
    await update.message.reply_text(ctx_str[:4000])

async def on_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not guard(update.effective_user.id): return
    msg = update.message.text or ""
    if not msg.strip(): return

    await update.message.chat.send_action("typing")
    try:
        answer = await asyncio.get_event_loop().run_in_executor(
            None, ask_claude, update.effective_chat.id, msg
        )
    except Exception as e:
        log.exception("Claude-Fehler")
        answer = f"Fehler: {e}"

    # Lange Antworten aufteilen
    for i in range(0, len(answer), 4000):
        await update.message.reply_text(answer[i:i+4000])

# ── Main ───────────────────────────────────────────────────
def main():
    log.info("Bot startet…")
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start",  cmd_start))
    app.add_handler(CommandHandler("reset",  cmd_reset))
    app.add_handler(CommandHandler("strava", cmd_strava))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message))
    log.info("Bot läuft. Sende eine Nachricht auf Telegram.")
    app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    main()
