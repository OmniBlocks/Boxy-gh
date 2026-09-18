import { describe, test, beforeEach } from "node:test";
import assert from "node:assert";
import {
  getWhitelistedUsers,
  isUserWhitelisted,
  isUserInOrgOrWhitelisted,
  handlePullRequestGate
} from "../src/pr_gate.js";

describe("PR Gate - Whitelist & Org Checks", () => {
  test("getWhitelistedUsers parses comma and space separated users", () => {
    const env = { BOXY_PR_WHITELIST: "Alice, Bob,charlie " };
    const users = getWhitelistedUsers(env);
    assert.deepStrictEqual(users, ["alice", "bob", "charlie"]);
  });

  test("isUserWhitelisted correctly matches case-insensitively", () => {
    const env = { BOXY_PR_WHITELIST: "alice, Bob" };
    assert.strictEqual(isUserWhitelisted("Alice", env), true);
    assert.strictEqual(isUserWhitelisted("bob", env), true);
    assert.strictEqual(isUserWhitelisted("eve", env), false);
  });

  test("isUserInOrgOrWhitelisted returns true for whitelisted user", async () => {
    const env = { BOXY_PR_WHITELIST: "trusted_user" };
    const context = { repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }) };
    const allowed = await isUserInOrgOrWhitelisted(context, "trusted_user", "NONE", env);
    assert.strictEqual(allowed, true);
  });

  test("isUserInOrgOrWhitelisted returns true for OWNER and MEMBER associations", async () => {
    const context = { repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }) };
    assert.strictEqual(await isUserInOrgOrWhitelisted(context, "some_owner", "OWNER", {}), true);
    assert.strictEqual(await isUserInOrgOrWhitelisted(context, "some_member", "MEMBER", {}), true);
    assert.strictEqual(await isUserInOrgOrWhitelisted(context, "contributor", "CONTRIBUTOR", {}), false);
  });

  test("isUserInOrgOrWhitelisted queries octokit org membership if not in whitelist", async () => {
    let queriedOrg = null;
    let queriedUser = null;
    const context = {
      repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }),
      payload: { repository: { owner: { type: "Organization" } } },
      octokit: {
        rest: {
          orgs: {
            checkMembershipForUser: async ({ org, username }) => {
              queriedOrg = org;
              queriedUser = username;
              if (username === "org_member") return { status: 204 };
              const err = new Error("Not Found");
              err.status = 404;
              throw err;
            }
          }
        }
      }
    };

    assert.strictEqual(await isUserInOrgOrWhitelisted(context, "org_member", "NONE", {}), true);
    assert.strictEqual(queriedOrg, "OmniBlocks");
    assert.strictEqual(queriedUser, "org_member");

    assert.strictEqual(await isUserInOrgOrWhitelisted(context, "outsider", "NONE", {}), false);
  });
});

describe("PR Gate - Pre-emptive PR Close & Coders Ping", () => {
  let closedPrs;
  let postedComments;

  beforeEach(() => {
    closedPrs = [];
    postedComments = [];
  });

  function createMockContext(payload) {
    return {
      repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }),
      payload,
      octokit: {
        rest: {
          pulls: {
            update: async (opts) => {
              closedPrs.push(opts);
              return { data: opts };
            }
          },
          issues: {
            createComment: async (opts) => {
              postedComments.push(opts);
              return { data: opts };
            }
          }
        }
      }
    };
  }

  test("pre-emptively closes PR and pings @OmniBlocks/coders when opened by outsider", async () => {
    const context = createMockContext({
      action: "opened",
      pull_request: {
        number: 42,
        user: { login: "random_dev", type: "User" },
        author_association: "NONE"
      }
    });

    const result = await handlePullRequestGate(context, null, {});
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.closed, true);

    // Verify PR was closed
    assert.strictEqual(closedPrs.length, 1);
    assert.strictEqual(closedPrs[0].pull_number, 42);
    assert.strictEqual(closedPrs[0].state, "closed");

    // Verify comment pings @OmniBlocks/coders
    assert.strictEqual(postedComments.length, 1);
    assert.strictEqual(postedComments[0].issue_number, 42);
    assert.ok(postedComments[0].body.includes("@OmniBlocks/coders"));
    assert.ok(postedComments[0].body.includes("reopen"));
    assert.ok(postedComments[0].body.includes("@random_dev"));
  });

  test("allows PR to proceed when author is whitelisted", async () => {
    const env = { BOXY_PR_WHITELIST: "cool_contributor" };
    const context = createMockContext({
      action: "opened",
      pull_request: {
        number: 43,
        user: { login: "cool_contributor", type: "User" },
        author_association: "NONE"
      }
    });

    const result = await handlePullRequestGate(context, null, env);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(closedPrs.length, 0);
    assert.strictEqual(postedComments.length, 0);
  });

  test("allows PR to proceed when author is org MEMBER", async () => {
    const context = createMockContext({
      action: "opened",
      pull_request: {
        number: 44,
        user: { login: "core_dev", type: "User" },
        author_association: "MEMBER"
      }
    });

    const result = await handlePullRequestGate(context, null, {});
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(closedPrs.length, 0);
    assert.strictEqual(postedComments.length, 0);
  });

  test("re-closes PR when reopened by unauthorized sender and pings @OmniBlocks/coders", async () => {
    const context = createMockContext({
      action: "reopened",
      pull_request: {
        number: 45,
        user: { login: "random_dev", type: "User" },
        author_association: "NONE"
      },
      sender: {
        login: "random_dev",
        author_association: "NONE"
      }
    });

    const result = await handlePullRequestGate(context, null, {});
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.closed, true);
    assert.strictEqual(closedPrs.length, 1);
    assert.strictEqual(closedPrs[0].state, "closed");
    assert.ok(postedComments[0].body.includes("@OmniBlocks/coders"));
    assert.ok(postedComments[0].body.includes("Only members of the organization or @OmniBlocks/coders"));
  });

  test("allows review when reopened by authorized org member", async () => {
    const context = createMockContext({
      action: "reopened",
      pull_request: {
        number: 45,
        user: { login: "random_dev", type: "User" },
        author_association: "NONE"
      },
      sender: {
        login: "maintainer_jane",
        author_association: "MEMBER"
      }
    });

    const result = await handlePullRequestGate(context, null, {});
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(closedPrs.length, 0);
    assert.strictEqual(postedComments.length, 0);
  });

  test("synchronize ignores closed PRs", async () => {
    const context = createMockContext({
      action: "synchronize",
      pull_request: {
        number: 46,
        state: "closed",
        user: { login: "random_dev", type: "User" }
      }
    });

    const result = await handlePullRequestGate(context, null, {});
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "pr_closed");
  });
});
