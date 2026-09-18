/**
 * Boxy Pull Request Access Gate
 *
 * Implements pre-emptive PR closure for authors outside the organization
 * who are not explicitly whitelisted, and pings @OmniBlocks/coders to reopen
 * before code review can proceed.
 */

export const DEFAULT_WHITELIST = [
  "supervoidcoder",
  "ampelc",
  "somecatintheworld",
  "playforge-coding",
];

/**
 * Returns array of lowercased whitelisted usernames from environment.
 * @param {object} [env=process.env]
 * @returns {string[]}
 */
export function getWhitelistedUsers(env = process.env) {
  const envVal = env.BOXY_PR_WHITELIST || env.BOXY_WHITELIST || "";
  return envVal
    .split(/[\s,]+/)
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Checks if a specific username is explicitly whitelisted.
 * @param {string} username
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
export function isUserWhitelisted(username, env = process.env) {
  if (!username) return false;
  const lower = username.toLowerCase();
  if (DEFAULT_WHITELIST.includes(lower)) return true;
  const list = getWhitelistedUsers(env);
  return list.includes(lower);
}

/**
 * Checks if a user is an organization member/owner or explicitly whitelisted.
 *
 * @param {object} context - Probot context
 * @param {string} username - GitHub login to check
 * @param {string} [authorRole] - author_association from GitHub webhook payload
 * @param {object} [env=process.env]
 * @returns {Promise<boolean>}
 */
export async function isUserInOrgOrWhitelisted(context, username, authorRole, env = process.env) {
  if (!username) return false;

  // 1. Check explicit whitelist
  if (isUserWhitelisted(username, env)) {
    return true;
  }

  // 2. Check author association from webhook payload
  const upperRole = String(authorRole || "").toUpperCase();
  if (upperRole === "OWNER" || upperRole === "MEMBER") {
    return true;
  }

  // 3. Query GitHub API for organization membership
  try {
    const owner = context.repo ? context.repo().owner : (context.payload?.repository?.owner?.login || "OmniBlocks");
    const isOrg =
      context.payload?.repository?.owner?.type === "Organization" ||
      context.payload?.organization !== undefined ||
      owner.toLowerCase() === "omniblocks";

    if (isOrg) {
      if (context.octokit?.rest?.orgs?.getMembershipForUserInOrg) {
        try {
          const res = await context.octokit.rest.orgs.getMembershipForUserInOrg({
            org: owner,
            username,
          });
          if (res?.data?.state === "active") {
            return true;
          }
        } catch (e) {
          // ignore and fall back to public membership check
        }
      }

      if (context.octokit?.rest?.orgs?.checkMembershipForUser) {
        const res = await context.octokit.rest.orgs.checkMembershipForUser({
          org: owner,
          username,
        });
        if (res && (res.status === 204 || res.status === 200)) {
          return true;
        }
      }
    }
  } catch (err) {
    // 404 indicates user is not a public/accessible member of the org
  }

  return false;
}

/**
 * Handles PR gate check for incoming pull request events.
 *
 * @param {object} context - Probot context
 * @param {object} [app] - Probot app instance for logging
 * @param {object} [env=process.env]
 * @returns {Promise<{ allowed: boolean, reason: string, closed?: boolean }>}
 */
export async function handlePullRequestGate(context, app, env = process.env) {
  const pr = context.payload?.pull_request;
  if (!pr) {
    return { allowed: false, reason: "no_pull_request" };
  }

  const author = pr.user?.login;
  const authorType = pr.user?.type;
  if (authorType === "Bot" || (author && author.includes("[bot]"))) {
    return { allowed: false, reason: "bot_ignored" };
  }

  const action = context.payload?.action;
  const { owner, repo } = context.repo();

  if (action === "opened") {
    const isAuthorized = await isUserInOrgOrWhitelisted(context, author, pr.author_association, env);
    if (!isAuthorized) {
      if (app?.log) {
        app.log.info(`[PR Gate] Pre-emptively closing PR #${pr.number} by @${author} (not in org, not whitelisted)`);
      }

      // Pre-emptively close the pull request
      await context.octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: pr.number,
        state: "closed",
      });

      // Ping @OmniBlocks/coders to review and reopen before a review
      const commentBody =
        `Hi @${author}! Thanks for opening this pull request.\n\n` +
        `As a security and triage policy, pull requests from contributors who are not members of the organization and not explicitly whitelisted are closed pre-emptively.\n\n` +
        `@OmniBlocks/coders Please review and reopen this pull request before a code review can proceed.`;

      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pr.number,
        body: commentBody,
      });

      return { allowed: false, reason: "unauthorized_author", closed: true };
    }

    return { allowed: true, reason: "authorized_author" };
  }

  if (action === "reopened") {
    const sender = context.payload?.sender?.login;
    const senderRole =
      context.payload?.sender?.author_association ||
      (sender === author ? pr.author_association : undefined);

    const isSenderAuthorized = await isUserInOrgOrWhitelisted(context, sender, senderRole, env);

    if (!isSenderAuthorized) {
      if (app?.log) {
        app.log.warn(`[PR Gate] PR #${pr.number} was reopened by unauthorized user @${sender}. Re-closing pre-emptively.`);
      }

      await context.octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: pr.number,
        state: "closed",
      });

      const commentBody =
        `@OmniBlocks/coders This pull request was reopened by @${sender}, who is not in the organization or explicitly whitelisted.\n\n` +
        `Only members of the organization or @OmniBlocks/coders can reopen this pull request before a review can proceed. Closing pre-emptively.`;

      await context.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pr.number,
        body: commentBody,
      });

      return { allowed: false, reason: "unauthorized_reopen", closed: true };
    }

    if (app?.log) {
      app.log.info(`[PR Gate] PR #${pr.number} reopened by authorized user @${sender}. Proceeding with review.`);
    }
    return { allowed: true, reason: "authorized_reopen" };
  }

  if (action === "synchronize") {
    if (pr.state === "closed") {
      if (app?.log) {
        app.log.info(`[PR Gate] Skipping review for PR #${pr.number} on synchronize because it is closed.`);
      }
      return { allowed: false, reason: "pr_closed" };
    }

    return { allowed: true, reason: "open_synchronize" };
  }

  return { allowed: true, reason: "default" };
}
