import { randomAvatar } from "../components/Avatar";
import { nextRun } from "./schedule";
import { saveBot, saveRoutine, selectBot, useApp } from "./store";
import { templateTools, type BotTemplate } from "./templates";
import type { Bot } from "./types";
import { DEFAULT_TOOLS } from "./types";
import { uid } from "./util";

export async function createBotFromTemplate(t: BotTemplate): Promise<Bot> {
  const now = Date.now();
  const taken = new Set(useApp.getState().bots.map((b) => b.name));
  let name = t.name;
  for (let i = 2; taken.has(name); i++) name = `${t.name} ${i}`;
  const bot: Bot = {
    id: uid("bot"),
    name,
    tagline: t.tagline,
    instructions: t.instructions,
    avatar: t.avatar,
    tools: templateTools(t),
    skillIds: [],
    mcpServerIds: [],
    secretNames: [],
    templateId: t.id,
    createdAt: now,
    updatedAt: now,
  };
  await saveBot(bot);
  if (t.routine) {
    await saveRoutine({
      id: uid("routine"),
      botId: bot.id,
      name: t.routine.name,
      prompt: t.routine.prompt,
      schedule: t.routine.schedule,
      // Off until the user has told the bot what to cover.
      enabled: false,
      nextRunAt: nextRun(t.routine.schedule, now),
      createdAt: now,
    });
  }
  selectBot(bot.id);
  return bot;
}

export async function createBlankBot(): Promise<Bot> {
  const now = Date.now();
  const bot: Bot = {
    id: uid("bot"),
    name: "New bot",
    tagline: "",
    instructions: "",
    avatar: randomAvatar(),
    tools: { ...DEFAULT_TOOLS },
    skillIds: [],
    mcpServerIds: [],
    secretNames: [],
    createdAt: now,
    updatedAt: now,
  };
  await saveBot(bot);
  selectBot(bot.id);
  useApp.setState({ detailsOpen: true });
  return bot;
}
