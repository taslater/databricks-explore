"""Point the app's data folder at a temporary one before any test imports it, so tests never touch the user's real data."""
import atexit
import os
import shutil
import tempfile

if not os.environ.get("EXPLORER_DATA_DIR"):
    _tmp = tempfile.mkdtemp(prefix="explorer-test-data-")
    os.environ["EXPLORER_DATA_DIR"] = _tmp
    atexit.register(shutil.rmtree, _tmp, ignore_errors=True)
