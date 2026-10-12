#!/usr/bin/env node
// Builds Lantern releases, collects them in release/<version>/ and publishes them
// to a Lantern Hub, which serves the downloads page and desktop auto-updates.
//
//   node scripts/release.mjs build [windows,linux,android]   build on this machine
//   node scripts/release.mjs fetch-ci [run-id]               add macOS and iOS builds from a GitHub Actions run (needs gh)
//   node scripts/release.mjs publish [--notes "…"]           upload release/<version>/ to the hub
//
// Settings come from the environment or .env.local (never committed):
//   VITE_LANTERN_HUB_URL      hub address baked into the apps built here
//   LANTERN_PUBLISH_SSH       user@host of the hub server (uses ssh/scp)
//   LANTERN_PUBLISH_DIR       releases folder on the server (default /srv/lantern/releases)
//   LANTERN_UPDATER_KEY       updater signing key (default ~/.lantern/updater.key)
//   LANTERN_ANDROID_SIGNING   Android signing properties (default ~/.lantern/android-signing.properties)
//   GH                        GitHub CLI to use for fetch-ci (default gh)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
loadEnvLocal();
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const outDir = join(root, "release", version);
const isWindows = process.platform === "win32";

function loadEnvLocal() {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, shell: isWindows && !cmd.includes("\\"), ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status ?? r.error})`);
}

function copyInto(src, name = basename(src)) {
  mkdirSync(outDir, { recursive: true });
  copyFileSync(src, join(outDir, name));
  if (existsSync(`${src}.sig`)) copyFileSync(`${src}.sig`, join(outDir, `${name}.sig`));
  console.log(`  → release/${version}/${name}${existsSync(`${src}.sig`) ? " (+ signature)" : ""}`);
}

function findFiles(dir, test) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(test(entry.name, true) ? [p] : findFiles(p, test)));
    else if (test(entry.name, false)) out.push(p);
  }
  return out;
}

function updaterKeyPath() {
  return process.env.LANTERN_UPDATER_KEY || join(homedir(), ".lantern", "updater.key");
}

/** Signs installers so desktop apps accept them as updates. */
function signingEnv() {
  const key = updaterKeyPath();
  if (!existsSync(key)) {
    console.warn(`! No updater key at ${key}: builds won't be offered as auto-updates.`);
    return {};
  }
  return { TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, "utf8").trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.LANTERN_UPDATER_KEY_PASSWORD ?? "" };
}

function updaterConfig() {
  const file = join(root, "src-tauri", "target", "updater.conf.json");
  mkdirSync(join(root, "src-tauri", "target"), { recursive: true });
  writeFileSync(file, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
  return file;
}

// ------------------------------------------------------------------ build

function buildWindows() {
  const env = { ...process.env, ...signingEnv() };
  const args = ["tauri", "build"];
  if (env.TAURI_SIGNING_PRIVATE_KEY) args.push("--config", updaterConfig());
  run("npx", args, { env });
  const bundle = join(root, "src-tauri", "target", "release", "bundle");
  for (const f of findFiles(join(bundle, "nsis"), (n) => n.endsWith("-setup.exe"))) copyInto(f);
  for (const f of findFiles(join(bundle, "msi"), (n) => n.endsWith(".msi"))) copyInto(f);
}

function buildLinux() {
  const env = { ...process.env, ...signingEnv() };
  const out = join(tmpdir(), `lantern-linux-${version}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  run("docker", ["build", "-t", "lantern-linux", "-f", "scripts/linux.Dockerfile", "scripts"]);
  run("docker", ["run", "--rm", "-e", "TAURI_SIGNING_PRIVATE_KEY", "-e", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "-v", `${root}:/src:ro`, "-v", `${out}:/out`, "lantern-linux"], { env });
  for (const f of findFiles(out, (n) => /\.(deb|rpm|AppImage)$/.test(n))) copyInto(f);
}

function buildAndroid() {
  const signing = process.env.LANTERN_ANDROID_SIGNING || join(homedir(), ".lantern", "android-signing.properties");
  const env = { ...process.env };
  if (existsSync(signing)) env.LANTERN_ANDROID_SIGNING = signing;
  else console.warn(`! No Android signing file at ${signing}: the APK will be unsigned.`);
  run("npx", ["tauri", "android", "build", "--apk"], { env });
  const apks = findFiles(join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk"), (n) => n.endsWith(".apk") && n.includes("universal"));
  const signed = apks.find((f) => !f.includes("unsigned"));
  if (!signed) throw new Error("No signed universal APK was produced. Set LANTERN_ANDROID_SIGNING.");
  copyInto(signed, `Lantern_${version}_android-universal.apk`);
}

// ------------------------------------------------------------------ CI builds (macOS, iOS)

function fetchCi(runId) {
  const gh = process.env.GH || "gh";
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const repo = remote.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
  if (!runId) {
    const r = spawnSync(gh, ["run", "list", "-R", repo, "--workflow", "build.yml", "--branch", "main", "--status", "success", "--limit", "1", "--json", "databaseId"], { encoding: "utf8" });
    runId = JSON.parse(r.stdout || "[]")[0]?.databaseId;
    if (!runId) throw new Error("No successful CI run found.");
  }
  const dir = join(tmpdir(), `lantern-ci-${runId}`);
  rmSync(dir, { recursive: true, force: true });
  run(gh, ["run", "download", String(runId), "-R", repo, "-D", dir, "-n", "lantern-macos", "-n", "lantern-ios"]);

  const dmg = findFiles(dir, (n) => n.endsWith(".dmg"))[0];
  if (dmg) copyInto(dmg, `Lantern_${version}_universal.dmg`);
  const tarball = findFiles(dir, (n) => n.endsWith(".app.tar.gz"))[0];
  if (tarball) {
    // The macOS update archive is signed here, so the signing key never leaves this machine.
    const name = `Lantern_${version}_universal.app.tar.gz`;
    copyInto(tarball, name);
    const env = { ...process.env, ...signingEnv() };
    if (env.TAURI_SIGNING_PRIVATE_KEY) run("npx", ["tauri", "signer", "sign", join(outDir, name)], { env });
  }
  const iosApp = findFiles(dir, (n, isDir) => isDir && n.endsWith(".app"))[0];
  if (iosApp) {
    const zip = join(outDir, `Lantern_${version}_ios-simulator.zip`);
    rmSync(zip, { force: true });
    mkdirSync(outDir, { recursive: true });
    if (isWindows) run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${iosApp}' -DestinationPath '${zip}'`], { shell: false });
    else run("zip", ["-qr", zip, basename(iosApp)], { cwd: resolve(iosApp, "..") });
    console.log(`  → release/${version}/${basename(zip)}`);
  }
}

