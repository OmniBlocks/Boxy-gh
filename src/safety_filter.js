/**
 * Boxy Command Safety Filter & Logging Wrapper Prototype
 * 
 * This module provides:
 * 1. Command Blocklisting / High-Risk Pattern Detection (preventing dangerous commands
 *    like rm -rf /, recursive deletion on sensitive system paths, unauthorized reads of
 *    sensitive config/credential files, etc.)
 * 2. Regex-Based Secret Redaction for Execution Logs & Output Streams (scrubbing tokens,
 *    passwords, private keys, authorization headers, API keys, etc.)
 * 3. Execution Logging Wrapper (structured logging of command attempts, blocks, and outcomes)
 */

// Blocklist patterns for dangerous commands
const DANGEROUS_PATTERNS = [
  // Destructive root / system commands
  /\brm\s+-[rRfF]*\s*\/\s*($|\s)/i,
  /\brm\s+-[rRfF]*\s*--no-preserve-root\b/i,
  /\bmkfs\b/i,
  /\bdd\b.*of=\/dev\//i,
  /\b:\s*&:\s*:\s*/i, // Fork bomb signature

  // Sensitive file reads / credential harvesting attempts (broader matching for .env and key files)
  /\b(cat|less|more|head|tail|grep|awk|sed|nano|vi|vim)\b.*(\.env|id_rsa|id_ed25519|\.ssh\/authorized_keys|\.gitconfig|passwd|shadow)\b/i,
  /\b(cat|less|more|head|tail|grep)\b.*\/etc\/(shadow|passwd|sudoers)\b/i,

  // Command injection / reverse shell / dangerous network pipes
  /\b(nc|netcat|ncat)\b.*(-e|\-c)\b/i,
  /\bbash\b.*>.*\/dev\/tcp\//i,
  /\bcurl\b.*\|.*\b(bash|sh)\b/i,
  /\bwget\b.*\|.*\b(bash|sh)\b/i,
];

// Regex patterns for redacting secrets from logs, stdout, and stderr
const SECRET_REDACTION_PATTERNS = [
  // GitHub tokens (ghp_, ghs_, github_pat_, etc.)
  { pattern: /\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  // Generic Bearer / Authorization tokens
  { pattern: /\b(Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*)\b/gi, replacement: "Bearer [REDACTED_TOKEN]" },
  // API Keys / Secret keys / Private keys
  { pattern: /\b(api[_-]?key|secret[_-]?key|password|passwd|auth[_-]?token)\s*[:=]\s*['"]?([^\s'"]{4,})['"]?/gi, replacement: "$1=[REDACTED_SECRET]" },
  // PEM / Private Key blocks
  { pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PRIVATE)\s+KEY----[\s\S]*?-----END\s+(?:RSA|DSA|EC|OPENSSH|PRIVATE)\s+KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  // AWS Access Keys
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: "[REDACTED_AWS_KEY]" },
  // Gemini ai keys
  { pattern: /\b(AIza[0-9A-Z-_]+)\b/g, replacement: "[REDACTED_GOOGLE_KEY]" },
];

/**
 * Checks a command string against known dangerous patterns.
 * @param {string} command - The command string to inspect.
 * @returns {{ isSafe: boolean, matchedPattern?: string }}
 */
export function checkCommandSafety(command) {
  if (!command || typeof command !== "string") {
    return { isSafe: true };
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        isSafe: false,
        matchedPattern: pattern.toString(),
      };
    }
  }

  return { isSafe: true };
}

/**
 * Redacts secrets from a given output string (stdout, stderr, or log entry).
 * @param {string} text - The raw output or log string.
 * @returns {string} The sanitized string with secrets scrubbed.
 */
export function redactSecrets(text) {
  if (!text || typeof text !== "string") {
    return text;
  }

  let sanitized = text;
  for (const { pattern, replacement } of SECRET_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

/**
 * Wraps command execution with safety filtering and audit logging.
 * @param {string} command - The command to execute.
 * @param {Function} executionFn - The underlying executor function (e.g. runCommandInBoxyContainer).
 * @param {Object} [logger] - Optional logger instance (defaults to console).
 * @returns {Promise<{ status: string, stdout: string, stderr: string, exitCode: number, blocked?: boolean }>}
 */
export async function executeSafely(command, executionFn, logger = console) {
  const timestamp = new Date().toISOString();
  
  // 1. Safety Filter Check
  const safetyCheck = checkCommandSafety(command);
  if (!safetyCheck.isSafe) {
    const logMessage = `[SECURITY BLOCK] [${timestamp}] Command blocked due to high-risk pattern match (${safetyCheck.matchedPattern}): ${redactSecrets(command)}`;
    logger.warn(logMessage);
    
    return {
      status: "blocked",
      blocked: true,
      stdout: "",
      stderr: `[Boxy Safety Filter] Command rejected. Matches forbidden security policy pattern: ${safetyCheck.matchedPattern}`,
      exitCode: 126, // Standard exit code for command invoked cannot execute / permission denied
    };
  }

  // 2. Audit Log (Pre-execution)
  logger.info(`[AUDIT] [${timestamp}] Executing command: ${redactSecrets(command)}`);

  // 3. Execute Command
  const result = await executionFn(command);

  // 4. Sanitize Outputs (Post-execution redaction)
  const sanitizedResult = {
    ...result,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
  };

  // 5. Audit Log (Post-execution)
  const completionTimestamp = new Date().toISOString();
  logger.info(`[AUDIT] [${completionTimestamp}] Command completed with exitCode=${sanitizedResult.exitCode}`);

  return sanitizedResult;
}
