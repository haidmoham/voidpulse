import pytest

from app import create_app
from app.spotify_auth import _lyrics_cache


@pytest.fixture
def app():
    app = create_app()
    app.config.update(TESTING=True)
    yield app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture(autouse=True)
def _clear_lyrics_cache():
    _lyrics_cache.clear()
    yield
    _lyrics_cache.clear()
