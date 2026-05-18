# Spotify OAuth + token refresh blueprint.
#
# Flow:
#   1. GET  /auth/spotify/login    → redirect to Spotify authorize URL
#   2. GET  /auth/spotify/callback → exchange code for tokens, store in session,
#                                    redirect to / with ?spotify=connected
#   3. GET  /auth/spotify/token    → frontend fetches current access token;
#                                    auto-refreshes if <60s from expiry
#   4. GET  /auth/spotify/status   → cheap auth check for UI state
#   5. POST /auth/spotify/logout   → clear session tokens
#
# Tokens live in Flask's signed-cookie session — fine for a personal app.
# Don't put real client secrets in a public deploy: Railway env vars only.

import secrets
import time
import urllib.parse

import requests
from flask import Blueprint, current_app, jsonify, redirect, request, session

spotify_bp = Blueprint("spotify", __name__, url_prefix="/auth/spotify")

SPOTIFY_AUTH_URL  = "https://accounts.spotify.com/authorize"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"

# Listening-along flow: we don't play audio in the browser. We just watch what's
# playing on the user's account (any device) and fetch the per-track audio
# analysis to drive the visualizer. Single scope is enough.
#
#   user-read-playback-state  — read currently playing track + position +
#                               play/pause state on whichever device the user
#                               is actually listening on
#
# Notably absent: `streaming` (Premium-only, was for the Web Playback SDK).
# This flow now works for free Spotify accounts.
SCOPES = "user-read-playback-state"


def _client_creds():
    return (
        current_app.config.get("SPOTIFY_CLIENT_ID", ""),
        current_app.config.get("SPOTIFY_CLIENT_SECRET", ""),
    )


def _redirect_uri():
    # Derive from the current request so one Spotify app can serve production,
    # staging, and any preview environment without per-env config. The Spotify
    # dashboard's allowlist is the source of truth for which hostnames are
    # accepted. Falls back to the configured env var only outside of a request
    # context (won't happen during OAuth, but keeps the helper safe to call).
    # Railway terminates TLS at the proxy, so trust X-Forwarded-Proto first.
    try:
        scheme = request.headers.get("X-Forwarded-Proto") or request.scheme
        return f"{scheme}://{request.host}/auth/spotify/callback"
    except RuntimeError:
        return current_app.config.get("SPOTIFY_REDIRECT_URI", "")


@spotify_bp.route("/login")
def login():
    client_id, _ = _client_creds()
    if not client_id:
        return "SPOTIFY_CLIENT_ID not configured on the server.", 500
    state = secrets.token_urlsafe(16)
    session["spotify_oauth_state"] = state
    params = {
        "response_type": "code",
        "client_id":     client_id,
        "scope":         SCOPES,
        "redirect_uri":  _redirect_uri(),
        "state":         state,
    }
    return redirect(f"{SPOTIFY_AUTH_URL}?{urllib.parse.urlencode(params)}")


@spotify_bp.route("/callback")
def callback():
    code  = request.args.get("code")
    state = request.args.get("state")
    error = request.args.get("error")

    if error:
        return redirect(f"/?spotify_error={urllib.parse.quote(error)}")

    expected_state = session.pop("spotify_oauth_state", None)
    if not state or state != expected_state:
        return "Spotify OAuth state mismatch.", 400
    if not code:
        return "Spotify callback missing code.", 400

    client_id, client_secret = _client_creds()
    r = requests.post(
        SPOTIFY_TOKEN_URL,
        data={
            "grant_type":   "authorization_code",
            "code":         code,
            "redirect_uri": _redirect_uri(),
        },
        auth=(client_id, client_secret),
        timeout=10,
    )
    if not r.ok:
        return f"Token exchange failed: {r.text}", 500

    tokens = r.json()
    session["spotify_access_token"]     = tokens["access_token"]
    session["spotify_refresh_token"]    = tokens.get("refresh_token", "")
    session["spotify_token_expires_at"] = time.time() + tokens["expires_in"]
    session.permanent = True
    return redirect("/?spotify=connected")


