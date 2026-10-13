// Share a bot as a template: its name, look, instructions, tools, private
// skills and routines, packed into a link. The template travels in the link
// itself (after the #, which browsers never send to a server), so sharing
// needs no account and stores nothing anywhere. Secrets, memories, chats,
// inboxes and model choices never go in.

import { saveBot, saveRoutine, saveSkill, selectBot, useApp } from "./store";
import { nextRun } from "./schedule";
import type { AvatarSpec, Bot, BotToolToggles, Schedule } from "./types";
import { DEFAULT_TOOLS } from "./types";
import { uid } from "./util";

export const SHARE_BASE = "https://exyze.github.io/lantern/t/";

export interface SharedTemplate {
  v: 1;
  name: string;
  tagline: string;
  instructions: string;
  avatar: AvatarSpec;
  tools: Partial<BotToolToggles>;
  skills: { name: string; description: string; content: string }[];
  routines: { name: string; prompt: string; schedule: Schedule }[];
}

export function templateFromBot(bot: Bot, opts: { skills: boolean; routines: boolean }): SharedTemplate {
  const { skills, routines } = useApp.getState();
  return {
    v: 1,
    name: bot.name,
    tagline: bot.tagline,
    instructions: bot.instructions,
    avatar: bot.avatar,
    tools: bot.tools,
    skills: opts.skills ? skills.filter((s) => s.botId === bot.id).map((s) => ({ name: s.name, description: s.description, content: s.content })) : [],
    // Only scheduled routines: webhook and email ones belong to one person's setup.
    routines: opts.routines ? routines.filter((r) => r.botId === bot.id && (r.trigger?.kind ?? "schedule") === "schedule").map((r) => ({ name: r.name, prompt: r.prompt, schedule: r.schedule })) : [],
  };
}

const toB64url = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes.slice()]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** The link for a template: compressed when the device can, plain otherwise. */
export async function shareLink(t: SharedTemplate): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(t));
  if (typeof CompressionStream !== "undefined") return `${SHARE_BASE}#z${toB64url(await pipe(json, new CompressionStream("deflate-raw")))}`;
  return `${SHARE_BASE}#j${toB64url(json)}`;
}

/** Reads a template from a link (or the part after #, or pasted JSON). */
export async function readTemplate(input: string): Promise<SharedTemplate> {
  const raw = input.trim();
  let json: string;
  if (raw.startsWith("{")) {
    json = raw;
  } else {
    const data = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : raw;
    if (data[0] === "z") json = new TextDecoder().decode(await pipe(fromB64url(data.slice(1)), new DecompressionStream("deflate-raw")));
    else if (data[0] === "j") json = new TextDecoder().decode(fromB64url(data.slice(1)));
    else throw new Error("That isn't a Lantern template link.");
  }
  const t = JSON.parse(json) as Partial<SharedTemplate>;
  if (t?.v !== 1 || typeof t.name !== "string" || typeof t.instructions !== "string") throw new Error("That template is damaged or from a newer Lantern.");
  return {
    v: 1,
    name: t.name.slice(0, 52),
    tagline: String(t.tagline ?? "").slice(0, 200),
    instructions: t.instructions.slice(0, 20_000),
    avatar: t.avatar ?? { shape: "circle", color: "#C9CEC7", eyes: "dots", mouth: "smile" },
    tools: t.tools ?? {},
    skills: (t.skills ?? []).slice(0, 30),
    routines: (t.routines ?? []).slice(0, 20),
  };
}

/** Makes a new bot from a template, with its skills, and its routines paused. */
export async function createFromShared(t: SharedTemplate): Promise<Bot> {
  const now = Date.now();
  const bot: Bot = {
    id: uid("bot"),
    name: t.name,
    tagline: t.tagline,
    instructions: t.instructions,
    avatar: t.avatar,
    tools: { ...DEFAULT_TOOLS, ...t.tools },
    skillIds: [],
    mcpServerIds: [],
    secretNames: [],
    createdAt: now,
    updatedAt: now,
  };
  await saveBot(bot);
  for (const s of t.skills) await saveSkill({ id: uid("skill"), name: s.name, description: s.description, content: s.content, botId: bot.id, createdAt: now, updatedAt: now });
  for (const r of t.routines) {
    await saveRoutine({ id: uid("routine"), botId: bot.id, name: r.name, prompt: r.prompt, schedule: r.schedule, trigger: { kind: "schedule" }, enabled: false, nextRunAt: nextRun(r.schedule, now), createdAt: now });
  }
  selectBot(bot.id);
  return bot;
}
