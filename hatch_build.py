"""Hatch build hook: build the web UI into the package when it is not there yet, and fail clearly when Node is missing."""
import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

NODE_HELP = (
    "The web UI (src/databricks_explore/web_dist) is not built, and building it needs Node.js 22 or newer with npm, "
    "which were not found on PATH. Install Node (https://nodejs.org), or install a published wheel, which already "
    "contains the UI. Then run the build again."
)


class WebBuildHook(BuildHookInterface):
    """Runs `npm ci` (when web/node_modules is absent) and `npm run build` in web/ unless the built UI exists."""

    PLUGIN_NAME = "custom"

    def initialize(self, version, build_data):
        """Before a wheel or sdist is assembled. Editable installs (uv sync) skip it: they serve the source folder."""
        if version == "editable":
            return
        root = Path(self.root)
        dist = root / "src" / "databricks_explore" / "web_dist"
        if (dist / "index.html").is_file():
            return
        web = root / "web"
        if not (web / "package.json").is_file():
            raise RuntimeError("web/package.json is missing, and so is the built UI in src/databricks_explore/web_dist.")
        npm = shutil.which("npm")
        if not npm:
            raise RuntimeError(NODE_HELP)
        if not (web / "node_modules").exists():
            self._run([npm, "ci"], web)
        self._run([npm, "run", "build"], web)
        for name in ("index.html", "THIRD-PARTY-NOTICES.txt"):
            if not (dist / name).is_file():
                raise RuntimeError(f"the web build finished but did not write {dist / name}")

    def _run(self, cmd, cwd):
        """Run one npm command, showing its output."""
        self.app.display_info("web: npm " + " ".join(cmd[1:]))
        subprocess.run(cmd, cwd=cwd, check=True)
