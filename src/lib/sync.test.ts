import { describe, expect, it } from "vitest";
import { normalizeHubUrl } from "./hub";
import { isSyncedDoc, isSyncedSecret, knownSecretKeys, settingsForHub, settingsFromHub } from "./sync";
import type { Bot, McpServer, Provider, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { compareVersions } from "./updates";

describe("what syncs through the hub", () => {
  it("syncs the shared collections, chat messages and settings", () => {
    for (const c of ["bots", "providers", "conversations", "skills", "memories", "mcp", "routines"]) expect(isSyncedDoc(c, "x")).toBe(true);
    expect(isSyncedDoc("msg:conv_1", "msg_1")).toBe(true);
    expect(isSyncedDoc("meta", "settings")).toBe(true);
  });

  it("keeps device-local records out", () => {
    expect(isSyncedDoc("local", "hub")).toBe(false);
    expect(isSyncedDoc("sync:outbox", "x")).toBe(false);
    expect(isSyncedDoc("meta", "something-else")).toBe(false);
  });

  it("never syncs the hub token", () => {
    expect(isSyncedSecret("provider:p1")).toBe(true);
    expect(isSyncedSecret("hub:token")).toBe(false);
  });
});

describe("settings", () => {
  const local: Settings = { ...DEFAULT_SETTINGS, workspace: "C:\\Users\\me\\Lantern", onboarded: true, autoUpdate: false, theme: "dark" };

  it("strips device-only fields before upload", () => {
    const out = settingsForHub(local);
    expect(out).not.toHaveProperty("workspace");
    expect(out).not.toHaveProperty("onboarded");
    expect(out).not.toHaveProperty("autoUpdate");
    expect(out.theme).toBe("dark");
  });

  it("applies remote settings but keeps this device's own fields", () => {
    const remote = { ...DEFAULT_SETTINGS, theme: "light" as const, workspace: "/home/other", approvalMode: "auto" as const };
    const out = settingsFromHub(remote, local);
    expect(out.theme).toBe("light");
    expect(out.approvalMode).toBe("auto");
    expect(out.workspace).toBe("C:\\Users\\me\\Lantern");
    expect(out.autoUpdate).toBe(false);
    expect(out.onboarded).toBe(true);
  });

  it("marks a fresh device as set up when the hub already has an environment", () => {
    expect(settingsFromHub(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, onboarded: false }).onboarded).toBe(true);
  });
});

describe("secret discovery", () => {
  it("finds every secret the data refers to", () => {
    const providers = [{ id: "p1", hasKey: true }, { id: "p2", hasKey: false }] as Provider[];
    const bots = [{ id: "b1", secretNames: ["GITHUB_TOKEN"] }] as Bot[];
    const mcp = [{ id: "m1", envKeys: ["API_KEY"], headerKeys: ["Authorization"] }] as McpServer[];
    expect(knownSecretKeys(providers, bots, mcp)).toEqual(["provider:p1", "bot:b1:GITHUB_TOKEN", "mcp:m1:env:API_KEY", "mcp:m1:header:Authorization"]);
  });
});

describe("hub addresses", () => {
  it("adds https and trims paths", () => {
    expect(normalizeHubUrl("lantern.example.ts.net")).toBe("https://lantern.example.ts.net");
    expect(normalizeHubUrl(" https://hub.example/api/v1/ ")).toBe("https://hub.example");
    expect(normalizeHubUrl("http://10.0.0.5:8780/")).toBe("http://10.0.0.5:8780");
  });
});

describe("versions", () => {
  it("compares numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
  });
});
