import { Sandbox } from "tensorlake";
import { loadNotebook, loadTodoList, loadReviews, loadStickyNotes, REVERT_FILE } from "./fs.js";

let sandbox = null;

async function initializeSandbox() {
  if (!sandbox) {
    try {
    sandbox = await Sandbox.create({
  name: "boxy-computer", 
  cpus: 1.0,
  memoryMb: 1024,
}); 
  }
  catch (error) {
    sandbox = await Sandbox.create("boxy-computer", {
      name: "boxy-computer",
          apiKey: process.env.TENSORLAKE_API_KEY,
        });
}
}
}

export async function runCommandInBoxyContainer(command) {
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
      stderr: "You're using the computer to work on another task on your to-do list right now. Try again later once you're done, and try to complete what you're doing with another tool. If what you're trying to do absolutely REQUIRES using your computer, add it to your to-do list to do it later and inform the user.",
      exitCode: 1,
    };
  }
  await initializeSandbox();
  const result = await sandbox.run("/bin/sh", {
    args: ["-c", command],
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}