import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getWhitelist,
  isWhitelisted,
  isOrgMember,
  checkPrAuthorAccess,
  handlePreemptivePrClose
} from "../src/whitelist.js";

describe("Whitelist and Pre-emptive PR Closure", () => {
  const originalEnv = { ...process.env };
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boxy-whitelist-test-"));
    delete process.env.BOXY_PR_WHITELIST;
    delete process.env.BOXY_WHITELIST;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("getWhitelist", () => {
    it("parses comma-separated usernames from BOXY_PR_WHITELIST", () => {
      process.env.BOXY_PR_WHITELIST = "alice, @bob, Charlie";
      const list = getWhitelist();
      assert.equal(list.has("alice"), true);
      assert.equal(list.has("bob"), true);
      assert.equal(list.has("charlie"), true);
      assert.equal(list.has("dan"), false);
    });

    it("parses usernames from BOXY_WHITELIST fallback", () => {
      process.env.BOXY_WHITELIST = "eve frank";
      const list = getWhitelist();
      assert.equal(list.has("eve"), true);
      assert.equal(list.has("frank"), true);
    });

    it("parses usernames from JSON file", () => {
      const jsonPath = path.join(tempDir, "whitelist.json");
      fs.writeFileSync(jsonPath, JSON.stringify(["@Grace", "heidi"]));
      const list = getWhitelist(jsonPath);
      assert.equal(list.has("grace"), true);
      assert.equal(list.has("heidi"), true);
    });
  });

  describe("isWhitelisted", () => {
    it("returns true for matching usernames regardless of case or @ prefix", () => {
      const whitelistSet = new Set(["alice", "bob"]);
      assert.equal(isWhitelisted("@Alice", whitelistSet), true);
      assert.equal(isWhitelisted("BOB", whitelistSet), true);
      assert.equal(isWhitelisted("eve", whitelistSet), false);
      assert.equal(isWhitelisted("", whitelistSet), false);
      assert.equal(isWhitelisted(null, whitelistSet), false);
    });
  });

  describe("isOrgMember", () => {
    it("returns true if username matches repo owner", async () => {
      const context = {
        repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" })
      };
      const result = await isOrgMember(context, "OmniBlocks");
      assert.equal(result, true);
    });

    it("returns true if authorAssociation is MEMBER or OWNER", async () => {
      const context = {
        repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" })
      };
      assert.equal(await isOrgMember(context, "contributor1", "MEMBER"), true);
      assert.equal(await isOrgMember(context, "contributor2", "OWNER"), true);
    });

    it("queries octokit checkMembershipForUser when association is not MEMBER/OWNER", async () => {
      let queriedOrg = "";
      let queriedUser = "";
      const context = {
        repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }),
        octokit: {
          rest: {
            orgs: {
              checkMembershipForUser: async ({ org, username }) => {
                queriedOrg = org;
                queriedUser = username;
                return { status: 204 };
              }
            }
          }
        }
      };

      const result = await isOrgMember(context, "externalUser", "CONTRIBUTOR");
      assert.equal(result, true);
      assert.equal(queriedOrg, "OmniBlocks");
      assert.equal(queriedUser, "externalUser");
    });

    it("returns false if octokit checkMembershipForUser throws (not a member)", async () => {
      const context = {
        repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }),
        octokit: {
          rest: {
            orgs: {
              checkMembershipForUser: async () => {
                const err = new Error("Not Found");
                err.status = 404;
                throw err;
              }
            }
          }
        }
      };

      const result = await isOrgMember(context, "stranger", "NONE");
      assert.equal(result, false);
    });
  });

  describe("checkPrAuthorAccess", () => {
    it("disallows bots from regular review flow", async () => {
      const context = { repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }) };
      const pr = { user: { login: "renovate[bot]", type: "Bot" } };
      const res = await checkPrAuthorAccess(context, pr);
      assert.equal(res.allowed, false);
      assert.equal(res.reason, "bot");
    });

    it("allows whitelisted users", async () => {
      process.env.BOXY_PR_WHITELIST = "trusted-contributor";
      const context = { repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }) };
      const pr = { user: { login: "trusted-contributor", type: "User" } };
      const res = await checkPrAuthorAccess(context, pr);
      assert.equal(res.allowed, true);
      assert.equal(res.reason, "whitelisted");
    });

    it("allows organization members", async () => {
      const context = { repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }) };
      const pr = {
        user: { login: "core-dev", type: "User" },
        author_association: "MEMBER"
      };
      const res = await checkPrAuthorAccess(context, pr);
      assert.equal(res.allowed, true);
      assert.equal(res.reason, "org_member");
    });

    it("denies external, non-whitelisted users", async () => {
      const context = {
        repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }),
        octokit: {
          rest: {
            orgs: {
              checkMembershipForUser: async () => {
                throw new Error("404");
              }
            }
          }
        }
      };
      const pr = {
        user: { login: "random-user", type: "User" },
        author_association: "NONE"
      };
      const res = await checkPrAuthorAccess(context, pr);
      assert.equal(res.allowed, false);
      assert.equal(res.reason, "not_in_org_and_not_whitelisted");
    });
  });

  describe("handlePreemptivePrClose", () => {
    it("pre-emptively closes PR and pings @OmniBlocks/coders for unauthorized authors", async () => {
      let closedPullNumber = null;
      let closedState = null;
      let commentIssueNumber = null;
      let commentBody = null;

      const context = {
        repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }),
        payload: { action: "opened" },
        octokit: {
          rest: {
            pulls: {
              update: async ({ pull_number, state }) => {
                closedPullNumber = pull_number;
                closedState = state;
                return { data: { number: pull_number, state } };
              }
            },
            issues: {
              createComment: async ({ issue_number, body }) => {
                commentIssueNumber = issue_number;
                commentBody = body;
                return { data: { id: 12345 } };
              }
            },
            orgs: {
              checkMembershipForUser: async () => {
                throw new Error("404");
              }
            }
          }
        }
      };

      const app = {
        log: {
          info: () => {},
          error: () => {}
        }
      };

      const pr = {
        number: 42,
        user: { login: "outside-contributor", type: "User" },
        author_association: "NONE"
      };

      const result = await handlePreemptivePrClose(context, app, pr);

      assert.equal(result.closed, true);
      assert.equal(closedPullNumber, 42);
      assert.equal(closedState, "closed");
      assert.equal(commentIssueNumber, 42);
      assert.equal(commentBody.includes("@OmniBlocks/coders"), true);
      assert.equal(commentBody.includes("outside-contributor"), true);
    });

    it("does not close PR if author is in organization", async () => {
      let updateCalled = false;
      const context = {
        repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }),
        payload: { action: "opened" },
        octokit: {
          rest: {
            pulls: {
              update: async () => { updateCalled = true; }
            }
          }
        }
      };

      const pr = {
        number: 43,
        user: { login: "org-member", type: "User" },
        author_association: "MEMBER"
      };

      const result = await handlePreemptivePrClose(context, null, pr);
      assert.equal(result.closed, false);
      assert.equal(updateCalled, false);
    });

    it("allows review when an authorized org member reopens the PR", async () => {
      let updateCalled = false;
      const context = {
        repo: () => ({ owner: "OmniBlocks", repo: "Boxy-gh" }),
        payload: {
          action: "reopened",
          sender: { login: "admin-maintainer", author_association: "MEMBER" }
        },
        octokit: {
          rest: {
            pulls: {
              update: async () => { updateCalled = true; }
            }
          }
        }
      };

      const pr = {
        number: 44,
        user: { login: "outside-contributor", type: "User" },
        author_association: "NONE"
      };

      const result = await handlePreemptivePrClose(context, null, pr);
      assert.equal(result.closed, false);
      assert.equal(updateCalled, false);
    });
  });
});
