// Runs on the hub: while the hub's runner is online, devices hand chats to it
// instead of running bots themselves, so work carries on when every app is
// closed. A device asks through small synced request documents; the runner
// streams its replies back as live events and stores them like any device.

import { capabilities, isRunner } from "./platform";
import { C, isBusy, remoteApproval, useApp } from "./store";
import { db } from "./platform";
import type { Bot, RunnerRequest } from "./types";
import { uid } from "./util";

export function runnerOnline(): boolean {
  const s = useApp.getState();
  return !!s.hub && !!s.runner?.online;
}

/** Whether this bot's runs go to the hub's runner rather than this device. */
export function runsOnHub(bot: Bot): boolean {
  if (isRunner() || !runnerOnline()) return false;
  const { settings, mcpServers } = useApp.getState();
  if ((settings.runOn ?? "hub") === "device") return false;
  // Its files and terminal are on this device, which the hub can't reach.
  if ((bot.computer ?? settings.computer ?? "hub") === "device") return false;
  // Local (stdio) plugins run only on this computer.
  if (capabilities.mcpStdio && mcpServers.some((s) => s.enabled && s.transport === "stdio" && bot.mcpServerIds.includes(s.id))) return false;
  return true;
}

/** Whether a conversation is running on the hub right now. */
export function runningOnHub(conversationId: string): boolean {
  const s = useApp.getState();
  return !s.running[conversationId] && isBusy(s, conversationId);
}

async function send(req: Omit<RunnerRequest, "id" | "at" | "deviceId">): Promise<void> {
  const full: RunnerRequest = { ...req, id: uid("req"), at: Date.now(), deviceId: useApp.getState().hub?.deviceId };
  await db.put(C.requests, full.id, full);
}

export async function requestRun(conversationId: string): Promise<void> {
  const conv = useApp.getState().conversations.find((c) => c.id === conversationId);
  // Shown as working right away; the runner's own record replaces this when it starts.
  if (conv) {
    useApp.setState((s) => ({ remoteRuns: { ...s.remoteRuns, [conversationId]: { id: conversationId, conversationId, botId: conv.botId, startedAt: Date.now() } } }));
  }
  await send({ kind: "run", conversationId });
}

export const requestStop = (conversationId: string) => send({ kind: "stop", conversationId });

export const requestRoutine = (routineId: string) => send({ kind: "routine", routineId });

remoteApproval.send = (conversationId, toolCallId, answer) => send({ kind: "approve", conversationId, toolCallId, answer });
