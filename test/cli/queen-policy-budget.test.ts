import { expect, test } from "bun:test";
import {
  QUEEN_POLICY,
  QUEEN_POLICY_MAX_CHARS,
  QUEEN_POLICY_MAX_SECTIONS,
  QUEEN_POLICY_MAX_WORDS,
} from "../../src/cli/queen-policy";

const policyBudget = (policy: string) => ({
  chars: policy.length,
  words: policy.trim().split(/\s+/).length,
  sections: policy.split("\n\n").length,
});

const expectWithinBudget = (policy: string) => {
  const { chars, words, sections } = policyBudget(policy);
  expect(chars).toBeLessThanOrEqual(QUEEN_POLICY_MAX_CHARS);
  expect(words).toBeLessThanOrEqual(QUEEN_POLICY_MAX_WORDS);
  expect(sections).toBeLessThanOrEqual(QUEEN_POLICY_MAX_SECTIONS);
};

test("queen policy stays within its ratcheted budget", () => {
  expectWithinBudget(QUEEN_POLICY);
});

test("positive control: an oversized policy fails the budget", () => {
  expect(() =>
    expectWithinBudget("x".repeat(QUEEN_POLICY_MAX_CHARS + 1)),
  ).toThrow();
});
