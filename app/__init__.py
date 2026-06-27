import os
import subprocess
import time
from datetime import timedelta


def _git_short_sha() -> str:
    sha = os.environ.get("RAILWAY_GIT_COMMIT_SHA", "")
    if sha:
        return sha[:7]
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return "unknown"

from flask import Flask
from flask_compress import Compress

from .routes import bp
from .spotify_auth import spotify_bp


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.config["SECRET_KEY"]                 = os.environ.get("FLASK_SECRET_KEY", "dev-secret-change-me")
    app.config["APP_VERSION"]                = os.environ.get("APP_VERSION", "1.0")
    _ts  = str(int(time.time()))
    _sha = _git_short_sha()
    app.config["ASSET_VERSION"] = os.environ.get("APP_VERSION", _ts)
    app.config["BUILD_SHA"]     = _sha
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)

    # Spotify OAuth — leave blank to disable the Spotify source.
    # Create an app at https://developer.spotify.com/dashboard and add
    # `${YOUR_BASE_URL}/auth/spotify/callback` to its allowed redirect URIs.
    app.config["SPOTIFY_CLIENT_ID"]     = os.environ.get("SPOTIFY_CLIENT_ID", "")
    app.config["SPOTIFY_CLIENT_SECRET"] = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
    app.config["SPOTIFY_REDIRECT_URI"]  = os.environ.get(
        "SPOTIFY_REDIRECT_URI",
        "http://127.0.0.1:5000/auth/spotify/callback",
    )

    Compress(app)
    app.register_blueprint(bp)
    app.register_blueprint(spotify_bp)
    return app
