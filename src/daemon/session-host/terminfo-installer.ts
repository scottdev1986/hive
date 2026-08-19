import { cp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { machineHiveHome } from "../../hive-home/home";
import { resolveSessiondBinary } from "./sessiond-broker";
import { IS_RELEASE_BUILD } from "../../shared/version";

/**
 * Ensure Hive's bundled xterm-ghostty terminfo is installed at machineHiveHome()/terminfo.
 * This makes Hive self-contained: no Ghostty.app, no tic, no system terminfo required.
 * 
 * On first call (or if stale), copies the bundled terminfo tree from resources/terminfo
 * to the machine home. The bundled tree lives next to hive-sessiond in release builds,
 * or in the repository resources/ directory in development.
 * 
 * Returns the terminfo path for TERMINFO/TERMINFO_DIRS.
 */
export async function ensureTerminfoInstalled(): Promise<string> {
  const targetPath = join(machineHiveHome(), "terminfo");
  
  // Check if already installed by looking for the xterm-ghostty entry
  try {
    const entryStat = await stat(join(targetPath, "x", "xterm-ghostty"));
    if (entryStat.isFile()) {
      // Already present, no need to reinstall
      return targetPath;
    }
  } catch {
    // Not present, need to install
  }
  
  // Locate the bundled terminfo tree
  const bundledTerminfo = await locateBundledTerminfo();
  if (bundledTerminfo === null) {
    throw new Error(
      "Hive bundled terminfo not found. Expected resources/terminfo next to hive-sessiond or in repository.",
    );
  }
  
  // Copy the entire terminfo tree
  await cp(bundledTerminfo, targetPath, { recursive: true, force: true });
  
  return targetPath;
}

/**
 * Locate the bundled terminfo tree in the installation or repository.
 * 
 * In release builds: looks for resources/terminfo next to hive-sessiond.
 * In development: looks for resources/terminfo in the repository root.
 * 
 * Returns null if not found (shouldn't happen in a proper installation).
 */
async function locateBundledTerminfo(): Promise<string | null> {
  // In development, use the repository resources directory
  if (!IS_RELEASE_BUILD) {
    const repoRoot = process.cwd();
    const repoTerminfo = join(repoRoot, "resources", "terminfo");
    try {
      const stat_ = await stat(repoTerminfo);
      if (stat_.isDirectory()) {
        return repoTerminfo;
      }
    } catch {
      // Not found in expected location
    }
  }
  
  // In release builds, look for resources/terminfo next to hive-sessiond
  const sessiondBin = resolveSessiondBinary();
  if (sessiondBin !== null) {
    const sessiondDir = dirname(sessiondBin);
    const resourcesTerminfo = join(sessiondDir, "resources", "terminfo");
    try {
      const stat_ = await stat(resourcesTerminfo);
      if (stat_.isDirectory()) {
        return resourcesTerminfo;
      }
    } catch {
      // Not found
    }
  }
  
  return null;
}
