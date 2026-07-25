import { spawn, exec } from "child_process";
import { promisify } from "util";
import { loadTodoList, loadReviews } from "./fs.js";

const execAsync = promisify(exec);
const CONTAINER_NAME = "boxy-runner";
const MAX_OUTPUT_SIZE = 200000; 

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
 
    if (activeTask.stdout.length > MAX_OUTPUT_SIZE) {
      activeTask.stdout = "[...OUTPUT TRUNCATED DUE TO SIZE LIMIT...]\n" + activeTask.stdout.slice(-MAX_OUTPUT_SIZE);
    }
  });

  activeShell.stderr.on("data", (data) => {
    if (!activeTask) return;
    activeTask.stderr += data.toString();
    

    if (activeTask.stderr.length > MAX_OUTPUT_SIZE) {
      activeTask.stderr = "[...STDERR TRUNCATED DUE TO SIZE LIMIT...]\n" + activeTask.stderr.slice(-MAX_OUTPUT_SIZE);
    }
  });

  activeShell.on("close", () => {
    activeShell = null;
    if (activeTask) {
      activeTask.status = "closed";
    }
  });

  return activeShell;
}

/**
 * Runs or continues polling a command for a specified time slice (default 10 seconds)
 */
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

  if (activeTask && command) {
    return {
      status: "busy",
      stderr: "The container is currently busy executing another command. Use 'send_stdin' to reply to prompts, 'wait_command' to give it more time, or 'kill_command' to stop it.",
      exitCode: 1
    };
  }

  if (!activeTask && command) {
    const uniqueDelimiter = `__BOXY_DELIM_${Date.now()}_${Math.random().toString(36).substring(2, 9)}__`;

    activeTask = {
      stdout: "",
      stderr: "",
      status: "running",
      delimiter: uniqueDelimiter,
      command
    };

    if (token && (command.includes("git") || command.includes("gh"))) {
      shellProcess.stdin.write(`export GITHUB_TOKEN=${token}\n`);
      shellProcess.stdin.write(`git config --global url.'https://x-access-token:${token}@github.com/'.insteadOf 'https://github.com/'\n`);
    }

    const safeCmd = command.replace(/'/g, "'\\''");
    const wrappedStr = `sh -c 'echo $$ > /tmp/.boxy_pid; exec ${safeCmd}'; echo "${uniqueDelimiter}$?"\n`;
    
    shellProcess.stdin.write(wrappedStr);
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeSliceMs) {
    if (!activeTask) break;

    const delimIndex = activeTask.stdout.indexOf(activeTask.delimiter);
    if (delimIndex !== -1) {
      const outputParts = activeTask.stdout.split(activeTask.delimiter);
      const cleanStdout = outputParts[0].trim();
      const exitCodeMatch = outputParts[1].match(/^(\d+)/);
      const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;
      const cleanStderr = activeTask.stderr.trim();

      activeTask = null; 
      return { status: "completed", stdout: cleanStdout, stderr: cleanStderr, exitCode };
    }

    if (activeTask.status === "closed") {
      activeTask = null;
      return { status: "failed", stderr: "Shell process closed unexpectedly.", exitCode: 1 };
    }

    await new Promise(r => setTimeout(r, 200)); 
  }
  return {
    status: "still_running",
    stdout: activeTask ? activeTask.stdout.trim() : "",
    stderr: activeTask ? activeTask.stderr.trim() : "",
    message: "The command is taking longer than usual or waiting for interactive input. Look at stdout above. You can call 'send_stdin' to respond, 'wait_command' to continue waiting, or 'kill_command' to terminate it."
  };
}

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
  if (!activeTask) {
    return { error: "No command is currently running to kill." };
  }

  try {
    await execAsync(`docker exec ${CONTAINER_NAME} sh -c "kill -9 \$(cat /tmp/.boxy_pid 2>/dev/null) 2>/dev/null"`);
  } catch (err) {
    try {
      await execAsync(`docker exec ${CONTAINER_NAME} pkill -9 -f "${activeTask.command.substring(0, 15)}"`);
    } catch (e) {}
  }

  const partialStdout = activeTask.stdout.split(activeTask.delimiter)[0].trim();
  const partialStderr = activeTask.stderr.trim();
  activeTask = null;

  return {
    status: "killed",
    message: "Command was forcefully terminated.",
    last_stdout: partialStdout,
    last_stderr: partialStderr
  };
}

export async function getBoxyCwd() {
  const result = await runCommandInBoxyContainer("pwd", false);
  return result.status === "completed" ? result.stdout.trim() : "/workspace";
}