// main.swift The shipped product. It installs no QA hooks, so this binary links
// neither the frozen-corpus shell loader nor the QA tour driver.

import HiveWorkspace

WorkspaceLaunch.run()
