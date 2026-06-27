"""Tests for the /auth/spotify/lyrics proxy.

Covers the core bug this commit fixes: LRCLIB's /api/get is strict on
track + artist + album + duration. Real Spotify metadata diverges often
enough that some tracks miss while neighbors hit, producing the
"lyrics-for-first-song-only" symptom. The fix adds an /api/search fallback;
these tests pin down that the fallback fires on 404, ranks results by
duration, prefers synced over plain, and caches the resolved match.
"""

from unittest.mock import patch, MagicMock

import pytest

from app.spotify_auth import _pick_lrclib_match


# ── Fake `requests.get` plumbing ──────────────────────────────────────


def _resp(status=200, json_body=None, raise_value_error=False):
    """Build a minimal requests.Response stand-in."""
    m = MagicMock()
    m.status_code = status
    m.ok = 200 <= status < 400
    if raise_value_error:
        m.json.side_effect = ValueError("not json")
    else:
        m.json.return_value = json_body if json_body is not None else {}
    return m


def _track_params(track="Song", artist="Artist", album="Album", duration=200):
    return {
        "track":    track,
        "artist":   artist,
        "album":    album,
        "duration": str(duration),
    }


def _route(spotify_id):
    return f"/auth/spotify/lyrics/{spotify_id}"


# ── _pick_lrclib_match unit tests ─────────────────────────────────────


class TestPickLrclibMatch:
    def test_empty_returns_none(self):
        assert _pick_lrclib_match([], 200) is None
        assert _pick_lrclib_match(None, 200) is None

    def test_prefers_synced_over_plain(self):
        results = [
            {"id": 1, "duration": 200, "plainLyrics": "x"},
            {"id": 2, "duration": 999, "syncedLyrics": "[00:00.00] hi"},
        ]
        # The plain-only entry is closer in duration but the synced one wins
        # because it's the only kind the frontend can actually render.
        assert _pick_lrclib_match(results, 200)["id"] == 2

    def test_synced_pool_ranks_by_duration(self):
        results = [
            {"id": 1, "duration": 250, "syncedLyrics": "..."},
            {"id": 2, "duration": 198, "syncedLyrics": "..."},
            {"id": 3, "duration": 205, "syncedLyrics": "..."},
        ]
        assert _pick_lrclib_match(results, 200)["id"] == 2

    def test_falls_back_to_plain_when_no_synced(self):
        results = [
            {"id": 1, "duration": 300, "plainLyrics": "x"},
            {"id": 2, "duration": 201, "plainLyrics": "y"},
        ]
        assert _pick_lrclib_match(results, 200)["id"] == 2

    def test_no_target_duration_returns_first(self):
        results = [
            {"id": 1, "duration": 200, "syncedLyrics": "..."},
            {"id": 2, "duration": 200, "syncedLyrics": "..."},
        ]
        assert _pick_lrclib_match(results, None)["id"] == 1

    def test_missing_duration_field_treated_as_zero(self):
        results = [
            {"id": 1, "syncedLyrics": "..."},                     # no duration
            {"id": 2, "duration": 195, "syncedLyrics": "..."},
        ]
        assert _pick_lrclib_match(results, 200)["id"] == 2


# ── Route-level tests ─────────────────────────────────────────────────


