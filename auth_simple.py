"""Minimale Strava-Auth ohne externe Libraries – nur Python-Standardbibliothek."""
import json, urllib.request, urllib.parse, webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

CLIENT_ID     = "275889"
CLIENT_SECRET = "9779763706435e95cd20908a22f785f6a2b55e22"
PORT          = 8282
REDIRECT_URI  = f"http://localhost:{PORT}/callback"
SCOPE         = "read,activity:read_all,profile:read_all"

class Handler(BaseHTTPRequestHandler):
    code = None
    def do_GET(self):
        if self.path.startswith("/callback"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            Handler.code = (qs.get("code") or [None])[0]
            self.send_response(200); self.end_headers()
            self.wfile.write(b"<h1>Fertig! Dieses Fenster kann geschlossen werden.</h1>")
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a): pass

url = (f"https://www.strava.com/oauth/authorize"
       f"?client_id={CLIENT_ID}&response_type=code"
       f"&redirect_uri={REDIRECT_URI}&approval_prompt=force&scope={SCOPE}")

print("Browser öffnet Strava-Autorisierung...")
webbrowser.open(url)

srv = HTTPServer(("localhost", PORT), Handler)
print(f"Warte auf Callback auf Port {PORT}...")
while Handler.code is None:
    srv.handle_request()

print(f"Code erhalten: {Handler.code[:8]}...")

data = urllib.parse.urlencode({
    "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
    "code": Handler.code, "grant_type": "authorization_code"
}).encode()

req = urllib.request.Request("https://www.strava.com/oauth/token",
                              data=data, method="POST")
with urllib.request.urlopen(req) as resp:
    tok = json.loads(resp.read())

tokens = {"access_token": tok["access_token"],
          "refresh_token": tok["refresh_token"],
          "expires_at": tok["expires_at"]}

with open(".tokens.json", "w") as f:
    json.dump(tokens, f, indent=2)

print(f"\nAuthentifiziert als {tok['athlete']['firstname']} {tok['athlete']['lastname']}")
print(f"Access Token: {tok['access_token'][:12]}...")
print("Tokens gespeichert in .tokens.json")
