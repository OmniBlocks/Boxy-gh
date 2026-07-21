import { Type } from "@google/genai";
import { labelIssue, issueCloseOrOpen } from "./index.js";
import { loadNotebook, saveMemoryToFile, saveStickyNoteToFile, createTodoListItem, loadTodoList, saveTodoList, loadReviews, saveReviews } from "./fs.js";
import { runCommandInBoxyContainer } from "./container.js";

const readMemoryDeclaration = {
  name: "read_memory",
  description: "Read the full content of a specific memory entry from the notebook.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "The exact title of the memory to read." },
    },
    required: ["title"],
  },
};
const saveMemoryDeclaration = {
  name: "save_memory",
  description: "Save a new permanent project memory, workflow nuance, or rule to the notebook.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "A short, descriptive title." },
      content: { type: Type.STRING, description: "The full details to remember." },
    },
    required: ["title", "content"],
  },
};
const executeCommandDeclaration = {
  name: "execute_command",
  description: "Execute a bash shell command in your computer.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: { 
        type: Type.STRING, 
        description: "The full bash command string to execute (e.g. 'ls -la', 'npm test', 'cat file.txt | grep foo')." 
      }
    },
    required: ["command"],
  },
};
const saveStickyNoteDeclaration = {
  name: "save_sticky_note",
  description: "Save a sticky note to the context. Unlike the notebook, only the last 5 notes are kept, so use this for current context or temporary notes only.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "A short, descriptive title for the sticky note." },
      content: { type: Type.STRING, description: "The content of the sticky note." },
    },
    required: ["title", "content"],
  },
};
const saveTodoListItemDeclaration = {
  name: "save_todo_list_item",
  description: "Save a new item to the to-do list.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "The title of the to-do item." },
      description: { type: Type.STRING, description: "A detailed description and plan for the to-do item." },
    },
    required: ["title", "description"],
  },
};

