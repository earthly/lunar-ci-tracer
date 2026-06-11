#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

const STATE_MAIN_RAN = "LUNAR_MAIN_RAN";
const STATE_LOGS_FILE = "LUNAR_LOGS_FILE";
const STATE_READY_FILE = "LUNAR_READY_FILE";
const AGENT_LOG_NAME = "lunar-ci-agent-logs.txt";
const AGENT_PID_NAME = "lunarci-agent-pid.txt";
const LUNAR_BIN_NAME = "lunar";
const LUNAR_ASSET_NAME = "lunar-linux-amd64";
const LUNAR_DIST_REPO = "earthly/lunar-dist";
const READY_POLL_MS = 50;
// Generous enough for a cold-cache agent download through the Hub plus agent
// boot; outright failures are caught much sooner by the liveness check.
const READY_TIMEOUT_MS = 5 * 60 * 1000;
// GitHub truncates annotations around 4KB; keep the log excerpt below that.
const LOG_TAIL_CHARS = 3500;

function info(message) {
  process.stdout.write(`${message}\n`);
}

// escapeData makes a message safe for a single-line workflow command, the
// same escaping @actions/core applies (multi-line annotations otherwise
// terminate at the first newline).
function escapeData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function warn(message) {
  process.stdout.write(`::warning::${escapeData(message)}\n`);
}

// error emits an error annotation without failing the step (core.error).
function error(message) {
  process.stdout.write(`::error::${escapeData(message)}\n`);
}

// fail emits an error annotation and fails the step (core.setFailed).
function fail(message) {
  error(message);
  process.exitCode = 1;
}

