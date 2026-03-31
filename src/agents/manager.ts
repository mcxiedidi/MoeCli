import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { getAgentDir, getAgentsDir, getWorktreesDir } from "../config/paths.js";
import type { AgentExecutionMode } from "../providers/types.js";
import type { InteractionMode } from "../cli/interactionMode.js";
import type { TaskPhase } from "../session/taskTypes.js";

export type AgentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export interface AgentRecord {
  id: string;
  name: string;
  task: string;
  mode: AgentExecutionMode;
  cwd: string;
  profileName: string;
  model: string;
  interactionMode?: InteractionMode | undefined;
  taskPhase?: TaskPhase | undefined;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  pid?: number | undefined;
  resultText?: string | undefined;
  error?: string | undefined;
  tmuxSession?: string | undefined;
}

interface AgentMessage {
  id: string;
  role: "user";
  text: string;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getAgentStatePath(agentId: string): string {
  return join(getAgentDir(agentId), "state.json");
}

function getAgentInboxPath(agentId: string): string {
  return join(getAgentDir(agentId), "inbox.json");
}

function ensureAgentDir(agentId: string): string {
  const dir = getAgentDir(agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getSelfLaunchCommand(): { command: string; args: string[] } {
  const distEntry = join(process.cwd(), "dist", "index.js");
  if (existsSync(distEntry)) {
    return {
      command: process.execPath,
      args: [distEntry],
    };
  }

  const tsxCommand =
    process.platform === "win32"
      ? join(process.cwd(), "node_modules", ".bin", "tsx.cmd")
      : join(process.cwd(), "node_modules", ".bin", "tsx");

  return {
    command: tsxCommand,
    args: [join(process.cwd(), "src", "index.ts")],
  };
}

function tryPrepareGitWorktree(baseCwd: string, targetDir: string): boolean {
  try {
    const gitRoot = execFileSync(
      "git",
      ["-C", baseCwd, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!gitRoot) {
      return false;
    }
    execFileSync("git", ["-C", gitRoot, "worktree", "add", "--detach", targetDir, "HEAD"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export class AgentManager {
  readAgent(agentId: string): AgentRecord | null {
    const path = getAgentStatePath(agentId);
    if (!existsSync(path)) {
      return null;
    }
    return JSON.parse(readFileSync(path, "utf8")) as AgentRecord;
  }

  writeAgent(record: AgentRecord): AgentRecord {
    ensureAgentDir(record.id);
    writeJson(getAgentStatePath(record.id), record);
    return record;
  }

  listAgents(): AgentRecord[] {
    mkdirSync(getAgentsDir(), { recursive: true });
    return readdirSync(getAgentsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readAgent(entry.name))
      .filter((entry): entry is AgentRecord => Boolean(entry));
  }

  spawnAgent(options: {
    task: string;
    name?: string;
    mode: AgentExecutionMode;
    cwd: string;
    profileName: string;
    model: string;
    interactionMode?: InteractionMode | undefined;
    taskPhase?: TaskPhase | undefined;
  }): AgentRecord {
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    ensureAgentDir(id);

    let resolvedCwd = options.cwd;
    let tmuxSession: string | undefined;

    if (options.mode === "worktree") {
      const worktreeDir = join(getWorktreesDir(), id);
      mkdirSync(getWorktreesDir(), { recursive: true });
      if (!tryPrepareGitWorktree(options.cwd, worktreeDir)) {
        mkdirSync(worktreeDir, { recursive: true });
      }
      resolvedCwd = worktreeDir;
    }

    const record: AgentRecord = {
      id,
      name: options.name?.trim() || `agent-${id.slice(0, 8)}`,
      task: options.task,
      mode: options.mode,
      cwd: resolvedCwd,
      profileName: options.profileName,
      model: options.model,
      interactionMode: options.interactionMode,
      taskPhase: options.taskPhase,
      status: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...(tmuxSession ? { tmuxSession } : {}),
    };
    this.writeAgent(record);
    writeJson(getAgentInboxPath(id), []);

    const launch = getSelfLaunchCommand();
    const args = [...launch.args, "agent-run", "--agent-id", id];

    if (options.mode === "tmux" && process.platform !== "win32") {
      tmuxSession = `moecli-${id.slice(0, 10)}`;
      spawn("tmux", ["new-session", "-d", "-s", tmuxSession, launch.command, ...args], {
        cwd: resolvedCwd,
        env: {
          ...process.env,
        },
        detached: true,
        stdio: "ignore",
      }).unref();
      record.tmuxSession = tmuxSession;
    } else {
      const child = spawn(launch.command, args, {
        cwd: resolvedCwd,
        env: {
          ...process.env,
        },
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      record.pid = child.pid;
    }

    record.updatedAt = nowIso();
    this.writeAgent(record);
    return record;
  }

  updateStatus(
    agentId: string,
    patch: Partial<AgentRecord>,
  ): AgentRecord | null {
    const record = this.readAgent(agentId);
    if (!record) {
      return null;
    }
    const next: AgentRecord = {
      ...record,
      ...patch,
      updatedAt: nowIso(),
    };
    this.writeAgent(next);
    return next;
  }

  enqueueMessage(agentId: string, text: string): AgentRecord | null {
    const record = this.readAgent(agentId);
    if (!record) {
      return null;
    }
    const inboxPath = getAgentInboxPath(agentId);
    const current = existsSync(inboxPath)
      ? (JSON.parse(readFileSync(inboxPath, "utf8")) as AgentMessage[])
      : [];
    current.push({
      id:
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "user",
      text,
      createdAt: nowIso(),
    });
    writeJson(inboxPath, current);
    return this.updateStatus(agentId, {});
  }

  consumeInbox(agentId: string): AgentMessage[] {
    const inboxPath = getAgentInboxPath(agentId);
    const current = existsSync(inboxPath)
      ? (JSON.parse(readFileSync(inboxPath, "utf8")) as AgentMessage[])
      : [];
    writeJson(inboxPath, []);
    return current;
  }

  abortAgent(agentId: string): AgentRecord | null {
    const record = this.readAgent(agentId);
    if (!record) {
      return null;
    }

    try {
      if (record.tmuxSession && process.platform !== "win32") {
        execFileSync("tmux", ["kill-session", "-t", record.tmuxSession], {
          stdio: ["ignore", "ignore", "ignore"],
        });
      } else if (record.pid) {
        process.kill(record.pid);
      }
    } catch {
      // Ignore best-effort termination errors.
    }

    return this.updateStatus(agentId, {
      status: "aborted",
    });
  }

  async waitForAgent(
    agentId: string,
    timeoutMs = 60_000,
  ): Promise<AgentRecord | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const record = this.readAgent(agentId);
      if (!record) {
        return null;
      }
      if (["completed", "failed", "aborted"].includes(record.status)) {
        return record;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return this.readAgent(agentId);
  }
}