def _refresh_if_needed() -> bool:
    """Refresh the access token if it's within 60s of expiring. Returns True
    if a usable token now sits in the session, False if the user must re-auth."""
    if "spotify_access_token" not in session:
        return False
    if time.time() < session.get("spotify_token_expires_at", 0) - 60:
        return True

    refresh = session.get("spotify_refresh_token")
    if not refresh:
        return False
    client_id, client_secret = _client_creds()
    r = requests.post(
        SPOTIFY_TOKEN_URL,
        data={"grant_type": "refresh_token", "refresh_token": refresh},
        auth=(client_id, client_secret),
        timeout=10,
    )
    if not r.ok:
        return False
    tokens = r.json()
    session["spotify_access_token"]     = tokens["access_token"]
    session["spotify_token_expires_at"] = time.time() + tokens["expires_in"]
    # Spotify sometimes rotates the refresh token; only update if returned.
    if "refresh_token" in tokens:
        session["spotify_refresh_token"] = tokens["refresh_token"]
    return True


@spotify_bp.route("/token")
def token():
    """Frontend pulls the access token from here. Refreshes transparently."""
    if not _refresh_if_needed():
        return jsonify({"error": "not_authenticated"}), 401
    return jsonify({
        "access_token": session["spotify_access_token"],
        "expires_at":   session["spotify_token_expires_at"],
    })


@spotify_bp.route("/status")
def status():
    """Cheap auth + server-config check. Frontend uses this to decide whether
    the spotify source button should show 'connect' or activate immediately."""
    client_id, _ = _client_creds()
    return jsonify({
        "authenticated": "spotify_access_token" in session,
        "configured":    bool(client_id),
    })


@spotify_bp.route("/logout", methods=["POST"])
def logout():
    for k in ("spotify_access_token", "spotify_refresh_token", "spotify_token_expires_at"):
        session.pop(k, None)
    return jsonify({"ok": True})


# ── ReccoBeats audio-features proxy ──────────────────────────────────
# Spotify killed /v1/audio-analysis + /v1/audio-features for new apps in
# Nov 2024. ReccoBeats (https://reccobeats.com) rebuilt the audio-features
# half: same field names + ranges as the deprecated Spotify endpoint
# (acousticness/danceability/energy/instrumentalness/key/liveness/loudness/
# mode/speechiness/tempo/valence). No beat/section/segment-level data —
# that side of Spotify's old API has no equivalent.
#
# Lookup is a two-step chain: Spotify track id → ReccoBeats internal UUID
# → audio features. We proxy through Flask to avoid CORS and to keep the
# chain on the backend so the frontend only sees one clean response.

# ── Demo tracks ──────────────────────────────────────────────────────────────
# Three 30-second preview snippets served to mobile visitors. Fetched via the
# iTunes Search API (no auth required, always returns preview URLs) and cached
# for 24h. Spotify's preview_url was deprecated for new apps post-2024.

_demos_cache: dict = {}   # { tracks: [...], fetched_at: float }
_DEMOS_TTL   = 86_400     # 24 hours

_DEMO_SEARCHES = [
    "Bloc Party This Modern Love",
    "Balam Pichkari Shalmali Kholgade",
    "Small Town Kid I Drift Out Then Return",
]

ITUNES_SEARCH = "https://itunes.apple.com/search"


@spotify_bp.route("/demos")
def demos():
    """Return metadata + 30-second preview URLs for the three demo tracks.
    Uses the iTunes Search API — no authentication required."""
    import time as _time
    now = _time.time()

    if _demos_cache.get("fetched_at", 0) + _DEMOS_TTL > now:
        return jsonify(_demos_cache["tracks"])

    tracks = []
    for query in _DEMO_SEARCHES:
        try:
            r = requests.get(
                ITUNES_SEARCH,
                params={"term": query, "entity": "song", "limit": 1, "country": "US"},
                timeout=8,
            )
            if not r.ok:
                continue
            results = r.json().get("results", [])
            if not results:
                continue
            item = results[0]
            preview = item.get("previewUrl")
            if not preview:
                continue
            # artworkUrl100 → swap to 300×300 for card display
            art = item.get("artworkUrl100", "").replace("100x100", "300x300")
            tracks.append({
                "title":       item.get("trackName", ""),
                "artist":      item.get("artistName", ""),
                "preview_url": preview,
                "art_url":     art,
            })
        except requests.RequestException:
            continue

    _demos_cache["tracks"]     = tracks
    _demos_cache["fetched_at"] = now
    return jsonify(tracks)


