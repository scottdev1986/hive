import { describe, expect, test } from "bun:test";
import {
  VersioningContractError,
  highestPatch,
  nextVersion,
  parseReleaseTag,
  planRelease,
} from "./plan";

describe("release tags", () => {
  test("reads the patch out of a release tag", () => {
    expect(parseReleaseTag("v0.0.1")).toEqual(1);
    expect(parseReleaseTag("v0.0.42")).toEqual(42);
  });

  test("ignores tags that are not releases", () => {
    for (const tag of ["nightly", "v0.0", "0.0.1", "v0.0.1-rc.1", ""]) {
      expect(parseReleaseTag(tag)).toEqual(null);
    }
  });

  test("refuses a zero-padded second name for one release", () => {
    expect(parseReleaseTag("v0.0.007")).toEqual(null);
  });

  test("orders patches numerically, not lexicographically", () => {
    // The bug this pins: `sort()` puts "v0.0.9" after "v0.0.10".
    expect(highestPatch(["v0.0.9", "v0.0.10"])).toEqual(10);
    expect(nextVersion(["v0.0.9", "v0.0.10"])).toEqual("0.0.11");
  });

  test("a version tag outside the patch series is a contract violation", () => {
    expect(() => nextVersion(["v0.0.1", "v0.1.0"])).toThrow(VersioningContractError);
    expect(() => nextVersion(["v1.0.0"])).toThrow(VersioningContractError);
  });

  test("non-version tags never trip the contract check", () => {
    expect(nextVersion(["nightly", "v0.0.3", "some-feature"])).toEqual("0.0.4");
  });
});

describe("one push, one bump", () => {
  test("the first release of a repo with no tags is 0.0.1", () => {
    expect(planRelease({ tags: [], headTags: [] })).toEqual({
      action: "release",
      version: "0.0.1",
      tag: "v0.0.1",
      reason: "no release exists yet; this is the first",
    });
  });

  test("bumps the patch by exactly one", () => {
    const plan = planRelease({ tags: ["v0.0.1", "v0.0.2", "v0.0.3"], headTags: [] });
    expect(plan.action).toEqual("release");
    expect(plan.version).toEqual("0.0.4");
  });

  test("a push carrying 100 commits still bumps the patch by exactly one", () => {
    // The plan never sees commits. It sees the tip's tags and the tag list, so
    // batch size cannot leak into the version. This is the whole guarantee.
    const tags = ["v0.0.1", "v0.0.2"];
    const plan = planRelease({ tags, headTags: [] });
    expect(plan.version).toEqual("0.0.3");
    expect(highestPatch(tags) + 1).toEqual(3);
  });

  test("re-running the workflow on an already-released commit releases nothing", () => {
    // Idempotency: the first run tagged the tip, so the second run must skip.
    const tags = ["v0.0.1", "v0.0.2", "v0.0.3"];
    const first = planRelease({ tags: ["v0.0.1", "v0.0.2"], headTags: [] });
    expect(first).toMatchObject({ action: "release", tag: "v0.0.3" });

    const second = planRelease({ tags, headTags: [first.tag] });
    expect(second).toEqual({
      action: "skip",
      version: "0.0.3",
      tag: "v0.0.3",
      reason: "this commit is already released as v0.0.3",
    });
  });

  test("planning twice without publishing proposes the same version, not two bumps", () => {
    // Two runs that both fail before the tag push must not advance the series.
    const tags = ["v0.0.5"];
    expect(planRelease({ tags, headTags: [] }).version).toEqual("0.0.6");
    expect(planRelease({ tags, headTags: [] }).version).toEqual("0.0.6");
  });

  test("a released tip skips even when newer releases exist elsewhere", () => {
    const plan = planRelease({
      tags: ["v0.0.1", "v0.0.2", "v0.0.3"],
      headTags: ["v0.0.2"],
    });
    expect(plan).toMatchObject({ action: "skip", version: "0.0.2" });
  });

  test("a tip carrying several release tags reports the newest", () => {
    const plan = planRelease({ tags: ["v0.0.1", "v0.0.2"], headTags: ["v0.0.1", "v0.0.2"] });
    expect(plan).toMatchObject({ action: "skip", version: "0.0.2" });
  });

  test("gaps in the series still bump from the highest", () => {
    expect(planRelease({ tags: ["v0.0.1", "v0.0.5"], headTags: [] }).version)
      .toEqual("0.0.6");
  });
});
