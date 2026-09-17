import fs from "node:fs";
import path from "node:path";

/**
 * Loads the set of explicitly whitelisted GitHub usernames.
 * Inspects BOXY_PR_WHITELIST, BOXY_WHITELIST environment variables, and boxy_whitelist.json.
 * @param {string} [customFilePath] Optional custom path to whitelist JSON file
 * @returns {Set<string>} Lowercase whitelisted usernames
 */
export function getWhitelist(customFilePath) {
  const whitelist = new Set();

  const envWhitelist = process.env.BOXY_PR_WHITELIST || process.env.BOXY_WHITELIST;
  if (envWhitelist) {
    envWhitelist
      .split(/[\s,]+/)
      .map((user) => user.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean)
      .forEach((user) => whitelist.add(user));
  }

  const filePath = customFilePath || path.resolve(process.cwd(), "boxy_whitelist.json");
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (Array.isArray(data)) {
        data
          .map((u) => String(u).trim().toLowerCase().replace(/^@/, ""))
          .filter(Boolean)
          .forEach((u) => whitelist.add(u));
      } else if (Array.isArray(data.whitelist)) {
        data.whitelist
          .map((u) => String(u).trim().toLowerCase().replace(/^@/, ""))
          .filter(Boolean)
          .forEach((u) => whitelist.add(u));
      }
    } catch {
    }
  }

  return whitelist;
}

/**
 * Checks whether a given username is explicitly whitelisted.
 * @param {string} username GitHub username
 * @param {Set<string>} [whitelistSet] Optional pre-loaded set of usernames
 * @returns {boolean} True if username is whitelisted
 */
export function isWhitelisted(username, whitelistSet) {
  if (!username) return false;
  const cleaned = username.trim().toLowerCase().replace(/^@/, "");
  const list = whitelistSet || getWhitelist();
  return list.has(cleaned);
}

/**
 * Checks whether a user is an organization member or repo owner.
 * @param {object} context Probot context
 * @param {string} username GitHub username
 * @param {string} [authorAssociation] author_association from GitHub webhook payload
 * @returns {Promise<boolean>} True if user is in org or owner
 */
export async function isOrgMember(context, username, authorAssociation) {
  if (!username) return false;
  const cleanedUser = username.trim().toLowerCase().replace(/^@/, "");
  const owner = context.repo().owner.toLowerCase();

  if (cleanedUser === owner) {
    return true;
  }

  if (authorAssociation === "OWNER" || authorAssociation === "MEMBER") {
    return true;
  }

  try {
    const res = await context.octokit.rest.orgs.checkMembershipForUser({
      org: context.repo().owner,
      username: username.trim()
    });
    if (res && (res.status === 204 || res.status === 200)) {
      return true;
    }
  } catch {
  }

  return false;
}

/**
 * Verifies if the author of a pull request has permission to open PRs without pre-emptive closure.
 * @param {object} context Probot context
 * @param {object} pr Pull request object
 * @returns {Promise<{ allowed: boolean, reason: string, author: string }>} Access evaluation result
 */
export async function checkPrAuthorAccess(context, pr) {
  const author = pr.user?.login;
  if (!author) {
    return { allowed: false, reason: "no_author", author: "" };
  }

  if (pr.user?.type === "Bot" || author.endsWith("[bot]")) {
    return { allowed: false, reason: "bot", author };
  }

  if (isWhitelisted(author)) {
    return { allowed: true, reason: "whitelisted", author };
  }

  const inOrg = await isOrgMember(context, author, pr.author_association);
  if (inOrg) {
    return { allowed: true, reason: "org_member", author };
  }

  return { allowed: false, reason: "not_in_org_and_not_whitelisted", author };
}

/**
 * Pre-emptively closes pull requests from contributors not in the org or whitelist,
 * and pings @OmniBlocks/coders to review and reopen.
 * @param {object} context Probot context
 * @param {object} app Probot application
 * @param {object} pr Pull request object
 * @returns {Promise<{ closed: boolean, commentId?: number, message: string }>} Outcome of check
 */
export async function handlePreemptivePrClose(context, app, pr) {
  const author = pr.user?.login;
  const action = context.payload?.action;

  if (action === "reopened") {
    const sender = context.payload?.sender?.login;
    if (sender) {
      const senderWhitelisted = isWhitelisted(sender);
      const senderInOrg = await isOrgMember(context, sender, context.payload?.sender?.author_association);
      if (senderWhitelisted || senderInOrg) {
        if (app?.log) {
          app.log.info(`PR #${pr.number} was reopened by authorized user @${sender}. Proceeding with review.`);
        }
        return { closed: false, message: `Reopened by authorized user @${sender}` };
      }
    }
  }

  const access = await checkPrAuthorAccess(context, pr);
  if (access.allowed || access.reason === "bot") {
    return { closed: false, message: access.reason };
  }

  const { owner, repo } = context.repo();

  await context.octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: pr.number,
    state: "closed"
  });

  const commentBody = `This pull request has been pre-emptively closed because @${author} is not a member of the organization and is not explicitly whitelisted.\n\n@OmniBlocks/coders - please verify and reopen before a review.`;

  const commentRes = await context.octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: commentBody
  });

  if (app?.log) {
    app.log.info(`Pre-emptively closed PR #${pr.number} for @${author} and pinged @OmniBlocks/coders.`);
  }

  return {
    closed: true,
    commentId: commentRes?.data?.id,
    message: commentBody
  };
}
