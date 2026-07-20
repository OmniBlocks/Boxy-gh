import { exec } from "child_process";
import { promisify } from "util";
import { loadTodoList, loadReviews } from "./fs.js";

const execAsync = promisify(exec);

export async function runCommandInBoxyContainer(command, isBoxyWebhook = false) {
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
      isBusy = true;
    }
  }
  
  if (isBusy) {
    return {
      stdout: "",
      stderr: "You're using the computer to work on another task on your to-do list right now. Try again later once you're done...",
      exitCode: 1,
    };
  }

  // Escape double quotes inside the command so they don't break our bash wrapper
  const safeCommand = command.replace(/"/g, '\\"');

  // -v /home/gato/boxy-workspace:/workspace mounts your safe sandbox playpen
  // --memory="256m" limits RAM usage to prevent host crashes
  // node:20-alpine is the super fast, pre-cached image
  const dockerCmd = `docker run --rm --memory="256m" -v /home/gato/boxy-workspace:/workspace -w /workspace node:20-alpine /bin/sh -c "${safeCommand}"`;

  try {
    const { stdout, stderr } = await execAsync(dockerCmd, { timeout: 120000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || error.message,
      exitCode: error.code || 1
    };
  }
}
