// What a bot's avatar can be, and two ways to change it besides the editor:
// the bot changes its own (update_profile), or the model designs one from a
// description you give. Avatars stay drawn, not generated images, so they keep
// Lantern's look.

import { complete } from "./llm";
import { resolveModel } from "./agent";
import { saveBot, useApp } from "./store";
import type { ToolDef } from "./tools";
import type { AvatarEyes, AvatarMouth, AvatarShape, AvatarSpec, Bot } from "./types";

export const AVATAR_SHAPES: AvatarShape[] = ["circle", "squircle", "hexagon", "flower", "diamond", "shield"];
export const AVATAR_EYES: AvatarEyes[] = ["dots", "happy", "wink", "wide", "sleepy", "visor"];
export const AVATAR_MOUTHS: AvatarMouth[] = ["smile", "grin", "flat", "open", "tongue", "none"];

/** Enamel paint colors, as on old lanterns and tool tins, by name. */
export const PAINTS: Record<string, string> = {
  brass: "#D9A21B",
  brick: "#C8462B",
  orange: "#E8630A",
  blue: "#2E5C8A",
  green: "#2F6B4F",
  olive: "#5E7D3A",
  teal: "#4E7F8C",
  brown: "#8C6A4F",
  rust: "#B85C38",
  sage: "#7A8B7F",
  pewter: "#C9CEC7",
  oxblood: "#8E2F25",
};
export const AVATAR_COLORS = Object.values(PAINTS);

const pickColor = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return PAINTS[s] ?? AVATAR_COLORS.find((c) => c.toLowerCase() === s);
};
const oneOf = <T extends string>(list: T[], v: unknown): T | undefined => (typeof v === "string" && (list as string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as T) : undefined);

/** Keeps what's valid from a proposed avatar and the rest of the current one. */
export function mergeAvatar(current: AvatarSpec, p: Record<string, unknown>): AvatarSpec {
  const badge = typeof p.badge === "string" ? [...p.badge.trim()].slice(0, 2).join("") : undefined;
  return {
    shape: oneOf(AVATAR_SHAPES, p.shape) ?? current.shape,
    color: pickColor(p.color) ?? current.color,
    eyes: oneOf(AVATAR_EYES, p.eyes) ?? current.eyes,
    mouth: oneOf(AVATAR_MOUTHS, p.mouth) ?? current.mouth,
    badge: p.badge === null || p.badge === "" ? undefined : (badge ?? current.badge),
  };
}

const OPTIONS = `shape: ${AVATAR_SHAPES.join(", ")}
color: ${Object.keys(PAINTS).join(", ")}
eyes: ${AVATAR_EYES.join(", ")}
mouth: ${AVATAR_MOUTHS.join(", ")}
badge: one emoji worn in the corner, or "" for none`;

export const UPDATE_PROFILE_TOOL: ToolDef = {
  name: "update_profile",
  group: "profile",
  risk: "internal",
  description: `Change your own name, tagline or avatar when the user asks (or agrees). Avatar options:\n${OPTIONS}`,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      tagline: { type: "string" },
      shape: { type: "string", enum: AVATAR_SHAPES },
      color: { type: "string", enum: Object.keys(PAINTS) },
      eyes: { type: "string", enum: AVATAR_EYES },
      mouth: { type: "string", enum: AVATAR_MOUTHS },
      badge: { type: "string" },
    },
    additionalProperties: false,
  },
  summarize: (a) => (a.name ? `Rename itself to ${a.name}` : "Change its look"),
  async run(a, ctx) {
    const bot = useApp.getState().bots.find((b) => b.id === ctx.bot.id) ?? ctx.bot;
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 52) : bot.name;
    const tagline = typeof a.tagline === "string" ? a.tagline.trim().slice(0, 120) : bot.tagline;
    const avatar = mergeAvatar(bot.avatar, a);
    await saveBot({ ...bot, name, tagline, avatar });
    return `Updated: ${name}${tagline ? ` (${tagline})` : ""}, a ${Object.entries(PAINTS).find(([, c]) => c === avatar.color)?.[0] ?? "colored"} ${avatar.shape} with ${avatar.eyes} eyes and a ${avatar.mouth} mouth${avatar.badge ? `, wearing ${avatar.badge}` : ""}.`;
  },
};

/** Asks the model to turn a description ("a cheerful owl who loves maps") into an avatar. */
export async function designAvatar(bot: Bot, description: string): Promise<AvatarSpec> {
  const { provider, model } = resolveModel(bot);
  const text = await complete(
    provider,
    model,
    [
      {
        role: "system",
        content: `You design small drawn avatars for AI assistants. Pick the options that best fit the description, and an emoji badge that captures it. Options:\n${OPTIONS}\nReply with JSON only: {"shape": "...", "color": "...", "eyes": "...", "mouth": "...", "badge": "..."}`,
      },
      { role: "user", content: `The bot is ${bot.name}${bot.tagline ? `, ${bot.tagline}` : ""}. Description: ${description}` },
    ],
    { maxTokens: 300, temperature: 0.7 },
  );
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The model didn't answer with an avatar. Try again, or describe it differently.");
  return mergeAvatar(bot.avatar, JSON.parse(m[0]));
}