// ------------------------------------------------------------------ publish

const KINDS = [
  [/-setup\.exe$/, "windows", "nsis", "x86_64"],
  [/\.msi$/, "windows", "msi", "x86_64"],
  [/\.AppImage$/, "linux", "appimage", "x86_64"],
  [/\.deb$/, "linux", "deb", "x86_64"],
  [/\.rpm$/, "linux", "rpm", "x86_64"],
  [/\.dmg$/, "macos", "dmg", "universal"],
  [/\.app\.tar\.gz$/, "macos", "app", "universal"],
  [/\.apk$/, "android", "apk", "universal"],
  [/ios-simulator\.zip$/, "ios", "ios-sim", "arm64"],
];

function publish(notes) {
  const target = process.env.LANTERN_PUBLISH_SSH;
  const dir = process.env.LANTERN_PUBLISH_DIR || "/srv/lantern/releases";
  if (!target) throw new Error("Set LANTERN_PUBLISH_SSH (user@host of your hub) in .env.local.");
  if (!existsSync(outDir)) throw new Error(`Nothing to publish: release/${version}/ doesn't exist. Run the build first.`);

  const files = [];
  for (const name of readdirSync(outDir).sort()) {
    const kind = KINDS.find(([re]) => re.test(name));
    if (!kind) continue;
    const path = join(outDir, name);
    const sig = existsSync(`${path}.sig`) ? readFileSync(`${path}.sig`, "utf8").trim() : undefined;
    files.push({
      name,
      platform: kind[1],
      kind: kind[2],
      arch: kind[3],
      size: statSync(path).size,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      ...(sig ? { signature: sig } : {}),
    });
  }
  if (!files.length) throw new Error(`No installers in release/${version}/.`);
  const release = { version, notes: notes ?? `Lantern ${version}`, pubDate: new Date().toISOString(), files };
  writeFileSync(join(outDir, "release.json"), JSON.stringify(release, null, 2));

  console.log(`Publishing Lantern ${version} (${files.length} files) to ${target}:${dir}/${version}`);
  run("ssh", [target, `mkdir -p '${dir}/${version}'`], { shell: false });
  run("scp", ["-q", ...files.map((f) => join(outDir, f.name)), `${target}:${dir}/${version}/`], { shell: false });
  // The hub lists a release only once its release.json exists, so upload it last.
  run("scp", ["-q", join(outDir, "release.json"), `${target}:${dir}/${version}/`], { shell: false });
  for (const f of files) console.log(`  ${f.platform.padEnd(8)} ${f.kind.padEnd(9)} ${f.name}${f.signature ? "  (auto-update)" : ""}`);
}

// ------------------------------------------------------------------ main

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "build") {
    const wanted = (rest[0] ?? (isWindows ? "windows,android" : process.platform === "linux" ? "linux,android" : "")).split(",").filter(Boolean);
    if (!wanted.length) throw new Error("Say what to build: windows, linux, android (macOS and iOS come from CI: fetch-ci).");
    for (const p of wanted) ({ windows: buildWindows, linux: buildLinux, android: buildAndroid })[p]?.() ?? console.warn(`Unknown platform ${p}`);
  } else if (command === "fetch-ci") {
    fetchCi(rest[0]);
  } else if (command === "publish") {
    const i = rest.indexOf("--notes");
    publish(i >= 0 ? rest[i + 1] : undefined);
  } else {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(command ? 1 : 0);
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}
