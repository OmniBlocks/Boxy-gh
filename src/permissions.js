export const LEVEL_ORDER = ["public", "community", "trusted"];

const ROLE_LEVELS = {
  OWNER: "trusted",
  MEMBER: "trusted",
  COLLABORATOR: "trusted",
  CONTRIBUTOR: "community",
  FIRST_TIME_CONTRIBUTOR: "community",
  FIRST_TIMER: "community",
  MANNEQUIN: "public",
  NONE: "public",
};

const CAPABILITY_DEFAULTS = {
  runCommands: "community",
  queueTasks: "community",
  fileIssues: "community",
  useRepoCredentials: "trusted",
};

const CAPABILITY_ENV = {
  runCommands: "BOXY_MIN_ROLE_COMMANDS",
  queueTasks: "BOXY_MIN_ROLE_TASKS",
  fileIssues: "BOXY_MIN_ROLE_ISSUES",
  useRepoCredentials: "BOXY_MIN_ROLE_CREDENTIALS",
};

export function resolvePermissionLevel(authorRole) {
  if (authorRole === null || authorRole === undefined || authorRole === "") return "trusted";
  return ROLE_LEVELS[String(authorRole).toUpperCase()] || "public";
}

export function minLevelFor(capability, env = process.env) {
  const override = env[CAPABILITY_ENV[capability]];
  const normalized = (override || "").trim().toLowerCase();
  if (LEVEL_ORDER.includes(normalized)) return normalized;
  return CAPABILITY_DEFAULTS[capability] || "public";
}

export function levelAtLeast(level, minLevel) {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(minLevel);
}

export function can(authorRole, capability, env = process.env) {
  return levelAtLeast(resolvePermissionLevel(authorRole), minLevelFor(capability, env));
}

const CAPABILITY_LABELS = {
  runCommands: "run commands on your computer",
  queueTasks: "add items to your to-do list",
  fileIssues: "file issues on GitHub",
  useRepoCredentials: "use your GitHub credentials",
};

export function describeDenial(capability, authorRole, env = process.env) {
  const label = CAPABILITY_LABELS[capability] || capability;
  const needed = minLevelFor(capability, env);
  const audience = needed === "trusted"
    ? "an org member, owner, or repo collaborator"
    : "someone who has contributed to this repo before";

  return `Permission denied: you can only ${label} when the person who triggered you is ${audience}. `
    + `This request came from someone with the role '${authorRole || "NONE"}'. `
    + `Don't retry this, and don't pretend you did it anyway. Tell them plainly that this specific action needs `
    + `${audience} to ask for it, and offer whatever you CAN still do for them.`;
}
