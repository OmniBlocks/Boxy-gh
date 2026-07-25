import { spawn, exec } from "child_process";
import { promisify } from "util";
import { loadTodoList, loadReviews } from "./fs.js";

const execAsync = promisify(exec);
const CONTAINER_NAME = "boxy-runner";
const DELIMITER = "__BOXY_DELIM__";

let activeShell = null;
let activeTask = null; 

async function ensureContainerRunning() {
  try {
    const { stdout } = await execAsync(`docker inspect -f "{{.State.Running}}" ${CONTAINER_NAME}`);
    if (stdout.trim() === "true") return;
    await execAsync(`docker start ${CONTAINER_NAME}`);
  } catch (err) {
    const createCmd = `docker run -d --name ${CONTAINER_NAME} \
      --restart unless-stopped \
      --memory="256m" \
      --memory-swap="256m" \
      -v /home/gato/boxy-workspace:/workspace \
      -w /workspace \
      node:20-alpine tail -f /dev/null`;
    await execAsync(createCmd);
  }
}

async function getShell() {
  if (activeShell && !activeShell.killed) return activeShell;
  
  await ensureContainerRunning();

  activeShell = spawn("docker", ["exec", "-i", CONTAINER_NAME, "/bin/sh"]);

  activeShell.stdout.on("data", (data) => {
    if (!activeTask) return;
    activeTask.stdout += data.toString();
  });

  activeShell.stderr.on("data", (data) => {
    if (!activeTask) return;
    activeTask.stderr += data.toString();
  });

  activeShell.on("close", () => {
    activeShell = null;
    if (activeTask) {
      activeTask.status = "closed";
    }
  });

  return activeShell;
}

export async function runCommandInBoxyContainer(command, isBoxyWebhook = false, token = null, timeSliceMs = 10000) {
  let isBusy = false;
  const todoList = await loadTodoList();
  for (const [id, item] of Object.entries(todoList)) {
    if (!item.completed) { isBusy = true; break; }
  }
  if (!isBusy) {
    const reviews = await loadReviews();
    if (Object.keys(reviews).length > 0) isBusy = true;
  }
  if (isBusy && isBoxyWebhook) {
    return { stdout: "", stderr: "You're using the computer to work on another task on your to-do list right now.", exitCode: 1 };
  }

  const shellProcess = await getShell();
 
  if (!activeTask && command) {
    activeTask = {
      stdout: "",
      stderr: "",
      status: "running"
    };

    if (token && (command.includes("git") || command.includes("gh"))) {
      shellProcess.stdin.write(`export GITHUB_TOKEN=${token}\n`);
      shellProcess.stdin.write(`git config --global url.'https://x-access-token:${token}@github.com/'.insteadOf 'https://github.com/'\n`);
    }

    shellProcess.stdin.write(`${command}\n\n`);
    shellProcess.stdin.write(`echo "${DELIMITER}$?"\n`);
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeSliceMs) {
    if (!activeTask) break;

    const match = activeTask.stdout.match(new RegExp(`${DELIMITER}(\\d+)`));
    if (match) {
      const exitCode = parseInt(match[1], 10);
      const cleanStdout = activeTask.stdout.split(DELIMITER)[0].trim();
      const cleanStderr = activeTask.stderr.trim();
      
      activeTask = null; 
      return { status: "completed", stdout: cleanStdout, stderr: cleanStderr, exitCode };
    }

    if (activeTask.status === "closed") {
      activeTask = null;
      return { status: "failed", stderr: "Shell process closed unexpectedly.", exitCode: 1 };
    }

    await new Promise(r => setTimeout(r, 200)); // Poll every 200ms
  }

  return {
    status: "still_running",
    stdout: activeTask ? activeTask.stdout.trim() : "",
    stderr: activeTask ? activeTask.stderr.trim() : "",
    message: "The command is still running or waiting for interaction. Look at the stdout above. You can call 'send_stdin' to reply to a prompt, 'wait_command' to give it more time, or 'kill_command' to cancel it."
  };
}

/**
 * Send interactive user input (stdin) to the running command
 */
export async function sendStdinToBoxyContainer(text) {
  if (!activeShell || !activeTask) {
    return { error: "No command is currently running to send input to." };
  }

  const input = text.endsWith("\n") ? text : text + "\n";
  activeShell.stdin.write(input);

  return await runCommandInBoxyContainer(null, false, null, 10000);
}

export async function waitCommandInBoxyContainer(timeSliceMs = 10000) {
  if (!activeTask) {
    return { error: "No command is currently running to wait for." };
  }
  return await runCommandInBoxyContainer(null, false, null, timeSliceMs);
}

export async function killCommandInBoxyContainer() {
  if (!activeShell || !activeTask) {
    return { error: "No command is currently running to kill." };
  }
  activeShell.stdin.write("\x03\n");
  await new Promise(r => setTimeout(r, 500));

  const partialStdout = activeTask.stdout;
  const partialStderr = activeTask.stderr;
  activeTask = null;

  return {
    status: "killed",
    message: "Command was cancelled with SIGINT (Ctrl+C).",
    last_stdout: partialStdout.trim(),
    last_stderr: partialStderr.trim()
  };
}

export async function getBoxyCwd() {
  const result = await runCommandInBoxyContainer("pwd", false);
  return result.status === "completed" ? result.stdout.trim() : "/workspace";
}