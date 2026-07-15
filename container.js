import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadContainerMap, saveContainerMap } from './fs.js';

const execFileAsync = promisify(execFile);

function sanitizeContainerKey(key) {
  return key
    .toString()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function makeContainerName(key) {
  return `boxy-${sanitizeContainerKey(key)}`;
}

async function docker(args, options = {}) {
  return await execFileAsync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
    ...options
  });
}

async function containerExists(name) {
  try {
    const { stdout } = await docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']);
    return stdout.trim() === name;
  } catch (error) {
    return false;
  }
}

async function removeContainerByName(name) {
  if (!(await containerExists(name))) {
    return false;
  }
  await docker(['rm', '-f', name]);
  return true;
}

function buildAuthCloneUrl(repoUrl) {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_ACCESS_TOKEN;
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    if (url.protocol.startsWith('http')) {
      url.username = 'x-access-token';
      url.password = token;
      return url.toString();
    }
  } catch (error) {
    return repoUrl;
  }
  return repoUrl;
}

async function execInContainer(name, command) {
  try {
    return await docker(['exec', '-i', name, 'bash', '-lc', command]);
  } catch (error) {
    const stdout = error.stdout || '';
    const stderr = error.stderr || error.message || '';
    throw new Error(`Container command failed: ${stderr || stdout}`);
  }
}

export async function createBoxyContainer(key, repoCloneUrl, branchOrRef = null) {
  const containerName = makeContainerName(key);
  const map = await loadContainerMap();
  const existing = map[key];

  if (existing && (await containerExists(existing.containerName))) {
    if (branchOrRef && existing.branchOrRef !== branchOrRef) {
      const authCloneUrl = buildAuthCloneUrl(repoCloneUrl);
      const updateCmd = [
        'cd /workspace',
        'git fetch --all --tags',
        `git checkout ${branchOrRef}`,
        'git pull --ff-only || true'
      ].join(' && ');
      await execInContainer(existing.containerName, updateCmd);
      existing.branchOrRef = branchOrRef;
      existing.repoCloneUrl = repoCloneUrl;
      await saveContainerMap(map);
    }
    return { key, containerName: existing.containerName, reused: true };
  }

  await removeContainerByName(containerName);
  await docker(['run', '-d', '--name', containerName, 'ubuntu:22.04', 'tail', '-f', '/dev/null']);

  const authCloneUrl = buildAuthCloneUrl(repoCloneUrl);
  const installCmd = [
    'apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates lsb-release gnupg python3 python3-pip openjdk-17-jdk nodejs npm',
    'mkdir -p /workspace'
  ].join(' && ');

  await execInContainer(containerName, installCmd);

  let cloneCmd = `rm -rf /workspace/* && mkdir -p /workspace && cd /workspace && git clone --depth 1 ${authCloneUrl} .`;
  if (branchOrRef) {
    cloneCmd = `rm -rf /workspace/* && mkdir -p /workspace && cd /workspace && git clone ${authCloneUrl} . && git fetch --all --tags && git checkout ${branchOrRef}`;
  }

  await execInContainer(containerName, cloneCmd);

  map[key] = {
    containerName,
    repoCloneUrl,
    branchOrRef: branchOrRef || null,
    createdAt: new Date().toISOString()
  };
  await saveContainerMap(map);

  return { key, containerName, reused: false };
}

export async function destroyBoxyContainer(key) {
  const map = await loadContainerMap();
  const entry = map[key];
  if (!entry) {
    return false;
  }

  await removeContainerByName(entry.containerName);
  delete map[key];
  await saveContainerMap(map);
  return true;
}

export async function getBoxyContainerStatus(key) {
  const map = await loadContainerMap();
  const entry = map[key];
  if (!entry) {
    return { exists: false };
  }

  const exists = await containerExists(entry.containerName);
  return {
    exists,
    containerName: entry.containerName,
    repoCloneUrl: entry.repoCloneUrl,
    branchOrRef: entry.branchOrRef,
    createdAt: entry.createdAt
  };
}

export async function runCommandInBoxyContainer(key, command) {
  const status = await getBoxyContainerStatus(key);
  if (!status.exists) {
    throw new Error(`Container for key ${key} not found.`);
  }

  const { stdout, stderr } = await execInContainer(status.containerName, command);
  return { stdout: stdout || '', stderr: stderr || '' };
}
