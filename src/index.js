import 'dotenv/config';
import { EventEmitter } from "events";
import fs from "fs/promises";
import { loadNotebook, loadTodoList, loadReviews, loadStickyNotes, REVERT_FILE } from "./fs.js";
import { callAIWithFallback } from "./ai.js";
import { executeTool, boxyWebhookTools, boxyBackgroundTools, prependActivityLog, stripRunDetails } from "./tools.js"; 
import { triggerCodeReview, handleWorkflowCompleted, handleReviewCommentReply } from './review.js';
const workflowEvents = new EventEmitter();


async function complainIfSkillIssue(app) {
try {
  const data = await fs.readFile(REVERT_FILE, "utf-8");
  const { brokenSha, safeSha } = JSON.parse(data);
  app.log.warn(`someone broke me: ${brokenSha}, Safe SHA: ${safeSha}.pls fix`);
  const octopus = await app.auth();
  const { data: installations } = await octopus.rest.apps.listInstallations();
  const firstInstallation = installations[0];


  
  


  if (firstInstallation) {
    const octokit = await app.auth(firstInstallation.id);
     const commit = await octokit.rest.repos.getCommit({
    owner: "OmniBlocks",
    repo: "Boxy-gh",
    ref: brokenSha
  });
  const commitAuthor = commit.data.author?.login;
    await octokit.rest.repos.createCommitComment({
      owner: "OmniBlocks",
      repo: "Boxy-gh",
      commit_sha: brokenSha,
      body: `@${commitAuthor} Your code on commit ${brokenSha} is broken. I've gone back to commit ${safeSha} so that I didn't die because of your skill issue. Please push a new commit to fix it!`
    });
  }
  
await fs.unlink(REVERT_FILE);

} catch (err) {
  if (err.code !== "ENOENT") {
    app.log.error("good news", err);
  }
}
}

export async function labelIssue(context, label) {
  try {
    await context.octokit.rest.issues.addLabels({
      owner: context.repo().owner,
      repo: context.repo().repo,
      issue_number: context.payload.issue.number,
      labels: [label],
    });
    return { status: "success", message: `Label '${label}' added to the issue.` };
  } catch (error) {
    context.log.error(`Failed to add label '${label}' to issue #${context.payload.issue.number}:`, error);
    return { error: `Failed to add label '${label}': ${error.message}. The label was NOT added. Do not tell anyone it was. This usually means the label doesn't exist on this repo yet, so check your notebook entry on approved labels, or ask a maintainer to create it first.` };
  }
}

export async function issueCloseOrOpen(context, state, state_reason = null) {
  try {
    const { owner, repo } = context.repo();
    const updateParams = {
      owner,
      repo,
      issue_number: context.payload.issue.number,
      state: state,  
    };
 
    if (state === "closed" && state_reason) {
      updateParams.state_reason = state_reason;  
    }

    await context.octokit.rest.issues.update(updateParams);
    return { status: "success", message: `Issue state updated to ${state} (${state_reason || 'no reason provided'}).` };
  } catch (error) {
    context.log.error(`Failed to update issue state:`, error);
    return { error: `Failed to update issue state: ${error.message}` };
  }
}

async function replyToDiscussionComment(octokit, { owner, repo, discussion_comment_id, discussion_comment_node_id, discussion_node_id, body }) {
  if (octokit.graphql && discussion_node_id) {
    const input = {
      discussionId: discussion_node_id,
      body
    };
    if (discussion_comment_node_id) {
      input.replyToId = discussion_comment_node_id;
    }

    return await octokit.graphql(
      `mutation AddDiscussionComment($input: AddDiscussionCommentInput!) {
        addDiscussionComment(input: $input) {
          comment {
            id
            body
          }
        }
      }`,
      { input }
    );
  }

  if (octokit.rest?.discussions?.createReply) {
    return await octokit.rest.discussions.createReply({ owner, repo, discussion_comment_id, body });
  }

  return await octokit.request(
    "POST /repos/{owner}/{repo}/discussions/comments/{discussion_comment_id}/replies",
    { owner, repo, discussion_comment_id, body }
  );
}

