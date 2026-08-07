const SUBJECT = String.raw`\b(?:i|we)(?:'ve|\s+have)?\s+(?:just\s+|now\s+|already\s+|actually\s+|genuinely\s+|finally\s+|gone\s+ahead\s+and\s+)*`;

const CLAIM_RULES = [
  {
    id: "issue_filed",
    label: "filing an issue",
    tools: ["create_issue", "execute_command"],
    patterns: [
      new RegExp(SUBJECT + String.raw`(?:filed|opened|created|submitted|raised)\s+(?:the|a|an|that|this|your|my)?\s*(?:new\s+|bug\s+)?issue\b`, "i"),
      new RegExp(SUBJECT + String.raw`(?:filed|opened|submitted)\s+it\b`, "i"),
      /\bthe issue (?:is|has been) (?:now )?(?:filed|opened|created|submitted)\b/i,
    ],
  },
  {
    id: "pull_request_opened",
    label: "opening a pull request",
    tools: ["create_pull_request"],
    patterns: [
      new RegExp(SUBJECT + String.raw`(?:opened|created|submitted|raised|put\s+up)\s+(?:the|a|an|that|this|my)?\s*(?:draft\s+)?(?:pr|pull\s+request)\b`, "i"),
      /\bthe (?:pr|pull request) (?:is|has been) (?:now )?(?:up|open|opened|created|submitted)\b/i,
    ],
  },
  {
    id: "code_pushed",
    label: "committing or pushing code",
    tools: ["execute_command"],
    patterns: [
      new RegExp(SUBJECT + String.raw`(?:pushed|committed)\b`, "i"),
      new RegExp(SUBJECT + String.raw`(?:made|pushed)\s+(?:the|a)\s+commit\b`, "i"),
    ],
  },
  {
    id: "command_run",
    label: "running something on your computer",
    tools: ["execute_command", "edit_file", "send_stdin", "wait_command", "kill_command"],
    patterns: [
      new RegExp(SUBJECT + String.raw`(?:ran|executed)\s+(?:it|that|the\s+\w+)\b`, "i"),
      new RegExp(SUBJECT + String.raw`cloned\b`, "i"),
    ],
  },
  {
    id: "file_edited",
    label: "editing a file",
    tools: ["edit_file", "execute_command"],
    patterns: [
      new RegExp(SUBJECT + String.raw`(?:edited|patched|updated|changed|fixed)\s+(?:the\s+)?(?:file|['\`"][^'\`"\n]+['\`"])`, "i"),
    ],
  },
  {
    id: "todo_added",
    label: "adding it to your to-do list",
    tools: ["save_todo_list_item"],
    patterns: [
      new RegExp(SUBJECT + String.raw`(?:added|written|wrote|put|saved|logged)\s+(?:it|this|that|the\s+task|a\s+task)?\s*(?:down\s+)?(?:to|on|in|onto)\s+(?:my\s+)?(?:to-?do|task)\b`, "i"),
      /\b(?:it'?s|this is|that'?s) (?:now )?on my to-?do list\b/i,
    ],
  },
  {
    id: "label_added",
    label: "labelling this issue",
    tools: ["label_issue"],
    patterns: [
      new RegExp(SUBJECT + String.raw`(?:added|applied|slapped|put)\s+(?:the\s+)?['\`"]?[\w\s:-]{1,30}['\`"]?\s+label\b`, "i"),
      new RegExp(SUBJECT + String.raw`labell?ed\s+(?:this|it|the\s+issue)\b`, "i"),
    ],
  },
  {
    id: "issue_state_changed",
    label: "closing or reopening this issue",
    tools: ["close_or_open_issue"],
    patterns: [
      new RegExp(SUBJECT + String.raw`(?:closed|reopened|re-opened)\s+(?:this|that|the)\s+(?:issue|one)\b`, "i"),
    ],
  },
  {
    id: "comment_posted",
    label: "posting a comment somewhere else",
    tools: ["create_comment"],
    patterns: [
      new RegExp(SUBJECT + String.raw`(?:posted|left|dropped)\s+(?:a|my|the)\s+(?:comment|reply)\s+(?:on|over\s+on|in)\b`, "i"),
    ],
  },
];

const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

export function extractSpokenText(text) {
  if (typeof text !== "string" || !text) return "";

  return text
    .replace(FENCED_CODE, " ")
    .replace(INLINE_CODE, " ")
    .split("\n")
    .filter(line => !/^\s*>/.test(line))
    .join("\n");
}

function toolsThatSucceeded(activityLog) {
  const succeeded = new Set();
  for (const entry of activityLog || []) {
    if (entry && entry.tool && entry.ok !== false) succeeded.add(entry.tool);
  }
  return succeeded;
}

export function findUnbackedClaims(text, activityLog) {
  const spoken = extractSpokenText(text);
  if (!spoken.trim()) return [];

  const succeeded = toolsThatSucceeded(activityLog);
  const unbacked = [];

  for (const rule of CLAIM_RULES) {
    if (rule.tools.some(tool => succeeded.has(tool))) continue;

    for (const pattern of rule.patterns) {
      const match = spoken.match(pattern);
      if (!match) continue;

      unbacked.push({
        id: rule.id,
        label: rule.label,
        tools: rule.tools,
        quote: match[0].trim(),
      });
      break;
    }
  }

  return unbacked;
}

export function formatUnbackedClaimNote(claims) {
  const lines = claims.map(claim =>
    `- You wrote "${claim.quote}", which claims ${claim.label}, but no successful ${claim.tools.map(t => `'${t}'`).join(" or ")} call happened this turn.`
  );

  return "(system) Hold on. Your reply says you did things that your tool calls this turn don't back up:\n"
    + lines.join("\n")
    + "\n\nThis comment has NOT been posted yet. Do one of two things, right now:\n"
    + "1. Actually perform the action with the correct tool, then say you did it, or\n"
    + "2. Rewrite the reply so it only describes what really happened. Saying \"I'll do X\" is fine only if you also queue it with 'save_todo_list_item' in this same turn.\n\n"
    + "Do not apologise at length, do not explain this system note to anyone, and never report an action as done based on what you intended to do.";
}

export function formatUnbackedClaimWarning(claims) {
  const list = claims.map(claim => `\`${claim.quote}\``).join(", ");
  return `\n\n> [!WARNING]\n> Boxy claimed an action (${list}) that its own tool log for this turn does not back up. Treat it as **not done** until someone checks.`;
}
