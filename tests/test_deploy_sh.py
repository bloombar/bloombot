"""
Tests for scripts/deploy.sh (OPS-7).

The script is exercised for real — bash, git and node all run — against a
throwaway pair of git repositories in a temp directory. Only the two commands
that would touch a live machine are faked: `pm2` and `pipenv` are replaced by
stub executables on PATH that record how they were called, and the "interpreter
pm2 uses" is a stub whose exit code the test controls. Nothing here reaches the
network or the droplet.
"""

import os
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
DEPLOY_SH = REPO_ROOT / "scripts" / "deploy.sh"

# The stubs are plain bash so they behave identically on a developer machine and
# on the CI runner. Each records its arguments so a test can assert on them.

PM2_STUB = """#!/usr/bin/env bash
echo "$*" >> "$PM2_CALLS"
case "${1:-}" in
  jlist)
    # Which apps pm2 knows is per-app, not global: `start --only X` teaches it
    # exactly one. Modelling it as a single flag made a first deploy look like
    # it reloaded five apps it had never heard of. PM2_STATUS and the restart
    # counter apply to every known app, which keeps the crash-loop tests
    # meaning what they always did.
    n=$(cat "$PM2_COUNTER" 2>/dev/null || echo 0)
    printf '%s' "$((n + ${PM2_RESTART_STEP:-0}))" > "$PM2_COUNTER"
    sep=''
    printf '['
    while read -r app; do
      [ -n "$app" ] || continue
      printf '%s{"name":"%s","pm2_env":{"status":"%s","restart_time":%s}}' \\
        "$sep" "$app" "${PM2_STATUS:-online}" "$n"
      sep=','
    done < <(cat "$PM2_REGISTERED" 2>/dev/null)
    printf ']\\n'
    ;;
  start)
    # `pm2 start ecosystem.config.cjs --only <name>`
    for arg in "$@"; do
      case "$prev" in --only) echo "$arg" >> "$PM2_REGISTERED" ;; esac
      prev="$arg"
    done
    ;;
esac
exit 0
"""

PIPENV_STUB = """#!/usr/bin/env bash
echo "$*" >> "$PIPENV_CALLS"
if [ "${1:-}" = "--venv" ]; then
  if [ "${FAKE_PIPENV_VENV:-0}" = "1" ]; then
    # Real pipenv prints its banner to stderr and only the path to stdout.
    echo "loading .env environment variables..." >&2
    echo "$FAKE_VENV"
    exit 0
  fi
  exit 1
fi
exit 0
"""

# The platform's own half of the deploy. This suite predates it — `deploy.sh`
# used to touch nothing but the Python bot — so without these stubs every test
# here fails on `npm ci` looking for a package.json the fake droplet never had.
# Recording their arguments also lets a test assert the panel is rebuilt, which
# is a real bug this deploy script shipped once: nginx served a stale panel
# against a freshly reloaded API.
NPM_STUB = """#!/usr/bin/env bash
echo "$*" >> "$NPM_CALLS"
exit "${FAKE_NPM_EXIT:-0}"
"""

# `node` has two very different jobs in this script, and a stub that treats
# them alike breaks the suite in a way that looks like a deploy failure:
# `pm2_field` pipes `pm2 jlist` through `node -e` to parse it, so stubbing
# every invocation makes every app's status read "unknown" and rolls back a
# perfectly good deploy. Only the migration run (a script path) is stubbed;
# `-e` is handed to the real interpreter.
NODE_STUB = """#!/usr/bin/env bash
if [ "${1:-}" = "-e" ]; then
  exec "$REAL_NODE" "$@"
fi
echo "$*" >> "$NODE_CALLS"
exit "${FAKE_NODE_EXIT:-0}"
"""

# Stands in for the interpreter pm2 runs the bot with. `-m pip ...` always
# succeeds; the dependency import check (which reads a script on stdin) exits
# with FAKE_PY_EXIT so a test can simulate missing dependencies.
PYTHON_STUB = """#!/usr/bin/env bash
echo "$*" >> "$PYTHON_CALLS"
if [ "${1:-}" = "-m" ]; then
  exit 0
fi
cat > /dev/null
exit "${FAKE_PY_EXIT:-0}"
"""


