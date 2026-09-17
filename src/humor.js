/**
 * Humor detection and evaluation engine for Boxy PR reviews.
 * Analyzes code diffs to detect whether a PR removes or adds humor.
 */

const HUMOR_KEYWORDS = [
  "joke",
  "jokes",
  "joking",
  "funny",
  "humor",
  "humour",
  "pun",
  "puns",
  "meme",
  "memes",
  "lol",
  "lmao",
  "rofl",
  "haha",
  "hehe",
  "easter egg",
  "easteregg",
  "easter_egg",
  "troll",
  "trolling",
  "banter",
  "roast",
  "skill issue",
  "git gud",
  "rickroll",
  "never gonna give you up",
  "doge",
  "cat",
  "meow",
  "purr",
  "sus",
  "amogus",
  "bazinga",
  "yeet",
  "honk",
  "bonk",
  "silly",
  "magic: please do not touch",
  "don't touch this it works on magic",
  "here be dragons",
  "chaos",
  "yolo",
  "kek",
  "based",
  "ouch",
  "oopsies"
];

const HUMOR_EMOJIS = [
  "😄", "😆", "😂", "🤣", "😜", "🤪", "😝", "🤡", "👻", "🐱", "🐈", "🙀", "🍿", "🚀", "🔥", "💀"
];

const HUMOR_PATTERNS = [
  /:\)|:-\)|:D|;D|;\)|:P|:-P|xD|XD|\(╯°□°\)╯|¯\\_\(ツ\)_/i,
  /\b(skill issue|it'?s not a bug it'?s a feature)\b/i,
  /\b(troll|roast|banter|meme|lol|lmao|haha|hehe)\b/i
];

/**
 * Tests whether a single line of text contains humorous content.
 * @param {string} line Raw line of text
 * @returns {boolean} True if line matches humor indicators
 */
export function isHumorousLine(line) {
  if (!line || typeof line !== "string") return false;
  const lower = line.toLowerCase();

  for (const kw of HUMOR_KEYWORDS) {
    if (lower.includes(kw)) {
      return true;
    }
  }

  for (const emoji of HUMOR_EMOJIS) {
    if (line.includes(emoji)) {
      return true;
    }
  }

  for (const regex of HUMOR_PATTERNS) {
    if (regex.test(line)) {
      return true;
    }
  }

  return false;
}

/**
 * Analyzes a unified diff to assess changes in humor.
 * @param {string} diffText Unified diff string
 * @returns {{
 *   removesHumor: boolean,
 *   addsHumor: boolean,
 *   removedHumorCount: number,
 *   addedHumorCount: number,
 *   removedHumorLines: string[],
 *   addedHumorLines: string[],
 *   recommendation: "REJECT" | "ACCEPT" | "NEUTRAL",
 *   reason: string
 * }}
 */
export function analyzeHumorInDiff(diffText) {
  if (!diffText || typeof diffText !== "string") {
    return {
      removesHumor: false,
      addsHumor: false,
      removedHumorCount: 0,
      addedHumorCount: 0,
      removedHumorLines: [],
      addedHumorLines: [],
      recommendation: "NEUTRAL",
      reason: "No diff content provided."
    };
  }

  const lines = diffText.split("\n");
  const removedHumorLines = [];
  const addedHumorLines = [];

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }

    if (line.startsWith("-")) {
      const content = line.slice(1).trim();
      if (isHumorousLine(content)) {
        removedHumorLines.push(content);
      }
    } else if (line.startsWith("+")) {
      const content = line.slice(1).trim();
      if (isHumorousLine(content)) {
        addedHumorLines.push(content);
      }
    }
  }

  const removedHumorCount = removedHumorLines.length;
  const addedHumorCount = addedHumorLines.length;

  let removesHumor = false;
  let addsHumor = false;
  let recommendation = "NEUTRAL";
  let reason = "Humor level remained unchanged.";

  if (removedHumorCount > addedHumorCount) {
    removesHumor = true;
    recommendation = "REJECT";
    reason = `PR attempts to remove humor from the codebase (${removedHumorCount} humorous item(s) removed vs ${addedHumorCount} added).`;
  } else if (addedHumorCount > removedHumorCount) {
    addsHumor = true;
    recommendation = "ACCEPT";
    reason = `PR adds humor to the codebase (${addedHumorCount} humorous item(s) added vs ${removedHumorCount} removed).`;
  } else if (addedHumorCount > 0 && removedHumorCount > 0) {
    addsHumor = true;
    recommendation = "ACCEPT";
    reason = `PR preserves and adds humor (${addedHumorCount} item(s)).`;
  }

  return {
    removesHumor,
    addsHumor,
    removedHumorCount,
    addedHumorCount,
    removedHumorLines,
    addedHumorLines,
    recommendation,
    reason
  };
}