function saveState(name, value) {
  const statePath = process.env.GITHUB_STATE;
  if (!statePath) {
    return;
  }
  fs.appendFileSync(statePath, `${name}=${value}\n`, "utf8");
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

function setPath(dirPath) {
  const pathFile = process.env.GITHUB_PATH;
  if (!pathFile) {
    return;
  }
  fs.appendFileSync(pathFile, `${dirPath}\n`, "utf8");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// waitForReady polls for the agent's ready-file while streaming the child's
// output to the step log. Resolves to "ready", "exited" (child died before
// becoming ready), or "timeout".
async function waitForReady(readyFile, pid, logsFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let logOffset = 0;
  let partial = "";
  while (true) {
    await flushLogs(false);
    try {
      await fsp.access(readyFile, fs.constants.F_OK);
      await flushLogs(true);
      return "ready";
    } catch {
      if (!isProcessAlive(pid)) {
        await flushLogs(true);
        return "exited";
      }
      if (Date.now() >= deadline) {
        await flushLogs(true);
        return "timeout";
      }
      await wait(READY_POLL_MS);
    }
  }

  async function flushLogs(final) {
    try {
      const fd = await fsp.open(logsFile, "r");
      try {
        const { size } = await fd.stat();
        if (size > logOffset) {
          const buf = Buffer.alloc(size - logOffset);
          await fd.read(buf, 0, buf.length, logOffset);
          logOffset = size;
          const text = partial + buf.toString("utf8");
          const lastNl = text.lastIndexOf("\n");
          if (lastNl !== -1) {
            process.stdout.write(text.slice(0, lastNl + 1));
            partial = text.slice(lastNl + 1);
          } else {
            partial = text;
          }
        }
        if (final && partial.length > 0) {
          process.stdout.write(partial + "\n");
          partial = "";
        }
      } finally {
        await fd.close();
      }
    } catch {}
  }
}

function isPostStep() {
  return process.env[`STATE_${STATE_MAIN_RAN}`] !== undefined;
}

function resolveLunarVersion() {
  const input = process.env.INPUT_VERSION;
  if (input && input.trim() !== "") {
    return input.trim();
  }
  return "latest";
}

function lunarDownloadUrl(version) {
  if (version === "latest") {
    return `https://github.com/${LUNAR_DIST_REPO}/releases/latest/download/${LUNAR_ASSET_NAME}`;
  }
  return `https://github.com/${LUNAR_DIST_REPO}/releases/download/${version}/${LUNAR_ASSET_NAME}`;
}

async function downloadBinary(url, destPath) {
  info(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await fsp.writeFile(destPath, Buffer.from(arrayBuffer), { mode: 0o755 });
  await fsp.chmod(destPath, 0o755);
}

function strictMode() {
  const value = (process.env.LUNAR_STRICT_MODE || "").trim().toLowerCase();
  return value === "1" || value === "t" || value === "true";
}

function readLogTail(logsFile) {
  try {
    const text = fs.readFileSync(logsFile, "utf8").trimEnd();
    if (text.length > LOG_TAIL_CHARS) {
      return `...${text.slice(-LOG_TAIL_CHARS)}`;
    }
    return text;
  } catch {
    return "";
  }
}

// handleSetupFailure applies the LUNAR_STRICT_MODE gate to agent installation
// failures (CLI download, agent download through the Hub, agent boot): strict
// fails the step; non-strict surfaces an error annotation but lets the rest
// of the job continue uninstrumented.
function handleSetupFailure(message) {
  setOutput("agent-installed", "false");

  if (strictMode()) {
    fail(message);
    return;
  }

  error(message);
  warn(
    "agent download failed; continuing because LUNAR_STRICT_MODE is not set",
  );
}

function relaxPtraceScope() {
  try {
    execSync("echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope", {
      stdio: "ignore",
      shell: true,
    });
  } catch {
    warn("Could not set ptrace_scope to 0; attaching may fail on restricted runners.");
  }
}

async function runMain() {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) {
    fail("RUNNER_TEMP is not set.");
    return;
  }

  const runtimeDir = path.join(runnerTemp, "lunar");
  const binDir = path.join(runtimeDir, "bin");
  const logsDir = path.join(runtimeDir, "logs");
  const readyFile = path.join(runtimeDir, ".ready");
  const lunarPath = path.join(binDir, LUNAR_BIN_NAME);
  const logsFile = path.join(logsDir, AGENT_LOG_NAME);
  const pidFile = path.join(logsDir, AGENT_PID_NAME);
  const targetPid = process.ppid;

  await fsp.mkdir(binDir, { recursive: true });
  await fsp.mkdir(logsDir, { recursive: true });
  saveState(STATE_LOGS_FILE, logsFile);
  saveState(STATE_READY_FILE, readyFile);

  try {
    await downloadBinary(lunarDownloadUrl(resolveLunarVersion()), lunarPath);
  } catch (err) {
    handleSetupFailure(`Failed to download the lunar CLI: ${err.message}`);
    return;
  }
  setPath(binDir);

  const args = [
    "ci-tracer",
    "run",
    "--",
    `--pid=${targetPid}`,
    "--ready-file",
    readyFile,
    "--ci-type",
    "github",
  ];

  info(`Starting Lunar CI Agent: lunar ${args.join(" ")}`);
  relaxPtraceScope();

  const outFd = fs.openSync(logsFile, "a");
  const childEnv = { ...process.env };
  delete childEnv.RUNNER_TRACKING_ID;
  childEnv.LUNAR_UPDATE_PERIOD = "0";
  childEnv.LUNAR_UPDATE_CHECK_TIMEOUT = "50s";
  childEnv.LUNAR_LOG_LEVEL = childEnv.LUNAR_LOG_LEVEL || "error";
  childEnv.LUNAR_HUB_GRPC_PORT = childEnv.LUNAR_HUB_GRPC_PORT || "443";
  childEnv.LUNAR_HUB_HTTP_PORT = childEnv.LUNAR_HUB_HTTP_PORT || "443";

  // The detached child downloads the agent through the Hub when the cache is
  // cold, then execs it in place (same PID), so polling this PID covers both
  // the download and the agent boot.
  const child = spawn(lunarPath, args, {
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: childEnv,
  });
  child.unref();
  fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  fs.closeSync(outFd);

  const result = await waitForReady(readyFile, child.pid, logsFile, READY_TIMEOUT_MS);
  if (result !== "ready") {
    if (result === "timeout") {
      // SIGKILL cannot be intercepted and forwarded to the tracee, so a
      // half-attached agent is detached by the kernel and the runner
      // process resumes untraced.
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
    }
    let message =
      result === "timeout"
        ? `Lunar CI Agent did not become ready within ${READY_TIMEOUT_MS / 1000}s.`
        : "lunar ci-tracer run exited before the agent became ready.";
    const tail = readLogTail(logsFile);
    if (tail !== "") {
      message += `\n${tail}`;
    }
    handleSetupFailure(message);
    return;
  }

  setOutput("agent-installed", "true");
  info("Lunar CI Agent is ready.");
}

async function runPost() {
  const logsFile = process.env[`STATE_${STATE_LOGS_FILE}`];
  if (!logsFile) {
    info("No logs file state found; skipping Lunar CI Agent log output.");
    return;
  }

  info("Lunar CI Agent logs:");
  try {
    const logs = await fsp.readFile(logsFile, "utf8");
    process.stdout.write(logs.endsWith("\n") ? logs : `${logs}\n`);
  } catch (err) {
    warn(`Could not read logs file at ${logsFile}: ${err.message}`);
  }
}

async function main() {
  try {
    if (isPostStep()) {
      await runPost();
      return;
    }
    // Marked unconditionally before any work so the post step never re-runs
    // main when the main step failed early.
    saveState(STATE_MAIN_RAN, "true");
    await runMain();
  } catch (err) {
    fail(err.message || String(err));
  }
}

main();