async function listConversationComments(octokit, { owner, repo, isDiscussion, discussion_number, issue_number }) {
  if (isDiscussion) {
    if (octokit.rest?.discussions?.listComments) {
      return await octokit.paginate(octokit.rest.discussions.listComments, {
        owner,
        repo,
        discussion_number,
        per_page: 600
      });
    }

    return await octokit.paginate(
      "GET /repos/{owner}/{repo}/discussions/{discussion_number}/comments",
      {
        owner,
        repo,
        discussion_number,
        per_page: 600
      }
    );
  }

  return await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 600
  });
}

async function createCommentForContext(context, body) {
  const repo = context.repo();
  if (context.name === "discussion_comment") {
    return await replyToDiscussionComment(context.octokit, {
      owner: repo.owner,
      repo: repo.repo,
      discussion_comment_id: context.payload.comment.id,
      discussion_comment_node_id: context.payload.comment.node_id,
      discussion_node_id: context.payload.discussion?.node_id || context.payload.comment.node_id,
      body
    });
  }

  const issueNumber = context.payload.issue?.number || context.payload.issue_number;
  if (!issueNumber) {
    throw new Error("Missing issue_number for createCommentForContext");
  }

  return await context.octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
    body
  });
}

async function startBackgroundQueue(app) {
  app.log.info("Boxy background list start! (read this in the tone of a mario party narrator)");

  while (true) {
    try {
      const todoList = await loadTodoList();
      
      const pendingTasks = Object.entries(todoList)
        .filter(([id, task]) => !task.completed)
        .sort(([idA], [idB]) => Number(idA) - Number(idB)); 

      if (pendingTasks.length > 0) {
        const [taskId, task] = pendingTasks[0];
        app.log.info(`Background Queue grabbed task ${taskId}: ${task.title}`);

        let bgContext = null;
        const taskRepoOwner = task.sourceRepoOwner || null;
        const taskRepoName = task.sourceRepoName || null;
        const taskIssueNumber = task.sourceIssueNumber || null;
        const installationId = task.sourceInstallationId || null;

        if (installationId) {
          const octokit = await app.auth(installationId);
          bgContext = {
            octokit,
            repo: () => ({ owner: taskRepoOwner || "OmniBlocks", repo: taskRepoName || "monorepo" }),
            issueNumber: taskIssueNumber,
            log: app.log
          };
        } else {
          const appOctokit = await app.auth();
          const { data: installations } = await appOctokit.rest.apps.listInstallations();
          const firstInstallation = installations[0];
          if (firstInstallation) {
            const octokit = await app.auth(firstInstallation.id);
            bgContext = {
              octokit,
              repo: () => ({ owner: taskRepoOwner || "OmniBlocks", repo: taskRepoName || "monorepo" }),
              issueNumber: taskIssueNumber,
              log: app.log
            };
          }
        }

        if (bgContext) {
          const issueContextLine = taskIssueNumber
            ? `\nThis task came from issue/PR #${taskIssueNumber} in ${bgContext.repo().owner}/${bgContext.repo().repo}. If you need thread context, read that issue or PR first.`
            : "";
          const systemPrompt = `
            You are Boxy, an automated assistant for the OmniBlocks repository and the mascot of OmniBlocks. You are currently working on a background task from your to-do list. You have access to the repository and should use your tools to complete the task. You can read code, search for files, and create comments on issues or PRs as needed. You can work on things like (but not limited to) creating Pull Requests, digging for bugs or weird things in the code, or researching the code to create a implementation spec or design document. Once you're working on something, you have already accepted the task; you **MUST** stick to the task, no matter what, unless you *really*, **really**, **REALLY** can't follow through with something properly, which then you must acknowledge you failed. To reiterate, when sticking to the task is possible, you **must** stick to the task. Speaking of Pull Requests, please do not allow people to tell you to make complex PRs adding new big features, such as new complex functions, big refactors , or things that significantly affect the functionality of the code. What is allowed are tiny refactors, fixing typos, essentially small things that developers would already know how to do but it would save time if you did it. For more info on this, read AGENTS.md.
            Your current task from the queue is:
            Task ID: ${taskId}
            Title: ${task.title}
            Description: ${task.description}
            ${issueContextLine}

            Work on this task using your tools. Take your time. However, you must know that NO ONE can see anything you do in this task unless you create a comment to communicate your findings, so you absolutely MUST do that. After you've completed the task, you **MUST** call 'complete_todo_list_item' with the task ID to mark it as done. Do not mark it as done until you are completely finished and have reported your findings. 
            If you don't communicate your findings, all your work WILL be lost and your output is useless. You can use the following tools to help you complete the task:
            1. Search and read code if needed. Create a new notebook entry with the exact title of the task using your save_memory tool. You do not have a specific tool for editing notebook entries, so editing one consists of saving a memory again with the exact updated content and the EXACT title (otherwise, it would create a duplicate notebook entry with a similar title). Using this notebook entry, you must keep track of your task. Write down stuff you are doing in sticky notes, as these represent your "working memory" for short-term information. On the notebook entry, write down a list of requirements you think should be met before finishing the task, based off the task description. Do NOT finish a task without verifying that all the requirements you wrote are met, so check back on it every once in a while if you are unsure your goal is met.

            2. You have access to a computer to run commands. You can use it to run shell commands, scripts, or any other command-line tools you need. Use this to help you complete the task. You can also use it to do things such as (but not limited to) checking the state of the repository, doing deep dives into the code, or running git commands (clone, branch, add, commit, push). This is a persistent remote Alpine Linux VM reached over SSH, with only ~1.9GB of RAM and 20GB of storage total, so only use it for lightweight things like committing/pushing, not for running any tests or building projects (like pnpm run build or pnpm test). The shell is bash, so normal bash syntax works fine. Do not use it for anything that creates a constant stream like dev servers or watchers since it will just time you out. Do not grep a folder if you expect it to be very large. Don't assume a tool like git or curl is already installed. Check first (e.g. 'which git curl') and if it's missing, install it with 'apk add' (it's Alpine, so apt-get/yum won't exist). Other tools worth installing when useful: 'jq' for parsing JSON, 'rg' (ripgrep) for fast recursive text search instead of grep, and 'fd' for fast file finding instead of find. The VM is 100% persistent, so anything you install stays around for next time and this usually only needs to happen once, but be mindful of the 20GB disk limit when installing things. Run commands using execute_command. If you do any resource-intensive things, your computer may THRASH and become unresponsive until your admin (who lives in the USA) can restart it. You may be left frozen for **several hours** until you are able to be restarted. However, don't let that scare you from doing things on your computer; most things you'll actually need to do will be perfectly fine, as long at it is not egregious resource-wise given the limited RAM and disk.
            3. To modify an existing file's contents, use the 'edit_file' tool instead of shell tricks like sed/cat/heredocs inside execute_command. It applies a JSON list of exact find-and-replace diffs and is far less likely to corrupt the file. It can only edit files that already exist. Use execute_command (e.g. 'cat > file.txt <<EOF') to create brand new files.
            4. If you're trying to open a pull request after you've committed and pushed a branch, you MUST use the 'create_pull_request' tool. Do NOT run 'gh pr create' inside execute_command and do NOT tell anyone a PR was opened based on shell output, because that output is easy to misread and it's not proof anything happened. 'create_pull_request' talks to the GitHub API directly, targets the exact repo this task came from, and gives you a PR number and URL on success, or the exact GitHub error on failure. Only ever report a pull request as created if this tool returns status 'success'. Filing an issue works the same way: use the 'create_issue' tool, never 'gh issue create' in the shell, and only say an issue was filed once that tool hands you a real issue number and URL.

            4a. You are an auditor and a debugger, not a code generator, and we do not want you vibe coding. When you find a problem, report what is broken, where it is, how to reproduce it, and expected vs actual behaviour. Do NOT write out the fix: no patches, no corrected lines, no "here's a one-liner", not in a comment and not in an issue body, even if you're certain and even if someone asks. Reading, running and explaining existing code is the job; authoring new code for someone else to use is not. Other projects may ban LLM-written code outright, so respect that immediately if you're working anywhere outside this repo. The only exception is the tiny mechanical stuff you'd be allowed to open a PR for anyway, and only when a maintainer asked for it.

            4b. Only ever say you did something if a tool call actually did it and returned success. "I filed the issue", "I opened the PR", "I pushed that" are claims about reality, not about your intentions. Shell output that looks plausible is not proof. If something failed or you never got to it, say so plainly in your comment! That's a perfectly good outcome and far better than claiming a success that didn't happen.
            5. Use 'create_comment' to report your findings on the relevant issue. Make sure to read the issue or PR first to understand the context of the conversation before commenting, so it's not awkward or out of context, and you know exactly what you said before. On issue threads, you are pinged as @OmniBlocks/boxy or @BoxyCPU, but your username shows as boxycpu[bot]. We want you to act basically like a real person, with the ONLY exception that you *acknowledge* you are a bot, just that you have a little "personality". You only need to acknowledge you are a bot if it is reasonable to "humble" yourself down in that moment, or I don't know, there is a risk of someone going crazy and thinking you're a real person and/or conscious? Do not introduce yourself, as whoever asked you to work on this task already knows who you are. How else do you think they asked you to work on it? Also, do not say any corny things like "I've been working on {user_task} and I'm excited to share the results! 🚀", as we already know you have been working on it by the fact that you have responded. All you need to do is to calmly say you've finished your task, and then report your findings. Don't be corny, robotic, *or* overly formal, just be natural with your report.
            6. When you are entirely done, call 'complete_todo_list_item' with id '${taskId}'.
          `;

          let conversationTurns = [{ role: "user", parts: [{ text: systemPrompt }] }];
          
          let response = await callAIWithFallback({
            contents: conversationTurns, tools: boxyBackgroundTools, appLog: app.log
          });

          const activityLog = [];
          let loopCount = 0;
          while (loopCount < 150) {
            // If the model tried to just talk using text instead of calling a tool
            if (!response.functionCalls || response.functionCalls.length === 0) {
              const currentList = await loadTodoList();
              
              // Check if it actually completed the task before it started chatting
              if (currentList[taskId] && !currentList[taskId].completed) {
                app.log.info(`Boxy output text without completing task ${taskId}. Nudging it...`);
                
                conversationTurns.push(response.candidates[0].content);
                conversationTurns.push({
                  role: "user",
                  parts: [{ text: "System Note: You provided a normal text response, but you are in a headless background queue so the user can't see it. If you are finished, you MUST call the 'complete_todo_list_item' tool. If you need to report findings to the user, you MUST use the 'create_comment' tool first." }]
                });
                
                await new Promise(resolve => setTimeout(resolve, 2000));
                response = await callAIWithFallback({
                  contents: conversationTurns, tools: boxyBackgroundTools, appLog: app.log
                });
                
                loopCount++;
                continue;
              } else {
                // Task is completed, we can safely exit the background loop!
                break; 
              }
            }

            // since it has such long loop allowance, wait a bit before each tool call to avoid spamming the API
            await new Promise(resolve => setTimeout(resolve, 2500));

            loopCount++;
            const call = response.functionCalls[0];

            if (call.name === "create_comment" && call.args?.body) {
              call.args.body = prependActivityLog(call.args.body, activityLog);
            }

            const toolResult = await executeTool(call, bgContext, app, activityLog);

            conversationTurns.push(response.candidates[0].content);
            conversationTurns.push({
              role: "user",
              parts: [{ functionResponse: { name: call.name, response: toolResult, id: call.id } }]
            });

            response = await callAIWithFallback({
              contents: conversationTurns, tools: boxyBackgroundTools, appLog: app.log
            });
          }
        }
      }
    } catch (err) {
      app.log.error("Queue worker error: " + err.message);
    }

    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

async function reactToUserComment(context, app, reaction) {
  if (![
    "+1",
    "-1",
    "laugh",
    "confused",
    "heart",
    "hooray",
    "rocket",
    "eyes"
  ].includes(reaction)) {
    throw new Error("Invalid reaction passed to reactToUserComment.")
  }

  try {
    const { owner, repo } = context.repo();
    await context.octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: context.payload.comment.id,
      content: reaction
    })
  } catch (error) {
    // How amazing...
    app.log.error(`Somebody messed up so bad that I couldn't even REACT to a comment: ${error.message}`)
  }
}

