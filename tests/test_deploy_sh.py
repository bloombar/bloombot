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
      # OPS-16 — every app's own pm_cwd, defaulting to this deploy's own
      # APP_DIR (a real pm2 records the cwd it was started from, and every
      # process this deploy itself starts runs from there) unless
      # PM2_CWD_OVERRIDES names this app explicitly — how a test seeds an
      # old name pm2 knows that is NOT this deploy's own.
      cwd="$APP_DIR"
      if [ -n "${PM2_CWD_OVERRIDES:-}" ] && [ -f "$PM2_CWD_OVERRIDES" ]; then
        override=$(awk -v n="$app" '$1==n{print $2; exit}' "$PM2_CWD_OVERRIDES")
        [ -n "$override" ] && cwd="$override"
      fi
      printf '%s{"name":"%s","pm2_env":{"status":"%s","restart_time":%s,"pm_cwd":"%s"}}' \\
        "$sep" "$app" "${PM2_STATUS:-online}" "$n" "$cwd"
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
  delete)
    # OPS-16 — `pm2 delete <name>`, the migration's own delete half.
    # FAKE_PM2_DELETE_FAIL names the one process this stub refuses to
    # delete EVERY time (the permanent shape); FAKE_PM2_DELETE_FAIL_ONCE
    # names one that refuses only its first call, then succeeds — a
    # transient failure the rollback path's own retry recovers from.
    # Anything else is removed from PM2_REGISTERED so a later `jlist`
    # reflects it as gone.
    name="${2:-}"
    if [ "${FAKE_PM2_DELETE_FAIL:-}" = "$name" ]; then
      exit 1
    fi
    if [ "${FAKE_PM2_DELETE_FAIL_ONCE:-}" = "$name" ] && [ ! -f "${PM2_DELETE_ONCE_MARKER:-/nonexistent}" ]; then
      touch "${PM2_DELETE_ONCE_MARKER:?PM2_DELETE_ONCE_MARKER must be set when FAKE_PM2_DELETE_FAIL_ONCE is}"
      exit 1
    fi
    if [ -f "$PM2_REGISTERED" ]; then
      grep -vFx "$name" "$PM2_REGISTERED" > "$PM2_REGISTERED.tmp" 2>/dev/null || : > "$PM2_REGISTERED.tmp"
      mv "$PM2_REGISTERED.tmp" "$PM2_REGISTERED"
    fi
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

# OPS-18 — stands in for SQLite's own online backup, invoked as
# `sqlite3 "$db" ".backup '$dest'"`. FAKE_SQLITE_EXIT simulates a backup that
# cannot be taken. A raw string: the dot-command's own single quotes have to
# survive into the file exactly as written, and a plain triple-quoted string
# would have Python's own `\'` escape strip the backslash bash needs to keep
# that quote from starting a bash quoted context of its own.
SQLITE_STUB = r"""#!/usr/bin/env bash
echo "$*" >> "$SQLITE3_CALLS"
if [ "${FAKE_SQLITE_EXIT:-0}" != "0" ]; then
  exit "${FAKE_SQLITE_EXIT}"
fi
db="$1"
cmd="$2"
dest="${cmd#.backup \'}"
dest="${dest%\'}"
cp "$db" "$dest"
"""


