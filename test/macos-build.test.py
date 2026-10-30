"""Host and download regressions; no Apple SDK or network required."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "macos_build", Path(__file__).resolve().parents[1] / "scripts/build-personal-macos.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class MacBuildTests(unittest.TestCase):
    def test_wrong_host_fails_before_running_tools(self):
        with patch.object(build.sys, "platform", "win32"), patch.object(build, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Windows/WSL"):
                build.preflight()
            run.assert_not_called()

    def test_intel_host_is_rejected(self):
        with patch.object(build.sys, "platform", "darwin"), patch.object(build.platform, "machine", return_value="x86_64"):
            with self.assertRaisesRegex(RuntimeError, "arm64"):
                build.preflight()

    def test_missing_tools_are_actionable(self):
        with patch.object(build.sys, "platform", "darwin"), \
                patch.object(build.platform, "machine", return_value="arm64"), \
                patch.object(build.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "xcode-select --install"):
                build.preflight()

    def test_sdk_failure_stops_preflight(self):
        with patch.object(build.sys, "platform", "darwin"), \
                patch.object(build.platform, "machine", return_value="arm64"), \
                patch.object(build.shutil, "which", return_value="/tool"), \
                patch.object(build, "run", side_effect=subprocess.CalledProcessError(1, "xcrun")):
            with self.assertRaises(subprocess.CalledProcessError):
                build.preflight()

    def test_archive_cache_and_interrupted_download(self):
        good = b"pinned-source"
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(build, "BUILD", Path(directory)), \
                patch.object(build, "VORTEX_SHA", hashlib.sha256(good).hexdigest()):
            archive = Path(directory) / "vortex.tar.gz"
            archive.write_bytes(good)
            with patch.object(build, "run") as run:
                self.assertEqual(build.vortex_archive(), archive)
                run.assert_not_called()
            archive.write_bytes(b"interrupted-download")
            def download(*args):
                Path(args[-1]).write_bytes(good)
            with patch.object(build, "run", side_effect=download):
                self.assertEqual(build.vortex_archive().read_bytes(), good)
            self.assertFalse((Path(directory) / "vortex.tar.gz.part").exists())

    def test_bad_download_does_not_replace_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(build, "BUILD", Path(directory)):
            archive = Path(directory) / "vortex.tar.gz"
            archive.write_bytes(b"old-cache")
            def download(*args):
                Path(args[-1]).write_bytes(b"corrupt-response")
            with patch.object(build, "run", side_effect=download):
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    build.vortex_archive()
            self.assertEqual(archive.read_bytes(), b"old-cache")
            self.assertFalse((Path(directory) / "vortex.tar.gz.part").exists())


if __name__ == "__main__":
    unittest.main()
