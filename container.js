import { exec } from "child_process";
import { promisify } from "util";
import { loadTodoList, loadReviews } from "./fs.js";

const execAsync = promisify(exec);
const CONTAINER_NAME = "boxy-runner";

// Helper to ensure the persistent container is running
async function ensureContainerRunning() {
  try {
    // Check if the container exists/is running
    await execAsync(`docker inspect ${CONTAINER_NAME}`);
  } catch (err) {
    // Container doesn't exist, create and run it in detached mode (-d)
    const createCmd = `docker run -d --name ${CONTAINER_NAME} \
      --memory="256m" \
      --memory-swap="256m" \
      -e CI=true \
      -v /home/gato/boxy-workspace:/workspace \
      -w /workspace \
      node:20-alpine tail -f /dev/null`;
    
    await execAsync(createCmd);
  }
}

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

  if (isBusy && isBoxyWebhook) {
    return {
      stdout: "",
      stderr: "You're using the computer to work on another task on your to-do list right now. Try again later once you're done...",
      exitCode: 1,
    };
  }

  // Ensure persistent container exists before running command
  await ensureContainerRunning();

  // Escape double quotes safely
  const safeCommand = command.replace(/"/g, '\\"');

  // Execute inside the already running container
  const dockerCmd = `docker exec ${CONTAINER_NAME} /bin/sh -c "( ${safeCommand} ) < /dev/null"`;

  try {
    const { stdout, stderr } = await execAsync(dockerCmd, { timeout: 1200000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || error.message,
      exitCode: error.code || 1
    };
  }
}
