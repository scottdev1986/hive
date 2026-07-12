# PyInstaller spec for the frozen graphify bundle (bundling spike).
#
# Grammars are loaded via importlib.import_module(config.ts_module) at
# graphify/extractors/engine.py (L2122 in 0.9.12), invisible to PyInstaller's
# static analysis — every tree_sitter_* package is collected explicitly.
# The set is discovered from the build venv rather than hardcoded, so a pin
# bump that adds a grammar cannot silently drop it from the bundle.
import importlib.metadata as md

from PyInstaller.utils.hooks import collect_all, copy_metadata

datas = []
binaries = []
hiddenimports = []

# graphify itself ships data files (skill-*.md, always_on/*.md) beside its
# code; tree_sitter is the native core the grammars bind against.
for pkg in ["graphify", "tree_sitter"]:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

for dist in md.distributions():
    name = dist.metadata["Name"] or ""
    if name.startswith("tree-sitter-"):
        d, b, h = collect_all(name.replace("-", "_"))
        datas += d
        binaries += b
        hiddenimports += h

# graphify calls importlib.metadata.version("graphifyy") at runtime.
datas += copy_metadata("graphifyy")

a = Analysis(
    ["entry.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="graphify",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="graphify-dist",
)