RECCOBEATS_BASE = "https://api.reccobeats.com/v1"


# ── LRCLIB synced lyrics proxy ──────────────────────────────────────
# Spotify's official Web API doesn't expose lyrics (they're licensed
# through Musixmatch for first-party clients only). LRCLIB
# (https://lrclib.net) is a free, no-auth community lyrics database that
# returns LRC-format synced lyrics ("[mm:ss.xx] line text") for most
# popular tracks. We proxy through Flask for CORS + to attach a polite
# User-Agent + to cache misses so we don't re-hit LRCLIB for every poll
# on an unindexed track.

LRCLIB_API   = "https://lrclib.net/api/get"
_LYRICS_TTL  = 24 * 3600
_LYRICS_MAX  = 256
_lyrics_cache: dict = {}   # spotify_id → (json_or_None, fetched_at)


@spotify_bp.route("/lyrics/<spotify_id>")
def lyrics(spotify_id: str):
    """Return LRCLIB lyrics data for a Spotify track id. Query params:
    track, artist (required); album, duration (recommended for accuracy).
    Cached for 24h per spotify_id; 404 misses are cached too."""
    if not spotify_id.isalnum() or len(spotify_id) > 32:
        return jsonify({"error": "invalid_id"}), 400

    now = time.time()
    cached = _lyrics_cache.get(spotify_id)
    if cached and now - cached[1] < _LYRICS_TTL:
        body = cached[0]
        if body is None:
            return jsonify({"error": "not_found"}), 404
        return jsonify(body)

    track  = request.args.get("track",  "").strip()
    artist = request.args.get("artist", "").strip()
    if not track or not artist:
        return jsonify({"error": "missing_track_or_artist"}), 400

    params = {"track_name": track, "artist_name": artist}
    album    = request.args.get("album", "").strip()
    duration = request.args.get("duration", "").strip()
    if album:    params["album_name"] = album
    if duration: params["duration"]   = duration

    try:
        r = requests.get(
            LRCLIB_API,
            params=params,
            headers={"User-Agent": "Voidpulse Visualizer (https://github.com/haidmoham/voidpulse)"},
            timeout=6,
        )
    except requests.RequestException as e:
        return jsonify({"error": "lrclib_unreachable", "detail": str(e)}), 502

    # Bound cache: evict oldest entry when full.
    if len(_lyrics_cache) >= _LYRICS_MAX:
        oldest_key = min(_lyrics_cache, key=lambda k: _lyrics_cache[k][1])
        _lyrics_cache.pop(oldest_key, None)

    if r.status_code == 404:
        _lyrics_cache[spotify_id] = (None, now)
        return jsonify({"error": "not_found"}), 404
    if not r.ok:
        return jsonify({"error": "lrclib_failed", "status": r.status_code}), 502

    try:
        data = r.json()
    except ValueError:
        return jsonify({"error": "lrclib_bad_response"}), 502
    _lyrics_cache[spotify_id] = (data, now)
    return jsonify(data)


@spotify_bp.route("/features/<spotify_id>")
def features(spotify_id: str):
    """Return ReccoBeats audio features for a Spotify track id.
    Two-step lookup hidden behind a single endpoint."""
    if not spotify_id.isalnum() or len(spotify_id) > 32:
        return jsonify({"error": "invalid_id"}), 400
    try:
        lookup = requests.get(
            f"{RECCOBEATS_BASE}/track",
            params={"ids": spotify_id},
            timeout=4,
        )
        if not lookup.ok:
            return jsonify({"error": "reccobeats_lookup_failed", "status": lookup.status_code}), 502
        content = lookup.json().get("content", [])
        if not content:
            # Track isn't in ReccoBeats' catalog (rare for popular tracks,
            # common for obscure / regional / very new ones).
            return jsonify({"error": "track_not_indexed"}), 404
        recco_id = content[0]["id"]

        feats = requests.get(
            f"{RECCOBEATS_BASE}/track/{recco_id}/audio-features",
            timeout=4,
        )
        if not feats.ok:
            return jsonify({"error": "reccobeats_features_failed", "status": feats.status_code}), 502
        return jsonify(feats.json())
    except requests.RequestException as e:
        return jsonify({"error": "reccobeats_unreachable", "detail": str(e)}), 502