def _git(cwd, *args):
    """Run a git command, failing the test loudly if it errors."""
    return subprocess.run(
        ["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True
    ).stdout.strip()


def _write_stub(path, body):
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


NEW_NAMES_ECOSYSTEM = """module.exports = { apps: [
      { name: "bloombot-api" }, { name: "bloombot-bot" },
      { name: "bloombot-worker" }, { name: "bloombot-mcp" },
      { name: "bloombot-ops-monitor" },
    ] };
"""

# OPS-16 — the pre-rename shape: bare names only, no `bloombot-` prefix.
OLD_NAMES_ECOSYSTEM = """module.exports = { apps: [
      { name: "api" }, { name: "bot" },
      { name: "worker" }, { name: "mcp" },
      { name: "ops-monitor" },
    ] };
"""


def _build_world(tmp_path, pre_rename_first_commit=False, skip_sqlite3=False):
    """Builds the fake droplet `world` wraps. Factored out so a test that
    needs a differently-shaped history — OPS-16's `pre_rename_first_commit`
    — can call it directly rather than only through the fixture below.

    `pre_rename_first_commit=True` makes the FIRST commit (what a rollback
    restores) pre-OPS-15 — bare names only — and the SECOND commit the
    rename itself. Without this, `first`'s own `ecosystem.config.cjs`
    already has the `bloombot-` names, a state a real migrating deploy can
    never actually be rolled back to (`check_pm2_names_migrated` refuses
    every deploy before this one while pm2 still knows a bare name) — the
    gap that made a real bug in the rollback path invisible to this suite.

    `skip_sqlite3=True` — OPS-18's own "sqlite3 is not on PATH" scenario:
    no `sqlite3` stub is written, and the PATH built below carries only
    symlinks to the specific real tools the script needs rather than the
    ordinary `/usr/bin`/`/bin` catch-all, since a real `sqlite3` often lives
    in one of those two directories right alongside tools this script
    genuinely needs (`sed`/`awk`/`du` on a typical Linux droplet).
    """
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    _git(upstream, "init", "-q")
    _git(upstream, "config", "user.email", "test@example.com")
    _git(upstream, "config", "user.name", "Test")
    _git(upstream, "config", "commit.gpgsign", "false")

    (upstream / "requirements.txt").write_text("discord==2.7.1\n", encoding="utf-8")
    (upstream / "Pipfile.lock").write_text('{"_meta": {}}\n', encoding="utf-8")
    # OPS-16 — named apps, not the empty `{}` this used to be: `deploy.sh`'s
    # own MIGRATE_PM2_NAMES path sources scripts/migrate-pm2-names.sh, whose
    # `assert_ecosystem_has_new_names` reads this file's own `apps` array
    # before deleting anything. Every other test in this file never looks at
    # its contents at all — the fake pm2 stub above never reads it either.
    (upstream / "ecosystem.config.cjs").write_text(
        OLD_NAMES_ECOSYSTEM if pre_rename_first_commit else NEW_NAMES_ECOSYSTEM,
        encoding="utf-8",
    )
    # OPS-16 — a real copy of the migration script itself, since
    # `deploy.sh` `source`s `scripts/migrate-pm2-names.sh` from the checkout
    # it is deploying (not from wherever `deploy.sh` itself runs) under
    # MIGRATE_PM2_NAMES.
    (upstream / "scripts").mkdir(exist_ok=True)
    (upstream / "scripts" / "migrate-pm2-names.sh").write_text(
        (REPO_ROOT / "scripts" / "migrate-pm2-names.sh").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
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
    if pre_rename_first_commit:
        # This second commit is the OPS-15 rename itself — the shape a real
        # migrating deploy's own TARGET_SHA always is.
        (upstream / "ecosystem.config.cjs").write_text(
            NEW_NAMES_ECOSYSTEM, encoding="utf-8"
        )
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
    if not skip_sqlite3:
        _write_stub(bin_dir / "sqlite3", SQLITE_STUB)

    # A directory shaped like a pipenv virtualenv, so the script's "is there a
    # virtualenv here?" probe — which requires an executable bin/python — can
    # succeed the same way it does on the droplet.
    fake_venv = tmp_path / "fakevenv"
    (fake_venv / "bin").mkdir(parents=True)
    _write_stub(fake_venv / "bin" / "python", PYTHON_STUB)

    if skip_sqlite3:
        # OPS-18's own "not on PATH" scenario: symlink only the specific real
        # tools deploy.sh needs (never a whole directory — see this
        # function's own docstring for why `/usr/bin`/`/bin` are unsafe
        # here), so a real `sqlite3` on this machine is genuinely
        # unreachable rather than merely unstubbed.
        no_sqlite3_dir = tmp_path / "no-sqlite3-path"
        no_sqlite3_dir.mkdir()
        for tool in (
            "git", "node", "bash", "cat", "sleep",
            "mkdir", "rm", "date", "du", "sort", "sed", "awk",
        ):
            found = shutil.which(tool)
            if found:
                (no_sqlite3_dir / tool).symlink_to(found)
        path = os.pathsep.join([str(bin_dir), str(no_sqlite3_dir)])
    else:
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
    # pm2 already knows every supervised app, as on a live, already-migrated
    # droplet (OPS-15) — the bloombot- prefixed names, not the pre-rename
    # bare ones. A droplet still on the bare names is its own, narrower
    # scenario (test_half_migrated_pm2_names_aborts_before_reloading below),
    # not the shape every other test in this file should have to route
    # around.
    registered.write_text(
        "bloombot\nbloombot-api\nbloombot-bot\nbloombot-worker\nbloombot-mcp\nbloombot-ops-monitor\n",
        encoding="utf-8",
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
        "SQLITE3_CALLS": str(state / "sqlite3.log"),
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


@pytest.fixture
def world(tmp_path):
    """A fake droplet: an upstream repo with three commits, a checkout sitting on
    the first one, stub executables, and the environment deploy.sh runs under."""
    return _build_world(tmp_path)


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


def test_unmigrated_pm2_names_abort_before_anything_is_reloaded(world):
    """OPS-15 — a droplet that has never run scripts/migrate-pm2-names.sh still
    has pm2's process list under the pre-rename, bare names. Deploying onto it
    unmigrated must refuse rather than start a second, bloombot- prefixed
    process beside each one still running under its old name."""
    world.registered.write_text(
        "bloombot\napi\nbot\nworker\nmcp\nops-monitor\n", encoding="utf-8"
    )

    result = world.run(world.code_only)

    assert result.returncode != 0
    assert "pre-OPS-15 names" in result.stderr
    assert "migrate-pm2-names.sh" in result.stderr
    assert world.head() == world.first  # the checkout was never even touched
    # Nothing was reloaded or started — only the read-only jlist calls the
    # guard itself makes.
    assert not any(
        call.startswith("reload ") or call.startswith("start ")
        for call in world.calls("pm2")
    )


def test_half_migrated_pm2_names_abort_before_anything_is_reloaded(world):
    """The narrower case: pm2 knows both an old name and its new counterpart —
    the signature of a migration that started but never finished. Still
    refused, on the same "any old name present" rule."""
    world.registered.write_text(
        "bloombot\nbloombot-api\nbloombot-bot\nbloombot-worker\nbloombot-mcp\nbloombot-ops-monitor\nworker\n",
        encoding="utf-8",
    )

    result = world.run(world.code_only)

    assert result.returncode != 0
    assert "pre-OPS-15 names" in result.stderr
    assert "worker" in result.stderr
    assert "migrate-pm2-names.sh" in result.stderr
    assert world.head() == world.first


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
    # Nothing was restarted — OPS-15's own half-migrated guard already reads
    # pm2's process list (`jlist`) before this point in the script, on every
    # run, so `pm2` is no longer uncalled here the way it used to be; what
    # this test is actually about is that no process was ever reloaded or
    # started because of the broken interpreter.
    assert not any(
        call.startswith("reload ") or call.startswith("start ")
        for call in world.calls("pm2")
    )
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


# OPS-16 — MIGRATE_PM2_NAMES turns a deploy into the OPS-15 migration itself,
# so CI can dispatch it instead of an operator running
# scripts/migrate-pm2-names.sh by hand.


def test_migrate_pm2_names_deletes_old_names_and_starts_new_ones(world):
    """On an unmigrated droplet, MIGRATE_PM2_NAMES deletes every old bare
    name pm2 knows, then lets the ordinary reload start the new,
    bloombot-prefixed ones — and pm2 save runs once the process list is
    right."""
    world.registered.write_text(
        "bloombot\napi\nbot\nworker\nmcp\nops-monitor\n", encoding="utf-8"
    )

    result = world.run(world.code_only, MIGRATE_PM2_NAMES="1")

    assert result.returncode == 0, result.stdout + result.stderr
    pm2 = world.calls("pm2")
    for old in ("api", "bot", "worker", "mcp", "ops-monitor"):
        assert f"delete {old}" in pm2, pm2
    assert "save" in pm2
    known = set(world.registered.read_text(encoding="utf-8").split())
    assert known == {
        "bloombot",
        "bloombot-api",
        "bloombot-bot",
        "bloombot-worker",
        "bloombot-mcp",
        "bloombot-ops-monitor",
    }


def test_migrate_pm2_names_never_touches_an_unrelated_process(world):
    """`scabbot`, on the same shared droplet, is never a candidate for
    deletion no matter what MIGRATE_PM2_NAMES does."""
    world.registered.write_text(
        "bloombot\napi\nbot\nworker\nmcp\nops-monitor\nscabbot\n", encoding="utf-8"
    )

    result = world.run(world.code_only, MIGRATE_PM2_NAMES="1")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "scabbot" in world.registered.read_text(encoding="utf-8").split()
    assert "delete scabbot" not in world.calls("pm2")


def test_migrate_pm2_names_ordering_a_build_failure_deletes_nothing(world):
    """The ordering guarantee this slice exists for: the old names must not
    be deleted until the build has proven the new ones can actually start.
    A build failure happens well before the reload step, so nothing is
    deleted and the old-named processes are left exactly as they were."""
    world.registered.write_text(
        "bloombot\napi\nbot\nworker\nmcp\nops-monitor\n", encoding="utf-8"
    )

    result = world.run(world.code_only, MIGRATE_PM2_NAMES="1", FAKE_NPM_EXIT="1")

    assert result.returncode != 0
    pm2 = world.calls("pm2")
    assert not any(call.startswith("delete ") for call in pm2), pm2
    assert not any(call.startswith("reload ") for call in pm2), pm2
    known = set(world.registered.read_text(encoding="utf-8").split())
    assert known == {"bloombot", "api", "bot", "worker", "mcp", "ops-monitor"}


def test_migrate_pm2_names_guard_does_not_abort_when_flag_is_set(world):
    """With the flag off (the default), an old bare name aborts the deploy —
    `test_unmigrated_pm2_names_abort_before_anything_is_reloaded` above pins
    that. With it on, the same droplet must not abort at all."""
    world.registered.write_text(
        "bloombot\napi\nbot\nworker\nmcp\nops-monitor\n", encoding="utf-8"
    )

    result = world.run(world.code_only, MIGRATE_PM2_NAMES="1")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "pre-OPS-15 names" not in (result.stdout + result.stderr)


def test_migrate_pm2_names_partial_delete_failure_that_never_recovers_starts_no_duplicate(
    world,
):
    """A delete that fails every time — never recovering, not even on the
    rollback path's own retry — must be reported and escalated, and must
    never start a duplicate `bloombot-bot` beside the `bot` that refused to
    delete: two Discord gateways, or with `worker` in its place, two
    processes claiming jobs (PLAT-4's own single-instance guarantee)."""
    world.registered.write_text(
        "bloombot\napi\nbot\nworker\nmcp\nops-monitor\n", encoding="utf-8"
    )

    result = world.run(
        world.code_only, MIGRATE_PM2_NAMES="1", FAKE_PM2_DELETE_FAIL="bot"
    )

    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "failed to reload" in output
    assert "CRITICAL" in output
    assert "deployed" not in output
    known = set(world.registered.read_text(encoding="utf-8").split())
    assert "bot" in known, "the old bot must still be present"
    assert "bloombot-bot" not in known, (
        f"a duplicate bloombot-bot was started beside the stranded old one: {known}"
    )
    assert not any(n.startswith("bloombot-") for n in known), (
        f"no new-named process should have started at all: {known}"
    )


def test_migrate_pm2_names_transient_delete_failure_recovers_on_the_rollback_retry(
    world, tmp_path
):
    """The recoverable sibling — the delete fails once, then succeeds on the
    rollback path's own retry of `delete_old_pm2_names` (the same shape
    `test_crash_loop_after_reload_rolls_back` already models for an
    ordinary reload). Still reported and rolled back — a transient pm2
    hiccup is not something this deploy is meant to silently paper over —
    but the retry does finish what the first attempt could not."""
    world.registered.write_text(
        "bloombot\napi\nbot\nworker\nmcp\nops-monitor\n", encoding="utf-8"
    )
    once_marker = tmp_path / "state" / "delete-bot-failed-once"

    result = world.run(
        world.code_only,
        MIGRATE_PM2_NAMES="1",
        FAKE_PM2_DELETE_FAIL_ONCE="bot",
        PM2_DELETE_ONCE_MARKER=str(once_marker),
    )

    output = result.stdout + result.stderr
    assert "failed to reload" in output
    assert "deployed" not in output


def test_migrate_pm2_names_leaves_a_process_with_a_mismatched_pm_cwd_alone(
    world, tmp_path
):
    """OPS-16 must-fix 4 — the unattended path has no human left to check
    `pm2 describe <name>` before confirming, so `delete_old_pm2_names`
    checks pm2's own `pm_cwd` itself: only a name whose `pm_cwd` is this
    checkout's own `APP_DIR` is this deploy's own process. `worker`, seeded
    with a different `pm_cwd`, must be left alone — not deleted, not
    reported as a failure of this deploy — while every other old name
    (whose `pm_cwd` matches) is migrated normally."""
    world.registered.write_text(
        "bloombot\napi\nbot\nworker\nmcp\nops-monitor\n", encoding="utf-8"
    )
    overrides = tmp_path / "state" / "pm2-cwd-overrides"
    overrides.parent.mkdir(parents=True, exist_ok=True)
    overrides.write_text("worker /opt/some-other-project\n", encoding="utf-8")

    result = world.run(
        world.code_only, MIGRATE_PM2_NAMES="1", PM2_CWD_OVERRIDES=str(overrides)
    )

    assert result.returncode == 0, result.stdout + result.stderr
    output = result.stdout + result.stderr
    assert "pm_cwd" in output
    assert "worker" in output
    known = set(world.registered.read_text(encoding="utf-8").split())
    assert "worker" in known, "worker with a mismatched pm_cwd must not be deleted"
    for old in ("api", "bot", "mcp", "ops-monitor"):
        assert old not in known, f"{old} should have been deleted"
    for migrated in (
        "bloombot-api",
        "bloombot-bot",
        "bloombot-mcp",
        "bloombot-ops-monitor",
    ):
        assert migrated in known, f"{migrated} should have started"


def test_migrate_pm2_names_rollback_from_an_unmigrated_prev_sha_reports_critical(
    tmp_path,
):
    """The bug this pins: `PREV_SHA` on a droplet that has never been
    migrated is necessarily pre-OPS-15 (the guard has refused every deploy
    since), so a rollback resets the checkout to a commit whose own
    `ecosystem.config.cjs` has no `bloombot-` names at all.
    `delete_old_pm2_names`'s own `assert_ecosystem_has_new_names` used to
    run unconditionally, so the rollback's own retry of `reload_everything`
    hit that assert and exited the whole script before reloading a single
    process — no CRITICAL message, no confirmation, nothing but the
    migration script's own, flatly false "Nothing was deleted." Needs its
    own `_build_world(pre_rename_first_commit=True)` — the default `world`
    fixture's own `first` already has the new names, so this path can never
    be observed through it."""
    world = _build_world(tmp_path, pre_rename_first_commit=True)
    world.registered.write_text(
        "api\nbot\nworker\nmcp\nops-monitor\n", encoding="utf-8"
    )

    result = world.run(
        world.code_only, MIGRATE_PM2_NAMES="1", PM2_STATUS="errored"
    )

    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "Nothing was deleted" not in output
    assert "unhealthy" in output
    assert "CRITICAL" in output


def test_migrate_pm2_names_is_a_noop_on_an_already_migrated_droplet(world):
    """MIGRATE_PM2_NAMES set on a droplet that already has only the new
    names is a no-op for the migration itself — the deploy still runs
    normally."""
    result = world.run(world.code_only, MIGRATE_PM2_NAMES="1")

    assert result.returncode == 0, result.stdout + result.stderr
    pm2 = world.calls("pm2")
    assert not any(call.startswith("delete ") for call in pm2), pm2


# OPS-18 — the deploy backs up the database before migrating it.
#
# `world`'s own fixture already gives every test in this file a `.env` (no
# DATABASE_PATH override, so the default `./data/data.db` applies) and a
# `data/data.db` file (`test_untracked_files_survive_a_deploy`'s own
# fixture), which is exactly the shape a droplet that has deployed before
# actually has — no extra setup needed for the ordinary cases below.


def test_ops18_backup_runs_before_the_migration(world):
    """The whole point of the slice, pinned on the actual order the two log
    lines appear in, not merely that both appear somewhere."""
    result = world.run(world.code_only)

    assert result.returncode == 0, result.stdout + result.stderr
    backup_at = result.stdout.find("backing up")
    migrate_at = result.stdout.find("applying the platform database migration")
    assert backup_at != -1, result.stdout
    assert migrate_at != -1, result.stdout
    assert backup_at < migrate_at, (
        f"backup must be logged before the migration "
        f"(backup at {backup_at}, migration at {migrate_at})"
    )
    sqlite_calls = world.calls("sqlite3")
    assert any(".backup" in call for call in sqlite_calls), sqlite_calls


def test_ops18_a_failing_backup_aborts_before_the_migration_and_before_anything_is_reloaded(
    world,
):
    """The failure-ordering half: a backup that cannot be taken must abort
    before the migration runs and before any process is reloaded — the same
    "aborts before reloading anything" family every other forward-path
    failure in this file already belongs to."""
    result = world.run(world.code_only, FAKE_SQLITE_EXIT="1")

    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "pre-migration database backup failed" in output
    assert "applying the platform database migration" not in output
    assert "reloading every supervised process" not in output
    assert world.head() == world.first
    # `pm2 jlist` alone is the half-migrated-names guard every deploy makes
    # before touching anything (`check_pm2_names_migrated`) — a read-only
    # call, not a reload or a start.
    assert not any(
        call.startswith("reload ") or call.startswith("start ")
        for call in world.calls("pm2")
    )


def test_ops18_a_first_deploy_with_no_database_yet_skips_the_backup(world):
    """A fresh droplet with no database yet must not fail over having
    nothing to back up."""
    (world.app / "data" / "data.db").unlink()

    result = world.run(world.code_only)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "skipping the pre-migration backup" in result.stdout
    assert world.calls("sqlite3") == []


def test_ops18_sqlite3_absent_fails_loudly_rather_than_falling_back_to_a_copy(
    tmp_path,
):
    """`sqlite3` not being on PATH must abort the deploy with a clear
    message, rather than silently falling back to something less safe than
    SQLite's own online backup. Needs its own world with no `sqlite3` stub
    and a PATH that cannot reach a real one either — see `_build_world`'s
    own `skip_sqlite3` docstring."""
    world = _build_world(tmp_path, skip_sqlite3=True)

    result = world.run(world.code_only)

    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "sqlite3 is not on PATH" in output
    assert "applying the platform database migration" not in output
    assert world.head() == world.first


def test_ops18_retention_prunes_old_backups_to_the_last_five(world):
    """Keeps only the newest 5 backups, so a droplet that never restores and
    deletes them by hand cannot fill its own disk over a term."""
    backups_dir = world.app / "data" / "backups"
    backups_dir.mkdir(parents=True)
    # Filenames sort chronologically by their own leading UTC timestamp, not
    # by mtime — seven pre-existing backups, all with a timestamp that
    # sorts before any backup this run itself takes.
    for i in range(7):
        (backups_dir / f"backup_2020010{i}T000000Z_aaaaaaaa.db").write_text(
            "old\n", encoding="utf-8"
        )

    result = world.run(world.code_only)

    assert result.returncode == 0, result.stdout + result.stderr
    remaining = sorted(p.name for p in backups_dir.glob("backup_*.db"))
    assert len(remaining) == 5, remaining
    assert "backup_20200100T000000Z_aaaaaaaa.db" not in remaining
    assert "backup_20200106T000000Z_aaaaaaaa.db" in remaining
