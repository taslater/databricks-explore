"""The databricks-explore command: options, ports, the data folder, the source-checkout hint, and the version."""
import subprocess
import sys

from databricks_explore import __version__, cli


def test_options_and_defaults():
    a = cli.build_parser().parse_args([])
    assert (a.demo, a.redacted, a.port, a.data_dir, a.debug, a.no_browser) == (False, False, None, None, False, False)
    a = cli.build_parser().parse_args(["--demo", "--redacted", "--port", "9001", "--data-dir", "x", "--debug", "--no-browser"])
    assert (a.demo, a.redacted, a.port, a.data_dir, a.debug, a.no_browser) == (True, True, 9001, "x", True, True)


def test_the_command_reports_its_version():
    out = subprocess.run([sys.executable, "-m", "databricks_explore", "--version"], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == f"databricks-explore {__version__}"


def test_redacted_needs_demo(monkeypatch, capsys):
    monkeypatch.setenv("EXPLORER_DEMO", "")
    assert cli.main(["--redacted", "--no-browser"]) == 2
    assert "--demo" in capsys.readouterr().err


def test_main_serves_on_loopback_only(monkeypatch, tmp_path, capsys):
    """main() sets the folder and port, prints the URL and runs the app bound to 127.0.0.1 (the server itself is stubbed)."""
    from databricks_explore import app as app_module

    calls = []
    monkeypatch.setattr(app_module.app, "run", lambda **kw: calls.append(kw))
    monkeypatch.setenv("EXPLORER_DEMO", "")
    monkeypatch.delenv("PORT", raising=False)
    monkeypatch.setenv("EXPLORER_DATA_DIR", str(tmp_path))
    assert cli.main(["--port", "9123", "--no-browser"]) == 0
    assert calls == [{"host": "127.0.0.1", "port": 9123, "debug": False}]
    assert f"{__version__} at http://127.0.0.1:9123" in capsys.readouterr().out


def test_port_defaults_follow_demo_mode(monkeypatch, tmp_path):
    from databricks_explore import app as app_module

    calls = []
    monkeypatch.setattr(app_module.app, "run", lambda **kw: calls.append(kw))
    monkeypatch.setenv("EXPLORER_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("PORT", raising=False)
    monkeypatch.setenv("EXPLORER_DEMO", "")
    cli.main(["--no-browser"])
    monkeypatch.setenv("EXPLORER_DEMO", "")
    cli.main(["--demo", "--no-browser"])
    monkeypatch.setenv("EXPLORER_DEMO", "")
    assert [c["port"] for c in calls] == [cli.DEFAULT_PORT, cli.DEMO_PORT]


def test_a_port_in_use_is_reported_not_a_traceback(monkeypatch, tmp_path, capsys):
    from databricks_explore import app as app_module

    def busy(**kw):
        raise OSError(98, "Address already in use")

    monkeypatch.setattr(app_module.app, "run", busy)
    monkeypatch.setenv("EXPLORER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EXPLORER_DEMO", "")
    assert cli.main(["--port", "9124", "--no-browser"]) == 1
    assert "--port" in capsys.readouterr().err


def test_hint_about_an_old_data_folder_only_in_a_source_checkout(monkeypatch, tmp_path):
    root = tmp_path / "checkout"
    (root / "src" / "databricks_explore").mkdir(parents=True)
    fake = root / "src" / "databricks_explore" / "cli.py"
    fake.write_text("")
    monkeypatch.setattr(cli, "__file__", str(fake))
    assert cli.source_checkout_hint(False) is None  # no pyproject.toml: an installed copy
    (root / "pyproject.toml").write_text("")
    assert cli.source_checkout_hint(False) is None  # no data/ folder
    (root / "data").mkdir()
    hint = cli.source_checkout_hint(False)
    assert hint and "--data-dir" in hint and str(root / "data") in hint
    assert cli.source_checkout_hint(True) is None  # the person already chose a folder
    assert "\n" not in hint


def test_version_is_in_the_session():
    from databricks_explore import app as app_module

    assert app_module.app.test_client().get("/api/session").get_json()["version"] == __version__