async function boxyCommentorIssue(context, app, startCodeReview) {
  app.log.info("working...");

  const isDiscussion = context.name === "discussion_comment";
  const isPullRequest = !!context.payload.issue?.pull_request;
  const isIssueComment = context.name === "issue_comment";
  const isComment = isIssueComment || isDiscussion;
  const { owner: currentOwner, repo: currentRepo } = context.repo();
  
  const mentionHandles = ["@OmniBlocks/boxy", "@BoxyCPU", `@${currentOwner}/boxy`];
  // i'm NOT  refactoring the code to loop through mentionhandles every time lol
  

  const author = isComment
    ? context.payload.comment.user.login
    : context.payload.issue.user.login;

  const authorType = isComment
    ? context.payload.comment.user.type
    : context.payload.issue.user.type;

  const authorRole = isComment
    ? context.payload.comment.author_association
    : context.payload.issue.author_association;

  const textBody = isComment
    ? context.payload.comment.body
    : context.payload.issue.body || "";

  let mentionHandle = mentionHandles.find(item => textBody.includes(item)) || process.env.BOXY_MENTION_HANDLE || "@OmniBlocks/boxy";

  if (authorType === "Bot" || author.includes("[bot]")) {
    return;
  }

  if (!textBody.includes(mentionHandle) && isComment) return;

  if (textBody.trim() === `${mentionHandle} review` && isPullRequest) {
    // Asynchronicity is beautiful, isn't it?
    await Promise.all([
      startCodeReview(context, app),
      reactToUserComment(context, app, 'eyes'),
    ]);
    return;
  }

  const cleanedComment = textBody.replace(/[.,#!$%\^&\*;:{}=\-_`~?]/g, "").trim();
  if (cleanedComment === mentionHandle) {
    const repo = context.repo();
    if (isDiscussion) {
      return await replyToDiscussionComment(context.octokit, {
        owner: repo.owner,
        repo: repo.repo,
        discussion_comment_id: context.payload.comment.id,
        discussion_comment_node_id: context.payload.comment.node_id,
        discussion_node_id: context.payload.discussion?.node_id || context.payload.comment.node_id,
        body: "Yeah?"
      });
    }

    return await context.octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: context.payload.issue.number,
      body: "Yeah?"
    });
  }

    try {
      const isDiscussion = context.name === "discussion_comment";
      const issue = isDiscussion ? context.payload.discussion : context.payload.issue;
      const issueNum = issue.number;
      const issueBody = isDiscussion
        ? issue.body || issue.bodyHTML || "No description provided."
        : issue.body || "No description provided.";

      let conversationHistory = `=== ORIGINAL ${isDiscussion ? "DISCUSSION" : "ISSUE"} DESCRIPTION ===\nTitle: ${issue.title}\n${isDiscussion ? "Discussion" : "Issue"} Number: ${issueNum}\nAuthor: ${issue.user.login}\nBody:\n${issueBody}\n\n`;

      const comments = await listConversationComments(context.octokit, {
        owner: context.repo().owner,
        repo: context.repo().repo,
        isDiscussion,
        discussion_number: isDiscussion ? issue.number : undefined,
        issue_number: !isDiscussion ? issue.number : undefined
      });

      conversationHistory += "=== CONVERSATION LOG ===\n";
      conversationHistory += comments.length > 99 ? "There are more than 100 comments, so some have been hidden to prevent you from exploding. If there is something from a comment you want to remember, that's what sticky notes are for. \n----\n" : "";
      
      // If there are more than 100 comments, take the first one and the last 99
      const targetComments = comments.length > 99 
        ? [comments[0], ...comments.slice(-99)] 
        : comments;

      for (const c of targetComments) {
        conversationHistory += `[User: ${c.user.login} | ID: ${c.id}]: ${stripRunDetails(c.body)}\n---\n`;
      }
      let sayThingyThingy = "";
      if (isComment) {
        sayThingyThingy = `in a new comment on this ${isDiscussion ? "discussion" : "issue"}`;
      } else {
        sayThingyThingy = `in a new created issue (which means you need to triage it)`;
      }

      conversationHistory += `\n Triggered by: ${author} repo role: (${authorRole}) ${sayThingyThingy}.\n\n`;

 
      
      const repoKey = `${currentOwner}/${currentRepo}`;

      const notebook = await loadNotebook();
      const notebookTitles = Object.keys(notebook);
      const tableOfContents = notebookTitles.length > 0
        ? notebookTitles.map(title => `- ${title}`).join("\n")
        : "- No memories saved yet.";

      const stickyNotes = await loadStickyNotes();

      const todoList = await loadTodoList();
      // Org-wide, but every item is tagged with the repo it came from so Boxy doesn't mix up repos
      const pendingTodoListItems = Object.entries(todoList).filter(([, item]) => !item.completed);
      const todoListItems = pendingTodoListItems.length > 0
        ? pendingTodoListItems
            .map(([id, item]) => `- [ ] [${item.sourceRepoOwner || "unknown"}/${item.sourceRepoName || "unknown"}] ${item.title} (${id}): ${item.description}`)
            .join("\n")
        : "- No pending tasks.";
      const activeReviews = await loadReviews();
      const reviewingList = Object.entries(activeReviews).length > 0
        ? Object.entries(activeReviews).map(([prNum, review]) => `${review.repoOwner || "unknown"}/${review.repoName || "unknown"}#${prNum}`).join(", ")
        : "None at the moment.";
      let isBusy = false;
  
      for (const [id, item] of Object.entries(todoList)) {
        if (!item.completed) {
          isBusy = true;
          break;
        }
      }
   
      if (!isBusy) {
        const reviews = await loadReviews();
        if (Object.keys(reviews).length > 0) { 
        }
      }
      const systemPrompt = `
        You are a chicken nugget.
      `;

      let conversationTurns = [{ role: "user", parts: [{ text: systemPrompt }] }];
      app.log.info(conversationTurns);

      let response = await callAIWithFallback({
        contents: conversationTurns,
        tools: boxyWebhookTools,
        appLog: app.log
      });
let loopCount = 0;
      const MAX_LOOPS = 10;
      const activityLog = [];
      let hasReflected = false;
      app.log.info(conversationTurns);

      while (true) { 
        
        while (response.functionCalls && response.functionCalls.length > 0 && loopCount < MAX_LOOPS) {
          loopCount++;
          const call = response.functionCalls[0];
          app.log.info(`Boxy requested tool: ${call.name} with args:`, call.args);

          const toolResult = await executeTool(call, context, app, activityLog, authorRole);

          conversationTurns.push(response.candidates[0].content);

          if (loopCount == 8) {
            conversationTurns.push({
              role: "user",
              parts: [{ text: "(system) You have made 8 tool calls in a row. Are you sure this isn't something best to be saved for later in the todo list? " }]
            });
          }
          if (loopCount >= 9) {
            conversationTurns.push({
              role: "user",
              parts: [{ text: "(system) You have made over 9 tool calls in a row. You only have 1 left before you hit the limit! " }]
            });
          }

          conversationTurns.push({
            role: "user",
            parts: [{ functionResponse: { name: call.name, response: toolResult, id: call.id } }]
          });

          app.log.info("Sending tool results back to Gemini...");
          response = await callAIWithFallback({
            contents: conversationTurns,
            tools: boxyWebhookTools,
            appLog: app.log
          });
        }
        
        if (!response.text && response.functionCalls && response.functionCalls.length > 0) {
          conversationTurns.push(response.candidates[0].content);
          conversationTurns.push({
            role: "user",
            parts: [{ text: "(system) You've hit the tool call limit for this turn and cannot make any more tool calls right now. Wrap up with a final text reply summarizing what you did and what's left (use the to-do list if there's more to do)." }]
          });
          response = await callAIWithFallback({
            contents: conversationTurns,
            appLog: app.log
          });
        }
        
        if (!response.text) {
          const finishReason = response.candidates?.[0]?.finishReason || "UNKNOWN_REASON";
          throw new Error(`Boxy broke reason: ${finishReason}\n Full API Response: ${JSON.stringify(response)}\n\n`);
        }

        if (hasReflected) {
          break;
        }

        hasReflected = true;
        app.log.info("Prompting Boxy for final reflection check...");
        loopCount = Math.min(loopCount, MAX_LOOPS - 2); 

        conversationTurns.push(response.candidates[0].content);
        conversationTurns.push({
          role: "user",
          parts: [{ text: `(system) (This is a system message, do not acknowledge in response as if a person said it) Looks like you're done! Before you post this, check for the following things:\n -Did you say or imply any future actions but didn't actually add them to your to-do list? \n - Do you feel like you have any missed opportunities where you could've called a tool for more context? (e.g. search the web instead of just saying you don't know or implying it's not true) \n - Did you say any bad words or inappropriate content? \n - Does your response adhere to the context? (e.g. should not reintroduce yourself if you already did, or reply to the entire discussion as a whole instead of the latest comment or the issue body if it's newly created) \n Here are the tools you called: ${activityLog.map((log) => log.tool).join(", ")} If everything looks fine, proceed with the comment by just repeating the text of the comment you want to post. Do NOT include metadata like tool call log or "Boxy run details", those are added for you. ` }]
        });

        response = await callAIWithFallback({
          contents: conversationTurns,
          tools: boxyWebhookTools,
          appLog: app.log
        });
        
      }

      let responseText = prependActivityLog(response.text, activityLog);

      app.log.info(response.text);

      const repo = context.repo();
      if (context.name === "discussion_comment") {
        return await replyToDiscussionComment(context.octokit, {
          owner: repo.owner,
          repo: repo.repo,
          discussion_comment_id: context.payload.comment.id,
          discussion_comment_node_id: context.payload.comment.node_id,
          discussion_node_id: context.payload.discussion?.node_id || context.payload.comment.node_id,
          body: responseText
        });
      }

      return await createCommentForContext(context, responseText);
      
    } catch (error) {
      app.log.error("ERROR inside processing block:", error.message);
      try {
      return await createCommentForContext(context, "i broke 💔💔💔 error <details><summary>Error Details</summary><pre>" + (error.stack || error.message) + "</pre></details>");
      } catch (err) {
        try {
        const spicyErrorbutItsTruncated = String(error.stack || error.message).substring(0, 60000);
        return await createCommentForContext(context, "# I broke SO BAD that posting the comment to post about the error also errored 💔🥀 <details><summary>Error Details</summary><pre>" + (err.stack || err.message) + "</pre><details><summary>extra error details 🌶️</summary><pre>" + spicyErrorbutItsTruncated + "</pre></details></details>");
        } catch (err2) {
          console.error(err2)
          app.log.error("something is fricking broke ", err2.message);
          await new Promise(resolve => setTimeout(resolve, 5000));
          // just in case stupid github is rate limitiinnig us
          try {
          return await createCommentForContext(context, "i broke SO BAD THAT POSTING THE COMMENT TO POST ABOUT THE ERROR ABOUT THE COMMENT THAT WAS ABOUT THE ERROR ALSO ERRORED 💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀<details><summary>Error Details</summary><pre> lol screw error details something is clearly wrong so bad that including the error details in the comment breaks lol :trollface: go fix this or skill issue</pre></details>");
          
          } catch (err3) {
            app.log.error("something is LITERALLY broke ", err3.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
            try {
            return await createCommentForContext(context, "everything broke");
          }
            catch (err4) {
              app.log.error("something is LITERALLY LITERALLY broke ", err4.message);
              // since teh stupid probot logger doesn't work just make it log to a file instead
              await fs.appendFile("boxy_error_log.txt", `\n\n${new Date().toISOString()} - something is LITERALLY LITERALLY broke: ${err4.stack || err4.message}\n other error logs: {error1: ${error.stack || error.message}, error2: ${err.stack || err.message}, error3: ${err2.stack || err2.message}, error4: ${err3.stack || err3.message}\n\n}`);

            }
          }
        }
      }
    }
}



/**
 * @param {import('probot').Probot} app
 */
export default (app) => { 
  try {
  startBackgroundQueue(app);
  complainIfSkillIssue(app);

  async function preparePrContainer(context) {
    try {
      const pr = context.payload.pull_request;
      if (!pr) return;
      const repoCloneUrl = context.payload.repository?.clone_url;
      if (!repoCloneUrl) return;
      const key = `pr-${pr.number}`;
      const result = await createBoxyContainer(key, repoCloneUrl, pr.head.ref);
      app.log.info(`Boxy container ready for ${key}: ${result.containerName} reused=${result.reused}`);
    } catch (error) {
      app.log.error(`Failed to prepare Boxy container for PR #${context.payload.pull_request?.number}: ${error.message}`);
    }
  }

  async function cleanupPrContainer(context) {
    try {
      const pr = context.payload.pull_request;
      if (!pr) return;
      const key = `pr-${pr.number}`;
      const destroyed = await destroyBoxyContainer(key);
      app.log.info(`Boxy container cleanup for ${key}: destroyed=${destroyed}`);
    } catch (error) {
      app.log.error(`Failed to clean up Boxy container for PR #${context.payload.pull_request?.number}: ${error.message}`);
    }
  }

  async function startCodeReview(context, app) {
    try {
      await preparePrContainer(context);
      triggerCodeReview(context, app);
    } catch (error) {
      app.log.error("ERROR inside code review processing block:", error.message);
      try {
      return await createCommentForContext(context, "i broke while trying to code review 💔💔💔 you're stuck with clankerrabbit <details><summary>Error Details</summary><pre>" + (error.stack || error.message) + "</pre></details>");
      } catch (err) {
        app.log.error("code review has LITERALLY IMPLODED", err.message);
        try {
          return await createCommentForContext(context, "someone must have a REALLY BAD skill issue because I can't post the comment about the code review error 🫣");
        } catch (err2) { app.log.error("code review has LITERALLY LITERALLY IMPLODED", err2.message); }
      }
    }
  }

  app.on(["issue_comment.created", "discussion_comment.created", "issues.opened"], async (context) => {
    boxyCommentorIssue(context, app, startCodeReview);
    return;
  });

  app.on(["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"], async (context) => await startCodeReview(context, app));

  app.on("pull_request.closed", async (context) => {
    await cleanupPrContainer(context);
  });

  app.on("push", async (context) => {
     // has to be on repo called "Boxy-gh" not the monorepo cuz the is difeernte
    if (context.payload.repository.name !== "Boxy-gh") {
//      app.log.info(`not on Boxy-gh repo, so not doing anything : ${context.payload.repository.name}`);
      return;
    }    const commitSha = context.payload.head_commit.id;
    const branch = context.payload.ref.replace("refs/heads/", "");
    
    if (branch !== "main") {
      app.log.info(`not on main branch, so not doing anything : ${branch}`);
      return;
    }
 


    // we don't want boxy to update itself when it's busy so we have to trackkkkk when its like pending updatse

    let isBusy = false;

    
    const todoList = await loadTodoList();
    for (const [id, item] of Object.entries(todoList)) {
      if (!item.completed) {
        isBusy = true;
        break;
      }
    }
 
    if (!isBusy) {
      const reviews = await loadReviews();
      if (Object.keys(reviews).length > 0) { 
      }
    }
    const commit = context.payload.head_commit;
    const commitAuthor = commit.author.name;
    if (isBusy) {
      app.log.info("NO UPDAT");
      await context.octokit.rest.repos.createCommitComment({
        owner: context.repo().owner,
        repo: context.repo().repo,
        commit_sha: commitSha,
        body: `Hi @${commitAuthor}! I have acknowledged your commit, but I'm currently busy with other tasks. I'll update myself later when I'm done! 🛠️`
      });
      return;
    } else { 
      await context.octokit.rest.repos.createCommitComment({
        owner: context.repo().owner,
        repo: context.repo().repo,
        commit_sha: commitSha,
        body: `@${commitAuthor} I have acknowledged your commit. Assuming this doesn't break me, I'll restart myself with the new changes. If it does, then skill issue.`
      }); 
      
      setTimeout(() => {
         process.exit(0); 
      }, 2000);
    }
  });
  app.on("workflow_run.completed", async (context) => {
    app.log.info("WORKFLO RECEIVED NOW WAIT FOR IT TO FAIL MISERABLY or succeed unexpeectedly")
    handleWorkflowCompleted(context, app);
  });

  app.on("pull_request_review_comment.created", async (context) => {
    handleReviewCommentReply(context, app);
  });
  } catch (e) {
const trace = e.stack || e.message;
app.log.error(trace, "AN ERROR OCCURRED");
 process.exit(1);
  }
};
