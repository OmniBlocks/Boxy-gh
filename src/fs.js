import fs from "fs/promises";
import path from "node:path";

export async function loadReviews() {
  try {
    const data = await fs.readFile(REVIEWS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(REVIEWS_FILE, JSON.stringify({}, null, 2), "utf-8");
      return {};
    }
    throw err;
  }
}
export async function saveReviews(reviews) {
  await fs.writeFile(REVIEWS_FILE, JSON.stringify(reviews, null, 2), "utf-8");
}
async function loadAllNotebooks() {
  try {
    const data = await fs.readFile(NOTEBOOK_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(NOTEBOOK_FILE, JSON.stringify({}, null, 2), "utf-8");
      return {};
    }
    throw err;
  }
}
// repoKey scopes memories to the repo they were saved from
export async function loadNotebook(repoKey) {
  const allNotebooks = await loadAllNotebooks();
  return allNotebooks[repoKey] || {};
}
export async function saveMemoryToFile(repoKey, title, content) {
  const allNotebooks = await loadAllNotebooks();
  allNotebooks[repoKey] = allNotebooks[repoKey] || {};
  allNotebooks[repoKey][title] = content;
  await fs.writeFile(NOTEBOOK_FILE, JSON.stringify(allNotebooks, null, 2), "utf-8");
}
async function loadAllStickyNotes() {
  try {
    const data = await fs.readFile(STICKY_NOTES_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(STICKY_NOTES_FILE, JSON.stringify({}, null, 2), "utf-8");
      return {};
    }
    throw err;
  }
}

export async function loadStickyNotes(repoKey) {
  const allStickyNotes = await loadAllStickyNotes();
  return allStickyNotes[repoKey] || {};
}
export async function saveStickyNoteToFile(repoKey, title, content) {
  const allStickyNotes = await loadAllStickyNotes();
  const stickyNotes = allStickyNotes[repoKey] || {};

  stickyNotes[title] = {
    content: content,
    timestamp: new Date().toISOString()
  };

  const sortedKeys = Object.keys(stickyNotes).sort((a, b) => {
    return new Date(stickyNotes[b].timestamp) - new Date(stickyNotes[a].timestamp);
  });

  const limitedStickyNotes = {};
  for (let i = 0; i < Math.min(5, sortedKeys.length); i++) {
    limitedStickyNotes[sortedKeys[i]] = stickyNotes[sortedKeys[i]];
  }

  allStickyNotes[repoKey] = limitedStickyNotes;
  await fs.writeFile(STICKY_NOTES_FILE, JSON.stringify(allStickyNotes, null, 2), "utf-8");
}
export async function createTodoListItem(title, description, metadata = {}) {
  const todoList = await loadTodoList() || {};
  const newId = Date.now().toString();
  todoList[newId] = {
    title,
    description,
    completed: false,
    sourceRepoOwner: metadata.sourceRepoOwner || null,
    sourceRepoName: metadata.sourceRepoName || null,
    sourceIssueNumber: metadata.sourceIssueNumber || null,
    sourceInstallationId: metadata.sourceInstallationId || null
  };
  await saveTodoList(todoList);
}
export async function loadTodoList() {
  try {
    const data = await fs.readFile(TODO_LIST_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(TODO_LIST_FILE, JSON.stringify({}, null, 2), "utf-8");
      return {};
    }
    throw err;
  }
}
export async function saveTodoList(todoList) {
  await fs.writeFile(TODO_LIST_FILE, JSON.stringify(todoList, null, 2), "utf-8");
}
export async function loadContainerMap() {
  try {
    const data = await fs.readFile(CONTAINERS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      await fs.writeFile(CONTAINERS_FILE, JSON.stringify({}, null, 2), "utf-8");
      return {};
    }
    throw err;
  }
}
export async function saveContainerMap(containerMap) {
  await fs.writeFile(CONTAINERS_FILE, JSON.stringify(containerMap, null, 2), "utf-8");
}

export const NOTEBOOK_FILE = path.resolve("./boxy_notebook.json");
export const STICKY_NOTES_FILE = path.resolve("./boxy_sticky_notes.json");
export const TODO_LIST_FILE = path.resolve("./boxy_todo_list.json");
export const REVIEWS_FILE = path.resolve("./boxy_reviews.json");
export const REVERT_FILE = path.resolve("./boxy_revert_pending.json");
export const CONTAINERS_FILE = path.resolve("./boxy_containers.json");

