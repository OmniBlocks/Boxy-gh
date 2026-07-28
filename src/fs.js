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

export async function loadNotebook() {
  const allNotebooks = await loadAllNotebooks();
  const entries = [];
  for (const [repo, titles] of Object.entries(allNotebooks)) {
    for (const [title, content] of Object.entries(titles)) {
      entries.push({ repo, title, content });
    }
  }
  return entries;
}
export async function saveMemoryToFile(repoKey, title, content) {
  const allNotebooks = await loadAllNotebooks();
  allNotebooks[repoKey] = allNotebooks[repoKey] || {};
  allNotebooks[repoKey][title] = content;
  await fs.writeFile(NOTEBOOK_FILE, JSON.stringify(allNotebooks, null, 2), "utf-8");
}
// Updates an existing memory's title, content, and/or repo
export async function updateMemoryEntry(repoKey, title, { newTitle, newContent, newRepo } = {}) {
  const allNotebooks = await loadAllNotebooks();
  const sourceNotebook = allNotebooks[repoKey];
  if (!sourceNotebook || !Object.hasOwn(sourceNotebook, title)) {
    throw new Error(`Memory '${title}' not found in ${repoKey}'s notebook.`);
  }

  const targetRepo = newRepo || repoKey;
  const targetTitle = newTitle || title;
  const content = newContent !== undefined ? newContent : sourceNotebook[title];

  if ((targetRepo !== repoKey || targetTitle !== title) && Object.hasOwn(allNotebooks[targetRepo] || {}, targetTitle)) {
    throw new Error(`A memory titled '${targetTitle}' already exists in ${targetRepo}'s notebook.`);
  }

  delete sourceNotebook[title];
  allNotebooks[targetRepo] = allNotebooks[targetRepo] || {};
  allNotebooks[targetRepo][targetTitle] = content;
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

export async function loadStickyNotes() {
  const allStickyNotes = await loadAllStickyNotes();
  const entries = [];
  for (const [repo, notes] of Object.entries(allStickyNotes)) {
    for (const [title, note] of Object.entries(notes)) {
      entries.push({ repo, title, content: note.content, timestamp: note.timestamp });
    }
  }
  return entries;
}
function capStickyNotes(stickyNotes) {
  const sortedKeys = Object.keys(stickyNotes).sort((a, b) => {
    return new Date(stickyNotes[b].timestamp) - new Date(stickyNotes[a].timestamp);
  });
  const limitedStickyNotes = {};
  for (let i = 0; i < Math.min(5, sortedKeys.length); i++) {
    limitedStickyNotes[sortedKeys[i]] = stickyNotes[sortedKeys[i]];
  }
  return limitedStickyNotes;
}
export async function saveStickyNoteToFile(repoKey, title, content) {
  const allStickyNotes = await loadAllStickyNotes();
  const stickyNotes = allStickyNotes[repoKey] || {};

  stickyNotes[title] = {
    content: content,
    timestamp: new Date().toISOString()
  };

  allStickyNotes[repoKey] = capStickyNotes(stickyNotes);
  await fs.writeFile(STICKY_NOTES_FILE, JSON.stringify(allStickyNotes, null, 2), "utf-8");
}
// Updates an existing sticky note's title, content, and/or repo
export async function updateStickyNoteEntry(repoKey, title, { newTitle, newContent, newRepo } = {}) {
  const allStickyNotes = await loadAllStickyNotes();
  const sourceNotes = allStickyNotes[repoKey];
  if (!sourceNotes || !Object.hasOwn(sourceNotes, title)) {
    throw new Error(`Sticky note '${title}' not found in ${repoKey}'s sticky notes.`);
  }

  const targetRepo = newRepo || repoKey;
  const targetTitle = newTitle || title;
  const existingNote = sourceNotes[title];

  if ((targetRepo !== repoKey || targetTitle !== title) && Object.hasOwn(allStickyNotes[targetRepo] || {}, targetTitle)) {
    throw new Error(`A sticky note titled '${targetTitle}' already exists in ${targetRepo}'s sticky notes.`);
  }

  delete sourceNotes[title];
  allStickyNotes[targetRepo] = allStickyNotes[targetRepo] || {};
  allStickyNotes[targetRepo][targetTitle] = {
    content: newContent !== undefined ? newContent : existingNote.content,
    timestamp: existingNote.timestamp
  };
  if (targetRepo !== repoKey) {
    allStickyNotes[targetRepo] = capStickyNotes(allStickyNotes[targetRepo]);
  }
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

