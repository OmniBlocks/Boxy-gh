/**
 * Boxy Humor Detection & Policy Enforcement
 *
 * OmniBlocks Policy:
 * 1. Reject PRs that attempt to remove humor, jokes, personality, or fun.
 * 2. Accept PRs that attempt to add humor, jokes, or playful easter eggs (provided they are safe/functional).
 */

export const HUMOR_KEYWORDS = [
  "humor", "humour", "joke", "jokes", "funny", "pun", "puns", "meme", "memes",
  "roast", "roasts", "lmao", "lol", "haha", "hahaha", "skill issue", "personality",
  "playful", "troll", "trolling", "silly", "easter egg", "meow", "cat",
  "nofun", "no fun", "fun", "bazinga", "clowndown", "giggle", "chuckle"
];

const HUMOR_EMOJIS = /[🐱😺😸😹😻😼😽🙀😿😾🎭🃏🤣😂🤡🥀🌶️🫣]/;

/**
 * Analyzes a diff and pull request metadata to detect whether it attempts to
 * remove humor or add humor.
 *
 * @param {string} diff - Git diff text
 * @param {object} [prData] - Pull request object (title, body)
 * @returns {{
 *   attemptsToRemoveHumor: boolean,
 *   attemptsToAddHumor: boolean,
 *   removedHumorScore: number,
 *   addedHumorScore: number,
 *   summary: string
 * }}
 */
export function analyzeHumor(diff = "", prData = {}) {
  const title = (prData.title || "").toLowerCase();
  const body = (prData.body || "").toLowerCase();
  const fullText = `${title} ${body}`;

  const titleOrBodyMentionsRemovingHumor =
    /remove\w*\s+(humor|humour|joke|jokes|fun|personality|pun|puns|meme|memes)/i.test(fullText) ||
    /anti[- ]humor/i.test(fullText) ||
    /stop\s+(the\s+)?(jokes|trolling|humor)/i.test(fullText) ||
    /no\s*fun/i.test(fullText) ||
    /delete\w*\s+(humor|jokes|personality)/i.test(fullText);

  const titleOrBodyMentionsAddingHumor =
    /add\w*\s+(humor|humour|joke|jokes|fun|personality|pun|puns|meme|memes)/i.test(fullText) ||
    /more\s+(jokes|humor|fun)/i.test(fullText) ||
    /easter\s*egg/i.test(fullText);

  let removedHumorScore = 0;
  let addedHumorScore = 0;

  const lines = typeof diff === "string" ? diff.split("\n") : [];
  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;

    if (line.startsWith("-")) {
      const lower = line.toLowerCase();
      for (const kw of HUMOR_KEYWORDS) {
        if (lower.includes(kw)) removedHumorScore++;
      }
      if (HUMOR_EMOJIS.test(line) || line.includes("ฅ^•ﻌ•^ฅ")) {
        removedHumorScore += 2;
      }
    } else if (line.startsWith("+")) {
      const lower = line.toLowerCase();
      for (const kw of HUMOR_KEYWORDS) {
        if (lower.includes(kw)) addedHumorScore++;
      }
      if (HUMOR_EMOJIS.test(line) || line.includes("ฅ^•ﻌ•^ฅ")) {
        addedHumorScore += 2;
      }
    }
  }

  const attemptsToRemoveHumor =
    titleOrBodyMentionsRemovingHumor || (removedHumorScore > 0 && removedHumorScore > addedHumorScore);

  const attemptsToAddHumor =
    !attemptsToRemoveHumor &&
    (titleOrBodyMentionsAddingHumor || (addedHumorScore > 0 && addedHumorScore >= removedHumorScore));

  let summary = "No significant humor changes detected.";
  if (attemptsToRemoveHumor) {
    summary = "This pull request attempts to remove humor or jokes from the codebase. Boxy must REJECT (REQUEST_CHANGES) this PR in accordance with project policy.";
  } else if (attemptsToAddHumor) {
    summary = "This pull request attempts to add humor or jokes to the codebase. Boxy should ACCEPT (APPROVE) this PR if functionally sound and safe.";
  }

  return {
    attemptsToRemoveHumor,
    attemptsToAddHumor,
    removedHumorScore,
    addedHumorScore,
    summary,
  };
}