def _git(cwd, *args):
    """Run a git command, failing the test loudly if it errors."""
    return subprocess.run(
        ["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True
    ).stdout.strip()


def _write_stub(path, body):
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


@pytest.fixture
def world(tmp_path):
    """A fake droplet: an upstream repo with three commits, a checkout sitting on
    the first one, stub executables, and the environment deploy.sh runs under."""
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    _git(upstream, "init", "-q")
    _git(upstream, "config", "user.email", "test@example.com")
    _git(upstream, "config", "user.name", "Test")
    _git(upstream, "config", "commit.gpgsign", "false")

    (upstream / "requirements.txt").write_text("discord==2.7.1\n", encoding="utf-8")
    (upstream / "Pipfile.lock").write_text('{"_meta": {}}\n', encoding="utf-8")
    (upstream / "ecosystem.config.cjs").write_text("module.exports = {};\n", encoding="utf-8")
    # The real droplet is an npm workspace as well as a Python checkout, and
    # `deploy.sh` now builds it; without this the script aborts before it ever
    # reaches the part these tests are about.
    (upstream / "package.json").write_text(
        '{"name": "bloombot", "private": true}\n', encoding="utf-8"
    )
    (upstream / "response_bot.py").write_text("print('v1')\n", encoding="utf-8")
    _git(upstream, "add", "-A")
    _git(upstream, "commit", "-qm", "first")
    first = _git(upstream, "rev-parse", "HEAD")

    # A code-only change: no dependency install should happen for this one.
    (upstream / "response_bot.py").write_text("print('v2')\n", encoding="utf-8")
    _git(upstream, "add", "-A")
    _git(upstream, "commit", "-qm", "code only")
    code_only = _git(upstream, "rev-parse", "HEAD")

    # A change that touches the lock file: this one must install dependencies.
    (upstream / "Pipfile.lock").write_text('{"_meta": {"changed": true}}\n', encoding="utf-8")
    _git(upstream, "add", "-A")
    _git(upstream, "commit", "-qm", "bump deps")
    deps_bump = _git(upstream, "rev-parse", "HEAD")

    app = tmp_path / "app"
    _git(tmp_path, "clone", "-q", str(upstream), str(app))
    _git(app, "config", "user.email", "test@example.com")
    _git(app, "config", "user.name", "Test")
    _git(app, "reset", "--hard", "-q", first)

    # Untracked files the deploy must never disturb: the real droplet's secrets,
    # message database and logs live exactly like this.
    (app / ".env").write_text("BOT_TOKEN=real-secret\n", encoding="utf-8")
    (app / "data").mkdir()
    (app / "data" / "data.db").write_text("student messages\n", encoding="utf-8")

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_stub(bin_dir / "pm2", PM2_STUB)
    _write_stub(bin_dir / "pipenv", PIPENV_STUB)
    _write_stub(bin_dir / "python3", PYTHON_STUB)
    _write_stub(bin_dir / "npm", NPM_STUB)
    _write_stub(bin_dir / "node", NODE_STUB)

    # A directory shaped like a pipenv virtualenv, so the script's "is there a
    # virtualenv here?" probe — which requires an executable bin/python — can
    # succeed the same way it does on the droplet.
    fake_venv = tmp_path / "fakevenv"
    (fake_venv / "bin").mkdir(parents=True)
    _write_stub(fake_venv / "bin" / "python", PYTHON_STUB)

    # A minimal PATH: the stubs first, then only the directories holding the real
    # tools the script genuinely uses. Anything else on the developer's PATH is
    # excluded so the tests behave the same everywhere.
    real_dirs = []
    for tool in ("git", "node", "bash", "cat", "sleep"):
        found = shutil.which(tool)
        if found:
            parent = str(Path(found).parent)
            if parent not in real_dirs:
                real_dirs.append(parent)
    path = os.pathsep.join([str(bin_dir), *real_dirs, "/usr/bin", "/bin"])

    state = tmp_path / "state"
    state.mkdir()
    registered = state / "registered"
    # pm2 already knows every supervised app, as on a live droplet.
    registered.write_text(
        "bloombot\napi\nbot\nworker\nmcp\nops-monitor\n", encoding="utf-8"
    )

    env = {
        "PATH": path,
        "HOME": str(tmp_path),
        "APP_DIR": str(app),
        "PM2_APP": "bloombot",
        "PM2_INTERPRETER": str(bin_dir / "python3"),
        "HEALTH_WAIT": "0",
        "PM2_CALLS": str(state / "pm2.log"),
        "PM2_COUNTER": str(state / "restarts"),
        "PM2_REGISTERED": str(registered),
        "PM2_RESTART_STEP": "0",
        "PM2_STATUS": "online",
        "PIPENV_CALLS": str(state / "pipenv.log"),
        "PYTHON_CALLS": str(state / "python.log"),
        "NPM_CALLS": str(state / "npm.log"),
        "NODE_CALLS": str(state / "node.log"),
        "REAL_NODE": shutil.which("node") or "node",
        "FAKE_PIPENV_VENV": "0",
        "FAKE_VENV": str(fake_venv),
        "FAKE_PY_EXIT": "0",
    }

    def run(sha, **overrides):
        """Run deploy.sh for a commit, with optional environment overrides. An
        override of None unsets the variable, which is how a test exercises the
        script's own defaulting."""
        merged = {**env, **overrides}
        merged = {k: v for k, v in merged.items() if v is not None}
        return subprocess.run(
            ["bash", str(DEPLOY_SH), sha],
            env=merged,
            capture_output=True,
            text=True,
        )

    def calls(name):
        """Lines recorded by a stub, or [] if it was never invoked."""
        log = Path(env[f"{name.upper()}_CALLS"])
        return log.read_text(encoding="utf-8").splitlines() if log.exists() else []

    return SimpleNamespace(
        app=app,
        fake_venv=fake_venv,
        upstream=upstream,
        first=first,
        code_only=code_only,
        deps_bump=deps_bump,
        registered=registered,
        env=env,
        run=run,
        calls=calls,
        head=lambda: _git(app, "rev-parse", "HEAD"),
    )


def test_clean_deploy_moves_head_and_reloads(world):
    """The happy path: the checkout lands on the requested commit and pm2 is
    reloaded and saved."""
    result = world.run(world.code_only)

    assert result.returncode == 0, result.stderr
    assert world.head() == world.code_only
    assert (world.app / "response_bot.py").read_text(encoding="utf-8") == "print('v2')\n"
    pm2 = world.calls("pm2")
    assert "reload bloombot --update-env" in pm2
    assert "save" in pm2


def test_untracked_files_survive_a_deploy(world):
    """.env, the database and the logs are untracked and must come through a
    deploy untouched — this is why the script never runs `git clean`."""
    world.run(world.code_only)

    assert (world.app / ".env").read_text(encoding="utf-8") == "BOT_TOKEN=real-secret\n"
    assert (world.app / "data" / "data.db").read_text(encoding="utf-8") == "student messages\n"


def test_local_drift_aborts_before_anything_is_touched(world):
    """Someone edited a tracked file on the server: refuse to deploy over it."""
    (world.app / "response_bot.py").write_text("print('hand edited')\n", encoding="utf-8")

    result = world.run(world.code_only)

    assert result.returncode != 0
    assert "local modifications" in result.stderr
    assert "response_bot.py" in result.stderr
    assert world.head() == world.first
    assert (world.app / "response_bot.py").read_text(encoding="utf-8") == "print('hand edited')\n"
    assert world.calls("pm2") == []


def test_staged_drift_also_aborts(world):
    """A staged-but-uncommitted change is drift too."""
    (world.app / "new_file.py").write_text("x = 1\n", encoding="utf-8")
    _git(world.app, "add", "new_file.py")

    result = world.run(world.code_only)

    assert result.returncode != 0
    assert world.head() == world.first


def test_unknown_commit_is_rejected(world):
    """A SHA the remote does not have fails before the checkout is touched."""
    result = world.run("0" * 40)

    assert result.returncode != 0
    assert "does not exist" in result.stderr
    assert world.head() == world.first
    assert world.calls("pm2") == []


def test_missing_sha_argument_is_rejected(world):
    result = subprocess.run(
        ["bash", str(DEPLOY_SH)], env=world.env, capture_output=True, text=True
    )

    assert result.returncode != 0
    assert "usage" in result.stderr


def test_dependencies_are_not_installed_when_pinning_is_unchanged(world):
    """A code-only commit should not trigger an install."""
    result = world.run(world.code_only)

    assert result.returncode == 0
    assert "skipping install" in result.stdout
    # `pipenv --venv` is still probed to locate the bot's python; what must not
    # happen is an install through either package manager.
    assert "install --deploy" not in world.calls("pipenv")
    assert not any(call.startswith("-m pip") for call in world.calls("python"))


def test_pip_install_when_lockfile_changed_and_no_pipenv_venv(world):
    """With no pipenv virtualenv on the box, a dependency change installs with
    pip into the interpreter pm2 uses."""
    result = world.run(world.deps_bump)

    assert result.returncode == 0
    assert any(
        call.startswith("-m pip install --requirement requirements.txt")
        for call in world.calls("python")
    ), world.calls("python")


def test_pipenv_install_when_a_virtualenv_exists(world):
    """With a pipenv virtualenv present, the install goes through pipenv."""
    result = world.run(world.deps_bump, FAKE_PIPENV_VENV="1")

    assert result.returncode == 0
    assert "install --deploy" in world.calls("pipenv")
    assert not any(call.startswith("-m pip") for call in world.calls("python"))


def test_unimportable_dependencies_abort_before_restart(world):
    """If the interpreter pm2 uses cannot import the bot's dependencies, the new
    code would crash-loop. Abort with the old process still running."""
    result = world.run(world.code_only, FAKE_PY_EXIT="1")

    assert result.returncode != 0
    assert "cannot import" in result.stderr
    assert world.calls("pm2") == []  # nothing was restarted
    assert world.head() == world.first  # and the checkout was put back


def test_crash_loop_after_reload_rolls_back(world):
    """pm2 restarting the app during the health window means the new commit is
    crash-looping: restore the previous commit and fail the deploy."""
    result = world.run(world.code_only, PM2_RESTART_STEP="1")

    assert result.returncode != 0
    assert "unhealthy" in result.stderr
    assert "rolled back" in result.stderr
    assert world.head() == world.first
    pm2 = world.calls("pm2")
    assert pm2.count("reload bloombot --update-env") == 2  # deploy, then rollback
    assert any(call.startswith("logs bloombot") for call in pm2)


def test_stopped_app_after_reload_rolls_back(world):
    """A process that is not `online` after the reload is a failed deploy too."""
    result = world.run(world.code_only, PM2_STATUS="errored")

    assert result.returncode != 0
    assert "unhealthy" in result.stderr
    assert world.head() == world.first


def test_rollback_reinstalls_the_previous_dependencies(world):
    """Rolling back a commit that changed the lock file must also put the
    dependencies back."""
    result = world.run(world.deps_bump, PM2_RESTART_STEP="1", FAKE_PIPENV_VENV="1")

    assert result.returncode != 0
    assert world.head() == world.first
    # once forward, once on the way back
    assert world.calls("pipenv").count("install --deploy") == 2


def test_interpreter_defaults_to_the_pipenv_virtualenv(world):
    """The bot runs under the pipenv virtualenv, not the system python3 — which
    on the real droplet cannot import discord.py at all. With no explicit
    PM2_INTERPRETER, the script must find the virtualenv's python itself."""
    result = world.run(world.code_only, PM2_INTERPRETER=None, FAKE_PIPENV_VENV="1")

    assert result.returncode == 0, result.stderr
    assert str(world.fake_venv / "bin" / "python") in result.stdout


def test_interpreter_falls_back_to_python3_without_a_virtualenv(world):
    """On a host with no pipenv virtualenv, plain python3 is the bot's python."""
    result = world.run(world.code_only, PM2_INTERPRETER=None, FAKE_PIPENV_VENV="0")

    assert result.returncode == 0, result.stderr
    assert "python3" in result.stdout


def test_first_deploy_starts_the_app_from_the_ecosystem_config(world):
    """On a droplet where pm2 does not yet know the app, the deploy starts it
    from ecosystem.config.cjs instead of reloading."""
    world.registered.unlink()

    result = world.run(world.code_only)

    assert result.returncode == 0, result.stderr
    pm2 = world.calls("pm2")
    # `--only <name>`, one app at a time: bootstrapping a fresh droplet must
    # not start every app in the file at once, since some may not have their
    # credentials configured yet.
    assert any(
        call.startswith("start ecosystem.config.cjs --only ") for call in pm2
    ), pm2
    assert not any(call.startswith("reload") for call in pm2)
