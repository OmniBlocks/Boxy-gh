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
  

  const shellProcess = await getShell();

  if (activeTask && command) {
    if (isBusy && isBoxyWebhook) {
    return { stdout: "", stderr: "You're using the computer to work on another task on your to-do list right now.", exitCode: 1 };
  } else {
    return {
      status: "busy",
      stderr: "The container is currently busy executing another command. Use 'send_stdin' to reply to prompts, 'wait_command' to give it more time, or 'kill_command' to stop it.",
      exitCode: 1
    };
  }
  }

  if (!activeTask && command) {
    const uniqueDelimiter = `__BOXY_DELIM_${Date.now()}_${Math.random().toString(36).substring(2, 9)}__`;
    const pidFile = `/tmp/.boxy_pid_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    activeTask = {
      stdout: "",
      stderr: "",
      status: "running",
      delimiter: uniqueDelimiter,
      pidFile,
      command
    };

    if (token && (command.includes("git") || command.includes("gh"))) {
      shellProcess.stdin.write(`export GITHUB_TOKEN=${token}\n`);
      shellProcess.stdin.write(`git config --global url.'https://x-access-token:${token}@github.com/'.insteadOf 'https://github.com/'\n`);
    }

    const safeCmd = command.replace(/'/g, "'\\''");
    const wrappedStr =
      `setsid sh -c 'printf "%s\\n" "$$" > "${pidFile}"; ${safeCmd}'; ` +
      `echo "${uniqueDelimiter}$?"\n`;
    
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
 
      if (activeTask.pidFile) {
        execAsync(`docker exec ${CONTAINER_NAME} sh -c 'rm -f "${activeTask.pidFile}"'`).catch(() => {});
      }

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
    message: "The command is taking longer than usual or waiting for interactive input. You can call 'send_stdin' to respond, 'wait_command' to continue waiting, or 'kill_command' to terminate it."
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

  const task = activeTask;
  const { pidFile } = task;

  try {
    const { stdout } = await execAsync(
      `docker exec ${CONTAINER_NAME} sh -c ` +
      `'i=0; ` +
      `while [ ! -s "${pidFile}" ] && [ "$i" -lt 40 ]; do ` +
      `sleep 0.05; i=$((i + 1)); ` +
      `done; ` +
      `cat "${pidFile}" 2>/dev/null || true'`
    );

    const pgid = stdout.trim();

    if (!/^[0-9]+$/.test(pgid)) {
      return {
        status: "still_running",
        message: "The command is starting and cannot be cancelled yet. Try kill_command again momentarily.",
        last_stdout: task.stdout.split(task.delimiter)[0].trim(),
        last_stderr: task.stderr.trim()
      };
    }

    await execAsync(
      `docker exec ${CONTAINER_NAME} sh -c ` +
      `'kill -9 -- "-${pgid}" 2>/dev/null || true'`
    );

    let groupExited = false;
    for (let i = 0; i < 40; i++) {
      const { stdout: alive } = await execAsync(
        `docker exec ${CONTAINER_NAME} sh -c ` +
        `'if kill -0 -- "-${pgid}" 2>/dev/null; then echo alive; fi'`
      );

      if (alive.trim() !== "alive") {
        groupExited = true;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!groupExited) {
      return {
        status: "still_running",
        message: "SIGKILL was sent, but the command process group has not exited yet. Try kill_command again.",
        last_stdout: task.stdout.split(task.delimiter)[0].trim(),
        last_stderr: task.stderr.trim()
      };
    }

    const partialStdout = task.stdout.split(task.delimiter)[0].trim();
    const partialStderr = task.stderr.trim();

    if (activeTask === task) {
      activeTask = null;
    }

    await execAsync(
      `docker exec ${CONTAINER_NAME} sh -c 'rm -f "${pidFile}"'`
    ).catch(() => {});

    return {
      status: "killed",
      message: "Command process group and its descendants were forcefully terminated.",
      last_stdout: partialStdout,
      last_stderr: partialStderr
    };
  } catch (err) {
    return {
      status: "failed",
      message: `Failed to cancel command: ${err.message}`,
      last_stdout: task.stdout.split(task.delimiter)[0].trim(),
      last_stderr: task.stderr.trim()
    };
  }
}

function runDockerExec(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `docker exec exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function resolveWorkspacePath(filePath) {
  return filePath.startsWith("/") ? filePath : `/workspace/${filePath}`;
}

export async function editFileInBoxyContainer(filePath, edits) {
  if (activeTask) {
    return { error: "The computer is currently busy running another command. Use 'wait_command' or 'kill_command' before editing files." };
  }
  if (typeof filePath !== "string" || !filePath) {
    return { error: "No file path was provided." };
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    return { error: "No edits were provided." };
  }

  await ensureContainerRunning();
  const target = resolveWorkspacePath(filePath);

  let content;
  try {
    content = await runDockerExec(["exec", CONTAINER_NAME, "cat", target]);
  } catch (err) {
    return { error: `Could not read '${target}': ${err.message}. This tool only edits files that already exist. Use execute_command to create new files.` };
  }

  let updated = content;
  for (let i = 0; i < edits.length; i++) {
    const { old_string, new_string, replace_all } = edits[i] || {};
    if (typeof old_string !== "string" || typeof new_string !== "string") {
      return { error: `Edit #${i + 1} is missing 'old_string' or 'new_string'. No changes were written.` };
    }
    if (old_string === new_string) {
      return { error: `Edit #${i + 1} has an identical 'old_string' and 'new_string', so it would do nothing. No changes were written.` };
    }
    const occurrences = updated.split(old_string).length - 1;
    if (occurrences === 0) {
      return { error: `Edit #${i + 1}: 'old_string' was not found in '${target}'. No changes were written. Re-read the file to confirm its exact current content, including whitespace.` };
    }
    if (occurrences > 1 && !replace_all) {
      return { error: `Edit #${i + 1}: 'old_string' matches ${occurrences} locations in '${target}', but must be unique. Add more surrounding context to 'old_string', or set 'replace_all: true' to replace every occurrence. No changes were written.` };
    }
    updated = replace_all ? updated.split(old_string).join(new_string) : updated.replace(old_string, new_string);
  }

  if (updated === content) {
    return { error: "No changes were made to the file." };
  }

  try {
    await runDockerExec(["exec", "-i", CONTAINER_NAME, "dd", `of=${target}`], updated);
  } catch (err) {
    return { error: `Failed to write '${target}': ${err.message}` };
  }

  return {
    status: "success",
    path: target,
    edits_applied: edits.length,
    message: `Applied ${edits.length} edit(s) to '${target}'.`
  };
}

export async function getBoxyCwd() {
  const result = await runCommandInBoxyContainer("pwd", false);
  return result.status === "completed" ? result.stdout.trim() : "/workspace";
}