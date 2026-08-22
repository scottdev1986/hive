import { execFileSync } from "node:child_process";
import { isBoolean, isString } from "../../shared/is-record";
import type { JsonObject } from "../../shared/json";

/** What a bookmark says when we ask it to resolve. `isStale` is Foundation's own admission that the bookmark's cached path no longer matches where it found the file. It is a signal to *re-verify*, never a verdict: an ordinary move sets it, and so does an impostor. */
export interface BookmarkResolution {
  path: string;
  isStale: boolean;
}

export interface BookmarkProvider {
  readonly available: boolean;
  create(path: string): string | null;
  resolve(bookmark: string): BookmarkResolution | null;
}

/** Real, plain (non-security-scoped) Foundation bookmarks via the `hive-fsid` helper. Measured semantics, which are NOT what one would assume: 1. Bookmark A, rename A -> B (nothing left at A): resolves to B, isStale=true. 2. Then create ANY fresh directory at A: the same bookmark abandons B and resolves to A -- a different inode -- while B still exists. isStale=true. 3. Delete + recreate at the same path: resolves, isStale=true, new inode. 4. Untouched directory: resolves, isStale=false. So resolution is *path-first*, with file-ID lookup only as a fallback when the recorded path is vacant. A bookmark therefore cannot by itself distinguish a moved project from an unrelated directory that has taken over its old path. Only filesystem evidence can, and only by refusing. */
export class FoundationBookmarkProvider implements BookmarkProvider {
  readonly available = true;

  constructor(private readonly helperPath: string) {}

  private run(args: string[]): JsonObject | null {
    try {
      const out = execFileSync(this.helperPath, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      // SAFETY: The surrounding code already established this contract.
      return JSON.parse(out) as JsonObject;
    } catch {
      return null;
    }
  }

  create(path: string): string | null {
    const result = this.run(["bookmark-create", path]);
    const bookmark = result?.bookmark;
    return isString(bookmark) ? bookmark : null;
  }

  resolve(bookmark: string): BookmarkResolution | null {
    const result = this.run(["bookmark-resolve", bookmark]);
    if (!result) return null;
    const path = result.path;
    const isStale = result.isStale;
    if (!isString(path) || !isBoolean(isStale)) return null;
    return { path, isStale };
  }
}

export class NullBookmarkProvider implements BookmarkProvider {
  readonly available = false;
  create(): string | null {
    return null;
  }
  resolve(): BookmarkResolution | null {
    return null;
  }
}
