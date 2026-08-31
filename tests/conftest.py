"""
Shared pytest fixtures and import-time environment for the Bloombot test suite.

Several modules under test do real work at import time — they load `.env`, build
an OpenAI client, open the SQLite database and read `bot_config.yml`. The env
vars below give those imports harmless values so the suite runs on a clean
checkout and in CI with no credentials and no developer database. They are set
before any test module is imported, which is why they live at module scope here
rather than in a fixture.
"""

import os
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

# These are set unconditionally, NOT with setdefault: a developer's .env is
# already loaded into the environment by the time pytest starts, and inheriting
# it would point the suite at real credentials and the real message database.
# `load_dotenv()` does not override existing vars, so assigning here wins over
# the .env that the modules under test load at import.

# Dummy credentials: constructing an OpenAI client requires a key to be present,
# but no network call is made at construction and no test performs one.
os.environ["OPENAI_API_KEY"] = "test-key-not-used"
os.environ["BOT_TOKEN"] = "test-token-not-used"

# Point the database and the logs at a throwaway directory so the suite never
# touches data/data.db or logs/ in the working tree.
_TMP = Path(tempfile.mkdtemp(prefix="bloombot-tests-"))
os.environ["SQL_LITE_DB_PATH"] = str(_TMP / "test.db")
os.environ["LOGS_DIR"] = str(_TMP / "logs")

import pytest  # noqa: E402  (import after the env is prepared)


@pytest.fixture
def courses():
    """A two-course configuration shaped exactly like bot_config.yml, covering
    both the plain-string and the dict-with-channels category formats."""
    return [
        {
            "title": "Web Design",
            "file_prefix": "wd",
            "openai_assistant": {
                "prompt_id": "pmpt_web_design",
                "vector_store_id": "vs_web_design",
                "model": "gpt-4.1",
                "limits": {"max_requests_per_day": 20},
            },
            "roles": {"admins": "admins-wd-su26", "students": "students-wd-su26"},
            "categories": [
                {
                    "name": "Web Design - GLOBAL",
                    "channels": [
                        {"name": "admins", "admins_only": True},
                        {"name": "general"},
                    ],
                },
                "Web Design - STUDENTS 01",
            ],
        },
        {
            "title": "Introduction to Programming",
            "file_prefix": "py",
            "openai_assistant": {
                "prompt_id": "pmpt_python",
                "vector_store_id": "vs_python",
                "model": "gpt-4.1",
                "limits": {"max_requests_per_day": 20},
            },
            "roles": {"admins": "admins-py-su26", "students": "students-py-su26"},
            "categories": ["Python - GLOBAL", "Python - STUDENTS 01"],
        },
    ]
