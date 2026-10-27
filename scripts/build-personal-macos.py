#!/usr/bin/env python3
"""Build the actual Swift application and a local DMG with Command Line Tools.

No installation, publishing, Xcode selection or existing app process changes.
Vortex is compiled from the same pinned source as project.yml, not a stub.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
# Keep unpacked apps out of Spotlight/Launch Services discovery. Only the
# installable DMG belongs in the visible delivery directory.
BUILD = ROOT / "dist/personal-build.noindex"
OUT = ROOT / "dist/reviewed"
REV = "ef5392088d4aeb255c4eee83157dbdafcd31bf07"
VORTEX_SHA = "69efde37eca214d3de9c59dc33a9fb74ad76aeee5af0814075fdacb148fc2fbb"


def run(*args):
    subprocess.run(list(map(str, args)), cwd=ROOT, check=True)


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    BUILD.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    archive = BUILD / "vortex.tar.gz"
    if not archive.exists():
        run("curl", "-fLsS", f"https://codeload.github.com/zats/Vortex/tar.gz/{REV}", "-o", archive)
    if sha(archive) != VORTEX_SHA:
        raise RuntimeError("Pinned Vortex archive checksum mismatch")
    vortex = BUILD / f"Vortex-{REV}"
    if not vortex.exists():
        with tarfile.open(archive) as handle:
            for member in handle.getmembers():
                destination = (BUILD / member.name).resolve()
                if not str(destination).startswith(str(BUILD.resolve()) + os.sep) or member.issym() or member.islnk():
                    raise RuntimeError("Unexpected archive member")
            handle.extractall(BUILD)
    # SwiftPM normally generates Bundle.module. These symbols are ordinary
    # bundled images below; this accessor does not replace library behavior.
    accessor = BUILD / "VortexResources.swift"
    accessor.write_text("import Foundation\nextension Bundle { static let module = Bundle.main }\n")
    target = "arm64-apple-macosx12.0"
    vortex_sources = sorted((vortex / "Sources/Vortex").rglob("*.swift"))
    run("swiftc", "-O", "-whole-module-optimization", "-swift-version", "5", "-parse-as-library",
        "-emit-library", "-static", "-emit-module", "-module-name", "Vortex", "-target", target,
        "-o", BUILD / "libVortex.a", "-emit-module-path", BUILD / "Vortex.swiftmodule",
        *vortex_sources, accessor)
    sources = sorted((ROOT / "TokenTrackerBar/TokenTrackerBar").rglob("*.swift"))
    sources += sorted((ROOT / "TokenTrackerBar/Shared").rglob("*.swift"))
    executable = BUILD / "TokenTrackerPersonal"
    run("swiftc", "-O", "-whole-module-optimization", "-swift-version", "5", "-parse-as-library",
        "-module-name", "TokenTrackerPersonal", "-target", target, "-I", BUILD, "-L", BUILD,
        "-lVortex", "-o", executable, *sources)
    app = BUILD / "TokenTrackerPersonal.app"
    if app.exists():
        shutil.rmtree(app)  # Only this script's generated output, never an installed app.
    resources = app / "Contents/Resources"
    binary = app / "Contents/MacOS"
    resources.mkdir(parents=True)
    binary.mkdir()
    shutil.copy2(executable, binary / executable.name)
    version = json.loads((ROOT / "package.json").read_text())["version"]
    plist = plistlib.loads((ROOT / "TokenTrackerBar/TokenTrackerBar/Info.plist").read_bytes())
    plist.update(CFBundleDevelopmentRegion="en", CFBundleExecutable=executable.name,
                 CFBundleIdentifier="com.cyrygbg.tokentracker.personal", CFBundleVersion="1",
                 CFBundleShortVersionString=version, LSMinimumSystemVersion="12.0")
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps(plist))
    shutil.copy2(ROOT / "TokenTrackerBar/TokenTrackerBar/AppIcon.icns", resources / "AppIcon.icns")
    shutil.copytree(ROOT / "TokenTrackerBar/EmbeddedServer", resources / "EmbeddedServer")
    payload = resources / "EmbeddedServer/tokentracker"
    # Always copy current source and production assets, never stale staging.
    for name in ["src", "bin", "dashboard/dist"]:
        shutil.rmtree(payload / name)
        shutil.copytree(ROOT / name, payload / name)
    for name in ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]:
        shutil.copy2(ROOT / name, payload / name)
    catalogs = [ROOT / "TokenTrackerBar/TokenTrackerBar/Assets.xcassets",
                vortex / "Sources/Vortex/Resources/Assets.xcassets"]
    for catalog in catalogs:
        for imageset in catalog.glob("*.imageset"):
            for file in imageset.iterdir():
                if file.suffix.lower() in [".png", ".svg", ".pdf"]:
                    shutil.copy2(file, resources / (imageset.stem + file.suffix))
                    shutil.copy2(file, resources / file.name)
    for file in (ROOT / "TokenTrackerBar/TokenTrackerBar").glob("*.svg"):
        shutil.copy2(file, resources / file.name)
    run("codesign", "--force", "--deep", "--sign", "-", app)
    run("codesign", "--verify", "--deep", "--strict", app)
    image_root = BUILD / "dmg"
    if image_root.exists():
        shutil.rmtree(image_root)
    image_root.mkdir()
    shutil.copytree(app, image_root / app.name)
    (image_root / "Applications").symlink_to("/Applications")
    dmg = OUT / "TokenTrackerPersonal-macOS-arm64.dmg"
    try:
        run("hdiutil", "create", "-volname", "TokenTracker Personal", "-srcfolder", image_root,
            "-ov", "-format", "UDZO", dmg)
    finally:
        shutil.rmtree(image_root)
    report = {"version": version, "architecture": "darwin-arm64", "build": "swiftc release",
              "vortexRevision": REV, "vortexStub": False, "nativeBinarySha256": sha(executable),
              "nativeSources": {str(p.relative_to(ROOT)): sha(p) for p in sources},
              "dmgSha256": sha(dmg), "appPath": str(app.relative_to(ROOT)), "installed": False}
    (OUT / "macos-build.json").write_text(json.dumps(report, indent=2) + "\n")
    print(dmg)


if __name__ == "__main__":
    main()
