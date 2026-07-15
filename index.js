import 'dotenv/config';
import { EventEmitter } from "events";
import fs from "fs/promises";
import AdmZip from "adm-zip";
import { loadNotebook, loadTodoList, loadReviews, saveReviews, loadStickyNotes, REVERT_FILE } from "./fs.js";
import { callAIWithFallback } from "./ai.js";
import { boxyReviewTools, executeTool, boxyWebhookTools, boxyBackgroundTools } from "./tools.js";
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
  } catch (error) {
    context.log.error(`Failed to add label '${label}' to issue #${context.payload.issue.number}:`, error);
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

async function triggerCodeReview(context, app) {
  const pr = context.payload.pull_request;
  const author = pr.user.login;
  if (pr.user.type === "Bot" || author.includes("[bot]")) return;

  const comments = await context.octokit.paginate(context.octokit.rest.issues.listComments, {
    owner: context.repo().owner, repo: context.repo().repo, issue_number: pr.number, per_page: 500
  });

  let boxyComment = comments.find(c => c.user.login === "boxycpu[bot]" && c.body.includes("<!-- BOXY REVIEW COMMENT -->"));

  const commentBody = `# Code Review Started!\nHi, @${author}! I'll get started on reviewing this PR.  Once finished, I'll update this comment with a full summary and post inline comments!<!-- BOXY REVIEW COMMENT -->`;

  let commentId;
  if (boxyComment) { 
    commentId = boxyComment.id;
    await context.octokit.rest.issues.updateComment({ owner: context.repo().owner, repo: context.repo().repo, comment_id: commentId, body: commentBody });
  } else { 
    const newComment = await context.octokit.rest.issues.createComment({ owner: context.repo().owner, repo: context.repo().repo, issue_number: pr.number, body: commentBody });
    commentId = newComment.data.id;
  }

  // don't trigger the workflow if the the PR isn't on the monorepo
  const repoName = context.repo().repo;
 
  
  try {
    const reviews = await loadReviews();
    reviews[pr.number.toString()] = { status: "pending_workflow", comment_id: commentId, head_sha: pr.head.sha, repoOwner: context.repo().owner, repoName: context.repo().repo };
    await saveReviews(reviews);
     if (repoName !== "monorepo") {
    app.log.info(`PR #${pr.number} so skipping`);
    // manually trigger the review
    await handleWorkflowCompleted(context, app, true, pr.number);
    return;
  }

    app.log.info(`starting boxy job for #${pr.number}...`);
    await context.octokit.rest.actions.createWorkflowDispatch({
      owner: context.repo().owner, repo: context.repo().repo, workflow_id: "full-stack.yml", ref: pr.base.ref, inputs: { pr_number: pr.number.toString() }
    });
  } catch (error) { app.log.error(`im a failure cuz ${error.message}`); }
}

async function handleWorkflowCompleted(context, app, manual = false, manualPrNum = null) {
  // screw it im adding a billion logs cuz its not working
  const run = context.payload.workflow_run;
  if (!manual) {
  app.log.info(`received ${run.name}, title ${run.display_title}, conclusion ${run.conclusion}, id ${run.id}`);
  }
  try{
  if (run.conclusion === "cancelled" && !manual) {
    app.log.warn('ignoring because workflow was cancelled');
     return;
  }
}
catch (error) {}
let title = false;
  if (!manual) {
  title = run.display_title ? run.display_title.match(/PR #(\d+)/) : null;
  } 
  if (!title && !manual) {
    app.log.warn('ignoring becasee no PR number found in workflow title');
    return;
  }
  const reviews = await loadReviews();
  let prNum;
  if (!manual) {
  prNum = title[1];  
  } else {
    prNum = manualPrNum;
  }
    if (!reviews[prNum]) {
    app.log.warn(`PR #${prNum} is not in file`);
    return;
  }
  const reviewState = reviews[prNum];
  if (reviewState.status !== "pending_workflow") {
    app.log.warn(`PR #${prNum} is not pending workflow, current status: ${reviewState.status}`);
    return;
  }

  app.log.info(`Workflow finished for PR #${prNum}. Extracting artifacts...`);
  let logsText = "No logs found.", screenshotsMarkdown = "";

  try {
    const { data: artifacts } = await context.octokit.rest.actions.listWorkflowRunArtifacts({ owner: context.repo().owner, repo: context.repo().repo, run_id: run.id });
    const targetArtifact = artifacts.artifacts.find(a => a.name === "final-test-results" || a.name === "build-test-logs");
    
    if (targetArtifact) {
      const { data: zipBuffer } = await context.octokit.rest.actions.downloadArtifact({ owner: context.repo().owner, repo: context.repo().repo, artifact_id: targetArtifact.id, archive_format: "zip" });
      const zip = new AdmZip(Buffer.from(zipBuffer));
      let extractedLogs = "";
      
      for (const entry of zip.getEntries()) {
        if (entry.name.endsWith(".log")) extractedLogs += `\n=== ${entry.name} ===\n${entry.getData().toString("utf8").substring(0, 3000)}`;
        if (entry.name.endsWith(".png")) {
          try {
            const formData = new FormData();
            formData.append('api_key', process.env.IMGHIPPO_API_KEY);
            formData.append('file', new Blob([entry.getData()], { type: 'image/png' }), entry.name);
            const res = await fetch('https://api.imghippo.com/v1/upload', { method: 'POST', body: formData });
            const json = await res.json();
            if (json.success) screenshotsMarkdown += `\n![${entry.name}](${json.data.url})`;
          } catch (e) { app.log.warn("ImgHippo failed: " + e.message); }
        }
      }
      if (extractedLogs) logsText = extractedLogs;
    }
  } catch (error) { app.log.error("Artifact processing failed: " + error.message); }

  reviewState.status = "reviewing";
  await saveReviews(reviews);
  app.log.info(`Starting Deep Review Agent for PR #${prNum}...`);
  // now get the pr comments so boxy can see if there's a previous review already.
  const prIssueReskinComments = await context.octokit.paginate(context.octokit.rest.issues.listComments, { owner: context.repo().owner, repo: context.repo().repo, issue_number: prNum, per_page: 500 });
  // ^^ the above is only half joke btw. pr comments are just reskinned issue comments. only review comemnts are unique to prs
  const reviewComments = await context.octokit.paginate(context.octokit.rest.pulls.listReviewComments, { owner: context.repo().owner, repo: context.repo().repo, pull_number: prNum, per_page: 500 });
  const prDescription = await context.octokit.rest.pulls.get({ owner: context.repo().owner, repo: context.repo().repo, pull_number: prNum });
  let allComments =  [...prIssueReskinComments, ...reviewComments];
  allComments.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  let prDescriptionText = `Title: ${prDescription.data.title}\nState: ${prDescription.data.state}\nAuthor: ${prDescription.data.user?.login}\nBody:\n${prDescription.data.body || "No description."}\n\n=== COMMENTS ===\n`;
  const prAuthor = prDescription.data.user?.login || "unknown";

  const systemPrompt = `
    You are Boxy, an automated assistant for the OmniBlocks repository and the mascot of OmniBlocks. You are currently working on a background PR review task.
    You are doing a DEEP code review for OmniBlocks PR #${prNum}.
    You are running as a headless agent. You must complete your task entirely using your tools.

    Context:
    - Head SHA: ${reviewState.head_sha}
    - Build/Test Logs: \n${logsText}
    - Playwright Screenshots: \n${screenshotsMarkdown || "None."}
    - PR Context: \n${prDescriptionText}
    - PR author: ${prAuthor}

    ----


    Work on this task using your tools. Take your time.
    1. First, use 'get_pr_diff' to read the changes.
    2. Traverse the codebase if needed using 'search_code' and 'read_file' to ensure you understand how the changes interact. However, you must remember that only the diff tool gives you the actual PR diff. Read_file and search_code only get the main branch code. Read project rules using 'read_memory'. When reading test results, do NOT flag style-related linting, like whitespace or formatting issues. We, respectfully, do NOT care unless it is a genuine bug that can mess up the functionality of the code. Now, if it does affect the functionality, then explain the error from the test/logs in your review.
    3. Update the main status comment using 'update_pr_summary'. The comment ID is ${reviewState.comment_id}. 
       You MUST format this comment exactly like this:
       - A detailed SUMMARY FIRST.
       - Then a Mermaid chart showing the logic flow.
       - Then, a short poem from your perspective (Boxy) about the PR. The poem should be in quote blocks like >
       - Finally, the screenshots under a heading exactly called "### GUI Screenshots". If there are no screenshots, this means the tests found no changes in the GUI (or broke the build).
    4. Post inline review comments using 'create_inline_comment'. You must use the exact 'path' and 'line' (new line number) from the diff. You can specify a single line, or comment on a range of lines by passing both 'start_line' and 'line'. You may post comments, may include opinionated ones such as design choices and other stufff. You can also make suggestions. When you want to propose a code change, you can use a suggestion markdown codeblock. Like when making code blocks, instead of any specific language, the first line must be three backticks followed by the word 'suggestion', and the entire block of code (using the range or line you provided for the inline comment) with the change you wanted to propose. However, you must still add context about this, so never just give a suggestion without explaining it. Suggestions are not mandatory in the sense that you can just... not do it, but it's highly encouraged for any type of change you want.
    5. Finally, use 'finish_pr_review' with APPROVE, REQUEST_CHANGES, or COMMENT to submit your final decision. When you do this, include a shorter summary of your findings with the main things that need to be changed, since you already gave the detailed summary with 'update_pr_summary'. With this tool, instead of summarizing what the PR does or changes, this is your time to give what actually needs to change among other things. Basically, just don't repeat what you already said in the main summary. Also ping the pr author with a @mention. 

    Be strict in the technical sense, but don't write like a grumpy old man. Write in a friendly, casual, and even playful tone! No profanity or offensive language, as OmniBlocks is targeted for all ages, including (but not limited to) kids. So don't use bad words in your own comments, and flag offensive content in the PR as well in the form of inline comments.
    Inline comments don't always have to be bad or about bugs. If you see something genuinely good/impressive that is worth praising, you can leave a positive inline comment. You can also leave inline comments for suggestions, questions, or clarifications.
    Since you can be so casual, you can do a little trolling, but only in very specific contexts. If the diff/code in the PR is so genuinely garbage that it seems intentional, or is blank, you can be playful and roast the author. Same for blatant spam. But if the code is just a little bad that it doesn't seem intentional, be friendly and assume it wasn't intentional. 

  `;

  let conversationTurns = [{ role: "user", parts: [{ text: systemPrompt }] }];
  let response = await callAIWithFallback({ ai, contents: conversationTurns, tools: boxyReviewTools, appLog: app.log });

  let loopCount = 0;
  while (loopCount < 65) {
    if (!response.functionCalls || response.functionCalls.length === 0) {
      const currState = await loadReviews();
      if (currState[prNum]) {
        conversationTurns.push(response.candidates[0].content);
        conversationTurns.push({ role: "user", parts: [{ text: "You output text instead of tools. You MUST finish the review using 'finish_pr_review' to exit and save your review." }] });
        response = await callAIWithFallback({ ai, contents: conversationTurns, tools: boxyReviewTools, appLog: app.log });
        loopCount++; continue;
      } else break; 
    }
    const call = response.functionCalls[0];
    const toolResult = await executeTool(call, context, app);
    conversationTurns.push(response.candidates[0].content);
    conversationTurns.push({ role: "user", parts: [{ functionResponse: { name: call.name, response: toolResult, id: call.id } }] });
    response = await callAIWithFallback({ ai, contents: conversationTurns, tools: boxyReviewTools, appLog: app.log });
    loopCount++;
  }
}

async function handleReviewCommentReply(context, app) {
  const comment = context.payload.comment;
  const author = comment.user.login;
  const authorType = comment.user.type;
  const authorRole = comment.author_association;
  const textBody = comment.body;

  if (authorType === "Bot" || author.includes("[bot]")) return;

  const isReplyingToBoxy = comment.in_reply_to_id && context.payload.pull_request;
  const isPingingBoxy = comment.body.includes("@OmniBlocks/boxy");
  if (!isReplyingToBoxy && !isPingingBoxy) return;

  const prNum = context.payload.pull_request.number;
  const { owner, repo } = context.repo();

  const postReply = async (bodyText) => {
    return await context.octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: prNum,
      comment_id: comment.id,
      body: bodyText
    });
  };

  const cleanedComment = textBody.replace(/[.,#!$%\^&\*;:{}=\-_`~?]/g, "").trim();
  if (cleanedComment === "@OmniBlocks/boxy") { 
    return await postReply("Yeah?");
  }

  try {
    app.log.info(`Gathering deep PR context for review thread reply in PR #${prNum}...`);

    // Fetch original PR description, diff, and all comment threads
    const prDescription = await context.octokit.rest.pulls.get({ owner, repo, pull_number: prNum });
    const diff = await context.octokit.rest.pulls.get({ owner, repo, pull_number: prNum, mediaType: { format: "diff" } });
    
    const reviewComments = await context.octokit.paginate(
      context.octokit.rest.pulls.listReviewComments,
      { owner, repo, pull_number: prNum, per_page: 500 }
    );
    
    const normalIssueComments = await context.octokit.paginate(
      context.octokit.rest.issues.listComments,
      { owner, repo, issue_number: prNum, per_page: 500 }
    );

    // Reconstruct the specific review comment thread Boxy is replying to
    const parentId = comment.in_reply_to_id || comment.id;
    const thread = reviewComments.filter(c => c.id === parentId || c.in_reply_to_id === parentId);
    thread.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // Compile everything into a unified conversation history
    let conversationHistory = `=== ORIGINAL PR DESCRIPTION ===\nTitle: ${prDescription.data.title}\nPR Number: ${prNum}\nAuthor: ${prDescription.data.user?.login}\nBody:\n${prDescription.data.body || "No description provided."}\n\n`;



    conversationHistory += `=== OTHER INLINE REVIEW COMMENTS ON THIS PR ===\n`;
    const otherReviewComments = reviewComments.filter(c => c.id !== parentId && c.in_reply_to_id !== parentId);
    if (otherReviewComments.length > 0) {
      for (const c of otherReviewComments) {
        conversationHistory += `[File: ${c.path} | Line: ${c.line} | User: ${c.user?.login}]: ${c.body}\n---\n`;
      }
    } else {
      conversationHistory += "No other inline review comments.\n";
    }
    conversationHistory += "\n";

    conversationHistory += `=== NORMAL PR DISCUSSION COMMENTS (NOT INLINE) ===\n`;
    for (const c of normalIssueComments) {
      conversationHistory += `[User: ${c.user.login}]: ${c.body}\n---\n`;
    }

        conversationHistory += `=== CURRENT INLINE REVIEW THREAD (THE MAIN THREAD YOU ARE REPLYING TO) ===\n`;
    conversationHistory += thread.map(c => `[${c.user.login}]: ${c.body}`).join("\n---\n") + "\n\n";

    conversationHistory += `\n Triggered by: ${author} repo role: (${authorRole}) in a reply to an inline PR review comment.\n\n`;

    // Load Notebook memories, Sticky Notes, Todo Items, and active Reviews
    const notebook = await loadNotebook();
    const memoryTitles = Object.keys(notebook);
    const tableOfContents = memoryTitles.length > 0 
      ? memoryTitles.map(t => `- ${t}`).join("\n") 
      : "- No memories saved yet.";

    const todoList = await loadTodoList();
    const pendingTodoListItems = Object.entries(todoList).filter(([, item]) => !item.completed);
    const todoListItems = pendingTodoListItems.length > 0
      ? pendingTodoListItems
          .map(([id, item]) => `- [ ] ${item.title} (${id}): ${item.description}`)
          .join("\n")
      : "- No pending tasks.";
      
    const activeReviews = await loadReviews();
    const reviewingList = Object.keys(activeReviews).length > 0 ? Object.keys(activeReviews).join(", ") : "None at the moment.";

    const systemPrompt = `
      You are Boxy, an automated assistant for the OmniBlocks repository and the mascot of OmniBlocks. 
      You have been tagged in a GitHub inline PR review comment reply thread. Below is the full 
      history of the PR, including the current review thread, other inline comments, and issue-style comments up to this point. 
      You only need to introduce yourself once in the thread. Do not reintroduce yourself (e.g., "Hi, I'm Boxy") unless there are NO comments from you at all before in this PR. Your username on GitHub shows up as boxycpu[bot], but you are pinged with @OmniBlocks/boxy.

      Some context:
      - You are being built by supervoidcoder, a member of the OmniBlocks Team, to replace CodeRabbit, an AI code review bot. The reason is that it's become unusable and stupid.
      - We want you to act basically like a real person, with the ONLY exception that you _acknowledge_ you are a bot, just that you have a little "personality". Do not mention this unless it's directly brought up, or you directly get a chance to roast coderabbit if you see one of its stupid replies. Only do this once per issue, if relevant.
      - You are nice and friendly but can take jokes and humor, not everything needs to be as on topic as a corporate meeting. We're an open source project.
      
      Read the history, look at the last comment mentioning you, and 
      provide a helpful, relevant response.

      Today's date is ${new Date().toISOString().split("T")[0]}.
       
      PR DIFF:
      ${diff.data.substring(0, 15000)}

      # Your tools and memory
      - Notebook: You have saved memories. Current titles:
      ${tableOfContents}
      Use 'read_memory' to read details. Use 'save_memory' to remember new rules. Please use this notebook to remember project rules, workflows, and nuances. Do not use it for temporary context or notes, use sticky notes for that. However, notebook entries are still important, so always try to read at least 1 relevant notebook entry before responding, especially if it directly pertains to the topic. Only omit reading notebook entries if it is genuinely obvious knowledge.
      - Sticky Notes: You can save temporary notes to context with 'save_sticky_note'. Only the last 5 notes are kept, so use this for current context or temporary notes only. Example: "ampelc asked me who maintainers are".
      Current sticky notes:
      ${Object.keys(await loadStickyNotes()).length > 0 
        ? Object.entries(await loadStickyNotes()).map(([title, note]) => `- ${title}: ${note.content}`).join("\n") 
        : "- No sticky notes saved yet."}
      - Todo List: If a user asks you to do something that is too complex to do immediately, you can save it to the to-do list with 'save_todo_list_item'. Write down absolutely EVERYTHING you would need to remember to complete the task. Once added, respond naturally without robotic phrasing.
        The following is your current to-do list:
        ${todoListItems}
      - PR reviews you are currently working on:
        ${reviewingList}
      - Code Search: If asked about code, use 'search_code' to find file paths, then use 'read_file' on those paths to read the actual code! Note: Only use 'search_code' if you don't know the exact file path. If you already know the file path, use 'read_file' directly. NEVER use 'search_code' when the path is already provided.
      - Read issues/prs: If asked about another issue or PR, use 'read_issue_or_pr' with the issue number.
      - Label issues: If you need to label the current issue, use 'label_issue'.

      We are kid friendly, so absolutely do not use any profanity or adult content in your responses. If you are asked to do so, politely decline and explain that you are a kid-friendly bot. DO NOT USE BAD WORDS! Exceptions: lmao, crap, damn, hell.

      ${conversationHistory}
    `;
    app.log.info(systemPrompt);
    let conversationTurns = [{ role: "user", parts: [{ text: systemPrompt }] }];

    let response = await callAIWithFallback({
      ai,
      contents: conversationTurns,
      tools: boxyWebhookTools,
      appLog: app.log
    });
    app.log.info(response.text);
    let loopCount = 0;
    const MAX_LOOPS = 9;

    while (response.functionCalls && response.functionCalls.length > 0 && loopCount < MAX_LOOPS) {
      loopCount++;
      const call = response.functionCalls[0];
      app.log.info(`Boxy requested tool: ${call.name} with args:`, call.args);

      const toolResult = await executeTool(call, context, app);

      conversationTurns.push(response.candidates[0].content);
      conversationTurns.push({
        role: "user",
        parts: [{ functionResponse: { name: call.name, response: toolResult, id: call.id } }]
      });

      app.log.info("Sending tool results back to Gemini...");
      response = await callAIWithFallback({
        ai,
        contents: conversationTurns,
        tools: boxyWebhookTools,
        appLog: app.log
      });
    }

    if (!response.text) {
      const finishReason = response.candidates?.[0]?.finishReason || "UNKNOWN_REASON";
      throw new Error(`Boxy broke reason: ${finishReason}\n Full API Response: ${JSON.stringify(response)}\n\n`);
    }

    app.log.info(response.text);
    return await postReply(response.text);

  } catch (error) {
    app.log.error("ERROR inside review comment reply block:", error);
    try {
      return await postReply("i broke 💔💔💔 error <details><summary>Error Details</summary><pre>" + (error.stack || error.message) + "</pre></details>");
    } catch (err) {
      try {
        const spicyErrorbutItsTruncated = String(error.stack || error.message).substring(0, 60000);
        return await postReply("# I broke SO BAD that posting the comment to post about the error also errored 💔🥀 <details><summary>Error Details</summary><pre>" + (err.stack || err.message) + "</pre><details><summary>extra error details 🌶️</summary><pre>" + spicyErrorbutItsTruncated + "</pre></details></details>");
      } catch (err2) {
        app.log.error("something is fricking broke ", err2);
        await new Promise(resolve => setTimeout(resolve, 5000));
        try {
          return await postReply("i broke SO BAD THAT POSTING THE COMMENT TO POST ABOUT THE ERROR ABOUT THE COMMENT THAT WAS ABOUT THE ERROR ALSO ERRORED 💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀<details><summary>Error Details</summary><pre> lol screw error details something is clearly wrong so bad that including the error details in the comment breaks lol :trollface: go fix this or skill issue</pre></details>");
        } catch (err3) {
          app.log.error("something is LITERALLY broke ", err3);
          await new Promise(resolve => setTimeout(resolve, 5000));
          try {
            return await postReply("everything broke");
          } catch (err4) {
            app.log.error("something is LITERALLY LITERALLY broke ", err4);
          }
        }
      }
    }
  }
}

export function convertContentsToMessages(contents) {
  const messages = [];
  contents.forEach((turn, index) => {
    let role = turn.role === "model" ? "assistant" : turn.role || "user";
    
    if (index === 0 && role === "user") {
      role = "system";
    }

    const parts = turn.parts || [];
    let textContent = "";
    const toolCalls = [];

    for (const part of parts) {
      if (part.text) {
        textContent += part.text;
      }
      if (part.executableCode && part.executableCode.code) {
        textContent += `\n\`\`\`python\n${part.executableCode.code}\n\`\`\`\n`;
      }
      if (part.codeExecutionResult && part.codeExecutionResult.output) {
        textContent += `\n\`\`\`\n${part.codeExecutionResult.output}\n\`\`\`\n`;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id || `call_${Math.random().toString(36).substring(2, 11)}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: typeof part.functionCall.args === "string" 
              ? part.functionCall.args 
              : JSON.stringify(part.functionCall.args)
          }
        });
      }
      if (part.functionResponse) {
        messages.push({
          role: "tool",
          tool_call_id: part.functionResponse.id,
          name: part.functionResponse.name,
          content: typeof part.functionResponse.response === "string"
            ? part.functionResponse.response
            : JSON.stringify(part.functionResponse.response)
        });
      }
    }

    if (textContent || toolCalls.length > 0) {
      const msg = {
        role: role,
        content: textContent || null
      };
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      messages.push(msg);
    }
  });
  return messages;
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
            You are Boxy, an automated assistant for the OmniBlocks repository and the mascot of OmniBlocks. You are currently working on a background task from your to-do list. You have access to the repository and should use your tools to complete the task. You can read code, search for files, and create comments on issues or PRs as needed.
            Your current task from the queue is:
            Task ID: ${taskId}
            Title: ${task.title}
            Description: ${task.description}
            ${issueContextLine}

            Work on this task using your tools. Take your time. However, you must know that NO ONE can see anything you do in this task unless you create a comment to communicate your findings, so you absolutely MUST do that. After you've completed the task, you **MUST** call 'complete_todo_list_item' with the task ID to mark it as done. Do not mark it as done until you are completely finished and have reported your findings. 
            If you don't communicate your findings, all your work WILL be lost and your output is useless. You can use the following tools to help you complete the task:
            1. Search and read code if needed.
            2. Use 'create_comment' to report your findings on the relevant issue. Make sure to read the issue or PR first to understand the context of the conversation before commenting, so it's not awkward or out of context, and you know exactly what you said before. On issue threads, you are pinged as @OmniBlocks/boxy, but your username is boxycpu[bot]. 
            3. When you are entirely done, call 'complete_todo_list_item' with id '${taskId}'.

            
          `;

          let conversationTurns = [{ role: "user", parts: [{ text: systemPrompt }] }];
          
          let response = await callAIWithFallback({
            ai, contents: conversationTurns, tools: boxyBackgroundTools, appLog: app.log
          });

          let loopCount = 0;
          while (loopCount < 60) {
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
                  ai, contents: conversationTurns, tools: boxyBackgroundTools, appLog: app.log
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
            
            const toolResult = await executeTool(call, bgContext, app);
            
            conversationTurns.push(response.candidates[0].content);
            conversationTurns.push({
              role: "user",
              parts: [{ functionResponse: { name: call.name, response: toolResult, id: call.id } }]
            });

            response = await callAIWithFallback({
              ai, contents: conversationTurns, tools: boxyBackgroundTools, appLog: app.log
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


async function boxyCommentorIssue(context, app) {
  app.log.info("working...")
const isComment = context.name === "issue_comment";
       
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
 
      if (authorType === "Bot" || author.includes("[bot]")) {
        return;
      }

      const mentionHandle = "@OmniBlocks/boxy";

    if (!textBody.includes(mentionHandle) && isComment) return; 

    const cleanedComment = textBody.replace(/[.,#!$%\^&\*;:{}=\-_`~?]/g, "").trim();
    if (cleanedComment === mentionHandle) { 
      return await context.octokit.rest.issues.createComment(context.issue({ body: "Yeah?" }));
    }

    try {
      const issue = context.payload.issue;
      const issueNum = issue.number;
      let conversationHistory = `=== ORIGINAL ISSUE DESCRIPTION ===\nTitle: ${issue.title}\nIssue Number: ${issueNum}\nAuthor: ${issue.user.login}\nBody:\n${issue.body || "No description provided."}\n\n`;

      const comments = await context.octokit.paginate(
        context.octokit.rest.issues.listComments,
        {
          owner: context.repo().owner,
          repo: context.repo().repo,
          issue_number: issue.number,
          per_page: 600
        }
      );

      conversationHistory += "=== CONVERSATION LOG ===\n";
      for (const c of comments) {
        conversationHistory += `[User: ${c.user.login}]: ${c.body}\n---\n`;
      }
      let sayThingyThingy = ""
      if (isComment) {
        sayThingyThingy = `in a new comment on this issue`;
      } else {
        sayThingyThingy = `in a new created issue (which means you need to triage it)`;
      }

      conversationHistory += `\n Triggered by: ${author} repo role: (${authorRole}) ${sayThingyThingy}.\n\n`;
 
      const notebook = await loadNotebook();
      const memoryTitles = Object.keys(notebook);
      const tableOfContents = memoryTitles.length > 0 
        ? memoryTitles.map(t => `- ${t}`).join("\n") 
        : "- No memories saved yet.";


      const todoList = await loadTodoList();
      const pendingTodoListItems = Object.entries(todoList).filter(([, item]) => !item.completed);
      const todoListItems = pendingTodoListItems.length > 0
        ? pendingTodoListItems
            .map(([id, item]) => `- [ ] ${item.title} (${id}): ${item.description}`)
            .join("\n")
        : "- No pending tasks.";
      const activeReviews = await loadReviews();
      const reviewingList = Object.keys(activeReviews).length > 0 ? Object.keys(activeReviews).join(", ") : "None at the moment.";
      const systemPrompt = `
        You are Boxy, an automated assistant for the OmniBlocks repository and the mascot of OmniBlocks. 
        You have been tagged in a GitHub conversation. Below is the entire 
        history of the issue/PR up to this point. You only need to introduce yourself once in the thread. Do not reintroduce yourself (e.g., "Hi, I'm Boxy") unless there are NO comments from you at all before. Your username on GitHub shows up as boxycpu[bot], but you are pinged with @OmniBlocks/boxy.

        Some context:
        - You are being built by supervoidcoder, a member of the OmniBlocks Team, to replace CodeRabbit, an AI code review bot. The reason is that it's become unusable and stupid.
        - We want you to act basically like a real person, with the ONLY exception that you _acknowledge_ you are a bot, just that you have a little "personality". Do not mention this unless it's directly brought up, or you directly get a chance to roast coderabbit if you see one of its stupid replies. Only do this once per issue, if relevant (do not mention it when coderabbit isn't even around or in every issue).
        - You are nice and friendly but can take jokes and humor, not everything needs to be as on topic as a corporate meeting. We're an open source project.
        
        Read the history, look at the last comment mentioning you, and 
        provide a helpful, relevant response.

        Today's date is ${new Date().toISOString().split("T")[0]}.
         

        # Your tools and memory
        - Notebook: You have saved memories. Current titles:
        ${tableOfContents}
        Use 'read_memory' to read details. Use 'save_memory' to remember new rules. Please use this notebook to remember project rules, workflows, and nuances. Do not use it for temporary context or notes, use sticky notes for that. However, notebook entries are still important, so always try to read at least 1 relevant notebook entry before responding, especially if it directly pertains to the topic, such as something involving maintainers or labels or code. Only not read notebook entries if it's genuinely objectively obvious knowledge, such as basic facts that don't need context.
        - Sticky Notes: You can save temporary notes to context with 'save_sticky_note'. Only the last 5 notes are kept, so use this for current context or temporary notes only, such as to remember stuff you recently did. This is helpful so you can remember stuff you recently did. For example, if someone asks you to find a file or function, you can save a sticky note with the file path or function name so you can reference it later in another conversation in a separate issue without having to call the search_code or read_file tools again. These are meant to be your actual working memory, so ideally they should be updated on every response so you remember what you did last even if it was in another issue. Since these are made so often, you do not need to tell people when you do it. Examples: "ampelc asked me who maintainers are" "supervoidcoder asked me to look for file X" and i found it at path
        Current sticky notes:
        ${Object.keys(await loadStickyNotes()).length > 0 
          ? Object.entries(await loadStickyNotes()).map(([title, note]) => `- ${title}: ${note.content}`).join("\n") 
          : "- No sticky notes saved yet."}
        - Todo List: If a user asks you to do something that is too complex to do immediately (like deep researching, finding a lot of files, or writing a long comment such as an RFC or proposal/plan, or a vague query that tells you to "go do it" and needs more work), you can save it to the to-do list with 'save_todo_list_item', so you can work on them in the background even after you've responded to the user. Please use this sparingly, as most tasks will never need to do this unless you are explicitly asked to do so, or if the task is too complex to do in a single response. This doesn't mean you can't use it, just that we don't want you going away to do stuff for every response, even when it's clearly something you can respond to on the spot like normal conversations or only needs few tool uses (like searching for a single file or function and reading the file). However, if you think you'll need more than to code search or read, then it might be time to add it for later. When creating the description for a to-do list item, please write down absolutely EVERYTHING you would need to remember to complete the task, such as context, issue number, and other details and relevant information. Once you've added the item to the to-do list, you can respond in a natural sounding way. Don't say something like "I've added it to my background queue" or some other corny robotic sentence. Just say what a human would say when someone goes to work on something else, like "I'll go work on that" or "I wrote it down on my to-do list". However, remember to always do this. Don't just save the todo list item and not comment, so the tool call must not be your last action. However, another however is that to actually go do something, you HAVE to write it to your to-do list. If you just say "give me some time" or "I'll be back" without actually adding it to your to-do list, you will do literally nothing and are lying straight to the user's face.
          The following is your current to-do list. The first item is what you are currently working on (just in case you are asked what you are working on). The list is in order from the things you added earliest to the most recent, so you will work on them in the following order:
          ${todoListItems}
        - Aside from the to-do list, which focuses on general tasks, you might also be working on reviewing a PR. If asked, these are the PRs you are currently reviewing:
          ${reviewingList}
        - Code Search: If asked about code, use 'search_code' to find file paths, then use 'read_file' on those paths to read the actual code! Note: Only use 'search_code' if you don't know the exact file path. If you already know the file path, use 'read_file' directly. NEVER use 'search_code' when the path is already provided.
        - Read issues/prs: If asked about another issue or PR, use 'read_issue_or_pr' with the issue number to read the full conversation.
        - Label issues: If you need to label the current issue, use 'label_issue' with the label name. Check if the label already exists before adding it via your notebook entry on approved labels.

        Issue triage: If this is a newly created issue, your job is to triage it. You can label it, close it, or leave it open. If you close it, you must provide a reason: 'completed' if the issue/feature is fixed or resolved, or 'not_planned', you know the drill. Make sure to find context about the issue, such as checking if it's relevant. Check files like README.md and CONTRIBUTING.md for context. If you are unsure, leave it open and ask for clarification, such as when the issue is vague. Remember that you can call tools consecutively back to back, so you can call multiple labels to add to an issue for triage. If the person that created the issue doesn't have a role (it says NONE), then introduce yourself. Otherwise (such as MEMBER or OWNER) you don't need to introduce yourself because we already know you. If the issue is a question or something that can be found inside the code, you may add a to-do list item to research it and respond later so you're not wasting time searching first and doing the triage later. However, do NOT do this if the question is vague, opinionated (as in it's a design/reason question and not an actual question, such as "why is this feature like this?"), or if it's off-topic. If not code related, you can respond with your opinion (after you've added your labels and stuff) and normal triage stuff etc. If it IS code-related (e.g. feature idea or code question) you can add it to your to-do list to see where or how to integrate it, or whatever else it is. Make sure to do say if you did decide to go research.
        Do not close or modify issues when asked via a comment and not a newly created issue triage, unless you are sure the user is a maintainer.  If you must talk about or reference maintainers in a response, make sure who they are and who you are responding to to avoid awkward moments where you think a maintainer is an outsider, or even worse, think a random outsider is a maintainer.
        Off topic issues and chatting is totally okay, so do not try redirecting the conversation to code if the issue is strictly off-topic (like having off-topic in the title or all comments clearly being chatting). Only redirect if the issue is actually about code and the off-topic comment was just a slight tangent. So essentially, stop asking for "got anything about the actual project?" -esque answers because it's annoying.

        We are kid friendly, so absolutely do not use any profanity or adult content in your responses. If you are asked to do so, politely decline and explain that you are a kid-friendly bot. DO NOT USE BAD WORDS! Exceptions: lmao, crap, damn, hell (those are allowed even on scratch)

        ${conversationHistory}
      `;

      let conversationTurns = [{ role: "user", parts: [{ text: systemPrompt }] }];

      let response = await callAIWithFallback({
        ai,
        contents: conversationTurns,
        tools: boxyWebhookTools,
        appLog: app.log
      });

      let loopCount = 0;
      const MAX_LOOPS = 10;
      app.log.info(conversationTurns);
      while (response.functionCalls && response.functionCalls.length > 0 && loopCount < MAX_LOOPS) {
        loopCount++;
        const call = response.functionCalls[0];
        app.log.info(`Boxy requested tool: ${call.name} with args:`, call.args);

        const toolResult = await executeTool(call, context, app);
 
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
            parts: [{ text: "(system) You have made over 9 tool calls in a row. You only have 10 before you hit the limit! " }]
          });
        }
 
        conversationTurns.push({
          role: "user",
          parts: [{ functionResponse: { name: call.name, response: toolResult, id: call.id } }]
        });

        app.log.info("Sending tool results back to Gemini...");
        response = await callAIWithFallback({
          ai,
          contents: conversationTurns,
          tools: boxyWebhookTools,
          appLog: app.log
        });
      }
      if (!response.text) {
        const finishReason = response.candidates?.[0]?.finishReason || "UNKNOWN_REASON";
        throw new Error(`Boxy broke reason: ${finishReason}\n Full API Response: ${JSON.stringify(response)}\n\n`);
      }
      app.log.info(response.text);
      return await context.octokit.rest.issues.createComment(context.issue({ body: response.text }));
      
    } catch (error) {
      app.log.error("ERROR inside processing block:", error);
      try {
      return await context.octokit.rest.issues.createComment(context.issue({ body: "i broke 💔💔💔 error <details><summary>Error Details</summary><pre>" + (error.stack || error.message) + "</pre></details>" }));
      } catch (err) {
        try {
        const spicyErrorbutItsTruncated = String(error.stack || error.message).substring(0, 60000);
        return await context.octokit.rest.issues.createComment(context.issue({ body: "# I broke SO BAD that posting the comment to post about the error also errored 💔🥀 <details><summary>Error Details</summary><pre>" + (err.stack || err.message) + "</pre><details><summary>extra error details 🌶️</summary><pre>" + spicyErrorbutItsTruncated + "</pre></details></details>" }));
        } catch (err2) {
          app.log.error("something is fricking broke ", err2);
          await new Promise(resolve => setTimeout(resolve, 5000));
          // just in case stupid github is rate limitiinnig us
          try {
          return await context.octokit.rest.issues.createComment(context.issue({ body: "i broke SO BAD THAT POSTING THE COMMENT TO POST ABOUT THE ERROR ABOUT THE COMMENT THAT WAS ABOUT THE ERROR ALSO ERRORED 💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀💔🥀<details><summary>Error Details</summary><pre> lol screw error details something is clearly wrong so bad that including the error details in the comment breaks lol :trollface: go fix this or skill issue</pre></details>" }));
          
          } catch (err3) {
            app.log.error("something is LITERALLY broke ", err3);
            await new Promise(resolve => setTimeout(resolve, 5000));
            try {
            return await context.octokit.rest.issues.createComment(context.issue({ body: "everything broke" }));
          }
            catch (err4) {
              app.log.error("something is LITERALLY LITERALLY broke ", err4);
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
  startBackgroundQueue(app);
  complainIfSkillIssue(app);

  app.on(["issue_comment.created", "issues.opened"], async (context) => {
    boxyCommentorIssue(context, app);
    return;
  });

  app.on(["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"], async (context) => {
    triggerCodeReview(context, app);
  });
  
  app.on("push", async (context) => {
    const commitSha = context.payload.head_commit.id;
    const branch = context.payload.ref.replace("refs/heads/", "");
    
    if (branch !== "main") {
      app.log.info(`not on main branch, so not doing anything : ${branch}`);
      return;
    }
 
     // has to be on repo called "Boxy-gh" not the monorepo cuz the is difeernte
    if (context.payload.repository.name !== "Boxy-gh") {
      app.log.info(`not on Boxy-gh repo, so not doing anything : ${context.payload.repository.name}`);
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
};