const searchCodeDeclaration = {
  name: "search_code",
  description: "Search the repository for specific code, keywords, or function names. Returns a list of files that match.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "The keyword or function name to search for." },
    },
    required: ["query"],
  },
};
const readFileDeclaration = {
  name: "read_file",
  description: "Read the exact contents of a specific file or list the contents of a directory in the repository.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: { type: Type.STRING, description: "The file path in the repo (e.g., '.github/workflows/cool.yml' or 'src/index.js')." },
    },
    required: ["path"],
  },
};
const readIssueOrPrDeclaration = {
  name: "read_issue_or_pr",
  description: "Read the title, description, and comments of a specific issue or pull request.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      issue_number: { type: Type.INTEGER, description: "The number of the issue or PR (e.g., 42)." },
    },
    required: ["issue_number"],
  },
};
const labelIssueDeclaration = {
  name: "label_issue",
  description: "Add a label to the current issue or pull request. Check if the label already exists before adding it.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      label: { type: Type.STRING, description: "The label to add (e.g., 'bug', 'enhancement')." },
    },
    required: ["label"],
  },
};
const closeOrOpenIssueDeclaration = {
  name: "close_or_open_issue",
  description: "Close or reopen the current issue. Use this when a user or maintainer explicitly requests it, or during triage.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      state: {
        type: Type.STRING,
        enum: ["open", "closed"],
        description: "The target state of the issue."
      },
      state_reason: {
        type: Type.STRING,
        enum: ["completed", "not_planned"],
        description: "REQUIRED if state is 'closed'. Use 'completed' if the issue/feature is fixed or resolved. Use 'not_planned' if the issue is spam, a duplicate, stale, or rejected by maintainers."
      },
    },
    required: ["state"],
  },
};
const completeTodoListItemDeclaration = {
  name: "complete_todo_list_item",
  description: "Mark a to-do list item as completed. Call this when you are done working on a background task.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: "The ID of the to-do item to mark as complete." },
    },
    required: ["id"],
  },
};
const createCommentDeclaration = {
  name: "create_comment",
  description: "Create a new comment on an issue or PR to report your findings from a background task.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      issue_number: { type: Type.INTEGER, description: "The issue or PR number." },
      body: { type: Type.STRING, description: "The text of your comment." },
    },
    required: ["issue_number", "body"],
  },
};
const getPrDiffDeclaration = {
  name: "get_pr_diff",
  description: "Get the raw git diff of a pull request.",
  parameters: { type: Type.OBJECT, properties: { pull_number: { type: Type.INTEGER } }, required: ["pull_number"] }
};
const updatePrSummaryDeclaration = {
  name: "update_pr_summary",
  description: "Update the main review comment with your detailed findings, test results, Mermaid diagram, and screenshots.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      comment_id: { type: Type.INTEGER },
      body: { type: Type.STRING, description: "The detailed markdown summary." }
    },
    required: ["comment_id", "body"]
  }
};
const createInlineCommentDeclaration = {
  name: "create_inline_comment",
  description: "Create an inline review comment on a specific line or a range of lines of code in the PR diff.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pull_number: { type: Type.INTEGER },
      commit_id: { type: Type.STRING, description: "The head SHA of the PR." },
      path: { type: Type.STRING, description: "The file path." },
      line: { type: Type.INTEGER, description: "The exact line number (or the ending line number of a range) to comment on." },
      start_line: { type: Type.INTEGER, description: "Optional. The starting line number of the range. If provided, the comment covers lines from 'start_line' to 'line'." },
      body: { type: Type.STRING, description: "Your review feedback." }
    },
    required: ["pull_number", "commit_id", "path", "line", "body"]
  }
};
const finishPrReviewDeclaration = {
  name: "finish_pr_review",
  description: "Submit your final PR review decision.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pull_number: { type: Type.INTEGER },
      event: { type: Type.STRING, enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
      body: { type: Type.STRING }
    },
    required: ["pull_number", "event", "body"]
  }
};
const reactCommentDeclaration = {
  name: "react_comment",
  description: "React to an issue comment.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      comment_id: { 
        type: Type.INTEGER, 
        description: "The unique identifier of the comment to react to." 
      },
      reaction: { 
        type: Type.STRING, 
        enum: [
          "+1",
          "-1",
          "laugh",
          "confused",
          "heart",
          "hooray",
          "rocket",
          "eyes"
        ],
        description: "The reaction type to add."
      },
    },
    required: ["comment_id", "reaction"],
  }
};
export const boxyReviewTools = [
  readMemoryDeclaration,
  saveMemoryDeclaration,
  searchCodeDeclaration,
  readFileDeclaration,
  getPrDiffDeclaration,
  updatePrSummaryDeclaration,
  createInlineCommentDeclaration,
  finishPrReviewDeclaration,
  executeCommandDeclaration
];
export const boxyWebhookTools = [
  readMemoryDeclaration,
  saveMemoryDeclaration,
  searchCodeDeclaration,
  readFileDeclaration,
  readIssueOrPrDeclaration,
  saveStickyNoteDeclaration,
  closeOrOpenIssueDeclaration,
  labelIssueDeclaration,
  saveTodoListItemDeclaration,
  reactCommentDeclaration,
  executeCommandDeclaration
];
export const boxyBackgroundTools = [
  readMemoryDeclaration,
  saveMemoryDeclaration,
  searchCodeDeclaration,
  readFileDeclaration,
  readIssueOrPrDeclaration,
  saveStickyNoteDeclaration,
  closeOrOpenIssueDeclaration,
  labelIssueDeclaration,
  saveTodoListItemDeclaration,
  completeTodoListItemDeclaration,
  createCommentDeclaration,
  executeCommandDeclaration
];
export async function executeTool(call, context, app) {
  let toolResult = {};
  const { owner, repo } = context.repo();

  try {
    if (call.name === "read_memory") {
      const currentNotebook = await loadNotebook();
      const content = currentNotebook[call.args.title];
      toolResult = content ? { content } : { error: `Memory '${call.args.title}' not found.` };
    }
    else if (call.name === "save_memory") {
      await saveMemoryToFile(call.args.title, call.args.content);
      toolResult = { status: "success", message: `Saved '${call.args.title}'!` };
    }
    else if (call.name === "save_sticky_note") {
      const { title, content } = call.args;
      await saveStickyNoteToFile(title, content);
      toolResult = { status: "success", message: `Sticky note '${title}' successfully saved.` };
    }
    else if (call.name === "search_code") {
      const safeQuery = `${call.args.query} repo:${owner}/${repo}`;
      const searchResult = await context.octokit.rest.search.code({ q: safeQuery, per_page: 5 });
      if (searchResult.data.items.length === 0) {
        toolResult = { message: "No code found matching that query." };
      } else {
        toolResult = { files_found: searchResult.data.items.map(i => i.path) };
      }
    }
    else if (call.name === "read_file") {
      const { data } = await context.octokit.rest.repos.getContent({
        owner, repo, path: call.args.path
      });
      if (Array.isArray(data)) {
        toolResult = { type: "directory", files: data.map(f => f.path) };
      } else if (data.type === "file") {
        const decodedContent = Buffer.from(data.content, "base64").toString("utf8");
        const MAX_CHARS = 25000;
        toolResult = {
          type: "file",
          path: data.path,
          content: decodedContent.length > MAX_CHARS
            ? decodedContent.substring(0, MAX_CHARS) + "\n\n... [FILE TRUNCATED FOR SIZE]"
            : decodedContent
        };
      }
    }
    else if (call.name === "read_issue_or_pr") {
      const issueNum = call.args.issue_number;
      const repoCandidates = [
        { owner, repo },
        ...(context.repoCandidates || [])
      ];
      let targetIssue;
      let targetComments;
      let resolvedRepo = { owner, repo };

      for (const candidate of repoCandidates) {
        try {
          targetIssue = await context.octokit.rest.issues.get({
            owner: candidate.owner,
            repo: candidate.repo,
            issue_number: issueNum
          });
          targetComments = await context.octokit.rest.issues.listComments({
            owner: candidate.owner,
            repo: candidate.repo,
            issue_number: issueNum,
            per_page: 100
          });
          resolvedRepo = candidate;
          break;
        } catch (err) {
          if (err.status !== 404) {
            throw err;
          }
        }
      }

      if (!targetIssue || !targetComments) {
        throw new Error(`Issue or PR #${issueNum} was not found in any accessible repository.`);
      }

      if (typeof context.repo === "function") {
        context.repo = () => ({ owner: resolvedRepo.owner, repo: resolvedRepo.repo });
      }

      let threadContent = `Title: ${targetIssue.data.title}\nState: ${targetIssue.data.state}\nAuthor: ${targetIssue.data.user?.login}\nBody:\n${targetIssue.data.body || "No description."}\n\n=== COMMENTS ===\n`;
      for (const c of targetComments.data) {
        threadContent += `[${c.user.login}]: ${c.body}\n---\n`;
      }
      const MAX_CHARS = 25000;
      toolResult = {
        type: "issue_thread",
        issue_number: issueNum,
        content: threadContent.length > MAX_CHARS
          ? threadContent.substring(0, MAX_CHARS) + "\n\n... [THREAD TRUNCATED FOR SIZE]"
          : threadContent
      };
    }
    else if (call.name === "label_issue") {
      const label = call.args.label;
      await labelIssue(context, label);
      toolResult = { status: "success", message: `Label '${label}' added to the issue.` };
    }
    else if (call.name === "close_or_open_issue") {
      const state = call.args.state;
      const state_reason = call.args.state_reason || null;
      toolResult = await issueCloseOrOpen(context, state, state_reason);
    }
    else if (call.name === "save_todo_list_item") {
      const { title, description } = call.args;
      await createTodoListItem(title, description, {
        sourceRepoOwner: context.repo().owner,
        sourceRepoName: context.repo().repo,
        sourceIssueNumber: context.payload.issue?.number || context.payload.pull_request?.number || null,
        sourceInstallationId: context.payload.installation?.id || null
      });
      toolResult = { status: "success", message: `To-do item '${title}' added.` };
    }

    else if (call.name === "complete_todo_list_item") {
      const todoList = await loadTodoList();
      if (todoList[call.args.id]) {
        todoList[call.args.id].completed = true;
        await saveTodoList(todoList);
        toolResult = { status: "success", message: "Task marked as completed." };
      } else {
        toolResult = { error: `Task ID ${call.args.id} not found.` };
      }
    }
    else if (call.name === "create_comment") {
      const { data } = await context.octokit.rest.issues.createComment({
        owner, repo,
        issue_number: call.args.issue_number,
        body: call.args.body
      });
      toolResult = { status: "success", comment_url: data.html_url };
    }
    else if (call.name === "get_pr_diff") {
      const diff = await context.octokit.rest.pulls.get({
        owner, repo, pull_number: call.args.pull_number, mediaType: { format: "diff" }
      });
      const lines = diff.data.split("\n");
      const formattedLines = [];
      let inHunk = false;
      let oldLine = 0;
      let newLine = 0;

      for (const line of lines) {
        // If we hit file metadata, we aren't in a hunk
        if (line.startsWith("diff --git") ||
          line.startsWith("---") ||
          line.startsWith("+++") ||
          line.startsWith("index") ||
          line.startsWith("new file mode") ||
          line.startsWith("deleted file mode")) {
          inHunk = false;
          formattedLines.push(line);
          continue;
        }
        if (line.startsWith("@@")) {
          inHunk = true;
          formattedLines.push(line);

          const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (match) {
            oldLine = parseInt(match[1], 10);
            newLine = parseInt(match[2], 10);
          }
          continue;
        }

        if (inHunk) {
          if (line.startsWith("+")) {
            formattedLines.push(`[L${newLine}] ${line}`);
            newLine++;
          } else if (line.startsWith("-")) {
            formattedLines.push(`[Del] ${line}`);
            oldLine++;
          } else if (line.startsWith(" ") || line === "") {
            formattedLines.push(`[L${newLine}] ${line}`);
            newLine++;
            oldLine++;
          } else {
            formattedLines.push(line);
          }
        } else {
          formattedLines.push(line);
        }
      }
      toolResult = { diff: formattedLines.join("\n").substring(0, 50000) };
    }
    else if (call.name === "execute_command") {
      // pass whether it's a webhook triggered by issues comment added, issue opened, or code review comment
      let isBoxyWebhook = false;
      try {
      let action = `${context.name}.${context.payload.action}`;
       isBoxyWebhook = action.startsWith("issues.") || action.startsWith("pull_request.") || action.startsWith("issue_comment.");
      } catch (error) {
      app.log.info("hurray");
      }
      app.log.info(`Boxy ran command: ${call.args.command}`);
      toolResult = await runCommandInBoxyContainer(call.args.command, isBoxyWebhook);
      app.log.info(`Boxy command result: ${JSON.stringify(toolResult)}`);
    }
  
    else if (call.name === "update_pr_summary") {
      await context.octokit.rest.issues.updateComment({ owner, repo, comment_id: call.args.comment_id, body: call.args.body });
      toolResult = { status: "success" };
    }
    else if (call.name === "create_inline_comment") {
      const reviews = await loadReviews();
      const prKey = call.args.pull_number.toString();
      const commentObj = {
        path: call.args.path,
        line: call.args.line,
        side: "RIGHT",
        body: call.args.body
      };

      if (call.args.start_line && call.args.start_line < call.args.line) {
        commentObj.start_line = call.args.start_line;
        commentObj.start_side = "RIGHT";
      }

      if (reviews[prKey]) {
        if (!reviews[prKey].draft_comments) {
          reviews[prKey].draft_comments = [];
        }
        reviews[prKey].draft_comments.push(commentObj);
        await saveReviews(reviews);
      }

      toolResult = { status: "success", message: "Inline comment drafted. It will be posted when finish_pr_review is called." };
    }
    else if (call.name === "finish_pr_review") {
      const reviews = await loadReviews();
      const prKey = call.args.pull_number.toString();
      const draftComments = (reviews[prKey] && reviews[prKey].draft_comments) ? reviews[prKey].draft_comments : [];

      await context.octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: call.args.pull_number,
        event: call.args.event,
        body: call.args.body,
        comments: draftComments
      });

      if (reviews[prKey]) {
        delete reviews[prKey];
        await saveReviews(reviews);
      }

      toolResult = { status: "review_completed" };
    } else if (call.name === "react_comment") {
      const { comment_id, reaction } = call.args;
      
      const { data } = await context.octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id,
        content: reaction // GitHub API uses 'content' for the reaction string
      });

      toolResult = { 
        status: "success", 
        message: `Successfully reacted with '${reaction}' to comment ${comment_id}.`,
        reaction_id: data.id 
      };
    } 
    else {
      toolResult = { error: "Tool does not exist" };
    }
  } catch (err) {
    if (app) app.log.warn(`Tool ${call.name} failed: ${err.message}`);
    toolResult = { error: `Action failed: ${err.message}. If you have called this tool more than once, stop trying the same thing.` };
  }
  return toolResult;
}
