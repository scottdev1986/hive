"""Dispatcher entry point for the frozen graphify bundle (bundling spike).

One binary, busybox-style: invoked as `graphify-mcp` (a symlink next to the
executable) it runs the MCP server entry point; invoked as anything else it
runs the CLI. Both console_scripts from the graphifyy wheel are covered by
one PyInstaller EXE, so the two entry points share one 123 MB library dir
instead of shipping it twice.
"""
import os
import sys


def main():
    prog = os.path.basename(sys.argv[0])
    if prog == "graphify-mcp":
        from graphify.serve import _main
        _main()
    else:
        from graphify.__main__ import main as cli_main
        cli_main()


if __name__ == "__main__":
    main()
