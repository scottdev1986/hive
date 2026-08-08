// main.swift The shipped product. It installs no QA hooks, so this binary links
// neither the headless smoke checks nor the frozen-corpus shell loader.

import HiveWorkspace

WorkspaceLaunch.run()