class TestLyricsRoute:
    def test_invalid_id_rejected(self, client):
        assert client.get(_route("not!valid")).status_code == 400
        assert client.get(_route("x" * 33)).status_code     == 400

    def test_missing_track_or_artist(self, client):
        r = client.get(_route("abc123"))   # no query params at all
        assert r.status_code == 400
        assert r.get_json()["error"] == "missing_track_or_artist"

    def test_get_success_returns_payload(self, client):
        body = {"syncedLyrics": "[00:00.00] hello", "duration": 200}
        with patch("app.spotify_auth.requests.get", return_value=_resp(200, body)) as g:
            r = client.get(_route("abc123"), query_string=_track_params())
        assert r.status_code == 200
        assert r.get_json() == body
        # /api/get only — no fallback call
        assert g.call_count == 1
        assert g.call_args.args[0].endswith("/api/get")

    def test_get_404_then_search_succeeds(self, client):
        """The whole point of this fix: when /api/get misses (e.g. album
        suffix mismatch) we retry /api/search and pick the best by duration."""
        search_results = [
            {"id": 99, "duration": 300, "syncedLyrics": "[00:00.00] far"},
            {"id": 42, "duration": 201, "syncedLyrics": "[00:00.00] close"},
            {"id": 17, "duration": 198, "syncedLyrics": "[00:00.00] also close"},
        ]
        responses = [_resp(404), _resp(200, search_results)]
        with patch("app.spotify_auth.requests.get", side_effect=responses) as g:
            r = client.get(_route("abc123"), query_string=_track_params(duration=200))
        assert r.status_code == 200
        assert r.get_json()["id"] == 42      # closest by duration
        # First call is /api/get, second is /api/search (no album/duration)
        assert g.call_args_list[0].args[0].endswith("/api/get")
        assert g.call_args_list[1].args[0].endswith("/api/search")
        search_params = g.call_args_list[1].kwargs["params"]
        assert "album_name" not in search_params
        assert "duration"   not in search_params

    def test_search_fallback_prefers_synced(self, client):
        search_results = [
            {"id": 1, "duration": 200, "plainLyrics": "no sync"},
            {"id": 2, "duration": 240, "syncedLyrics": "[00:00.00] sync"},
        ]
        with patch("app.spotify_auth.requests.get",
                   side_effect=[_resp(404), _resp(200, search_results)]):
            r = client.get(_route("abc123"), query_string=_track_params(duration=200))
        assert r.status_code == 200
        assert r.get_json()["id"] == 2

    def test_search_fallback_empty_returns_404(self, client):
        with patch("app.spotify_auth.requests.get",
                   side_effect=[_resp(404), _resp(200, [])]):
            r = client.get(_route("abc123"), query_string=_track_params())
        assert r.status_code == 404
        assert r.get_json()["error"] == "not_found"

    def test_search_fallback_500_returns_404(self, client):
        """Search endpoint failing shouldn't bubble as 500 — cache the miss."""
        with patch("app.spotify_auth.requests.get",
                   side_effect=[_resp(404), _resp(500)]):
            r = client.get(_route("abc123"), query_string=_track_params())
        assert r.status_code == 404

    def test_search_fallback_handles_request_exception(self, client):
        """A network exception during the fallback shouldn't 502 the
        original 404 — fall through to the cached miss path."""
        import requests
        with patch("app.spotify_auth.requests.get",
                   side_effect=[_resp(404), requests.ConnectionError("boom")]):
            r = client.get(_route("abc123"), query_string=_track_params())
        assert r.status_code == 404

    def test_cache_hit_short_circuits_outbound_calls(self, client):
        body = {"syncedLyrics": "[00:00.00] cached"}
        with patch("app.spotify_auth.requests.get", return_value=_resp(200, body)) as g:
            client.get(_route("abc123"), query_string=_track_params())
            client.get(_route("abc123"), query_string=_track_params())
        assert g.call_count == 1   # second hit served from cache

    def test_cache_hit_404_returns_404(self, client):
        with patch("app.spotify_auth.requests.get",
                   side_effect=[_resp(404), _resp(200, [])]) as g:
            r1 = client.get(_route("abc123"), query_string=_track_params())
            r2 = client.get(_route("abc123"), query_string=_track_params())
        assert r1.status_code == 404 and r2.status_code == 404
        # First request did get+search (2 calls); second was cached.
        assert g.call_count == 2

    def test_different_track_ids_dont_share_cache(self, client):
        """The exact bug pattern: song A succeeds, song B misses. B's miss
        must not poison A's cache, and A's success must not leak to B."""
        # Song A hits cleanly
        with patch("app.spotify_auth.requests.get",
                   return_value=_resp(200, {"syncedLyrics": "A"})):
            a = client.get(_route("songA00"), query_string=_track_params(track="A"))
        # Song B misses on /api/get and search returns nothing
        with patch("app.spotify_auth.requests.get",
                   side_effect=[_resp(404), _resp(200, [])]):
            b = client.get(_route("songB00"), query_string=_track_params(track="B"))
        # Song C hits cleanly — proves the prior miss didn't sticky-fail later lookups
        with patch("app.spotify_auth.requests.get",
                   return_value=_resp(200, {"syncedLyrics": "C"})):
            c = client.get(_route("songC00"), query_string=_track_params(track="C"))
        assert a.status_code == 200 and a.get_json()["syncedLyrics"] == "A"
        assert b.status_code == 404
        assert c.status_code == 200 and c.get_json()["syncedLyrics"] == "C"

    def test_lrclib_unreachable_502(self, client):
        import requests
        with patch("app.spotify_auth.requests.get",
                   side_effect=requests.ConnectionError("boom")):
            r = client.get(_route("abc123"), query_string=_track_params())
        assert r.status_code == 502
        assert r.get_json()["error"] == "lrclib_unreachable"

    def test_lrclib_500_returns_502(self, client):
        with patch("app.spotify_auth.requests.get", return_value=_resp(500)):
            r = client.get(_route("abc123"), query_string=_track_params())
        assert r.status_code == 502

    def test_malformed_json_from_get(self, client):
        with patch("app.spotify_auth.requests.get",
                   return_value=_resp(200, raise_value_error=True)):
            r = client.get(_route("abc123"), query_string=_track_params())
        assert r.status_code == 502
        assert r.get_json()["error"] == "lrclib_bad_response"

    def test_duration_param_not_forwarded_when_blank(self, client):
        """Frontend may omit duration on tracks where Spotify hasn't reported
        one yet — make sure we don't send a stray empty-string param."""
        with patch("app.spotify_auth.requests.get",
                   return_value=_resp(200, {"syncedLyrics": "ok"})) as g:
            client.get(_route("abc123"),
                       query_string={"track": "T", "artist": "A"})
        sent = g.call_args.kwargs["params"]
        assert "duration"   not in sent
        assert "album_name" not in sent
