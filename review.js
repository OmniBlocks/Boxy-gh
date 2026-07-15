import AdmZip from 'adm-zip';
import { callAIWithFallback } from './ai';
import { loadReviews, saveReviews, loadNotebook, loadTodoList, loadStickyNotes } from './fs';
import { boxyReviewTools, executeTool, boxyWebhookTools } from './tools';

export async function triggerCodeReview(context, app) {
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
export async function handleWorkflowCompleted(context, app, manual = false, manualPrNum = null) {
  // screw it im adding a billion logs cuz its not working
  const run = context.payload.workflow_run;
  if (!manual) {
    app.log.info(`received ${run.name}, title ${run.display_title}, conclusion ${run.conclusion}, id ${run.id}`);
  }
  try {
    if (run.conclusion === "cancelled" && !manual) {
      app.log.warn('ignoring because workflow was cancelled');
      return;
    }
  }
  catch (error) { }
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
  let allComments = [...prIssueReskinComments, ...reviewComments];
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
export async function handleReviewCommentReply(context, app) {
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
