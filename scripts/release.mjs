#!/usr/bin/env node
// Builds Lantern releases, collects them in release/<version>/ and publishes them
// to a Lantern Hub, which serves the downloads page and desktop auto-updates.
//
//   node scripts/release.mjs build [windows,linux,android]   build on this machine
//   node scripts/release.mjs fetch-ci [run-id]               add macOS and iOS builds from a GitHub Actions run (needs gh)
//   node scripts/release.mjs publish [--notes "…"]           upload release/<version>/ to the hub
//   node scripts/release.mjs github [run-id] [--notes "…"]   publish a CI run's builds as a GitHub Release (needs gh)
// Add --version X to work on a version other than the one in package.json.
//
// Settings come from the environment or .env.local (never committed):
//   VITE_LANTERN_HUB_URL      hub address baked into the apps built here
//   LANTERN_PUBLISH_SSH       user@host of the hub server (uses ssh/scp)
//   LANTERN_PUBLISH_DIR       releases folder on the server (default /srv/lantern/releases)
//   LANTERN_UPDATER_KEY       updater signing key (default ~/.lantern/updater.key)
//   LANTERN_ANDROID_SIGNING   Android signing properties (default ~/.lantern/android-signing.properties)
//   GH                        GitHub CLI to use for fetch-ci and github (default gh)
//   JAVA_HOME                 a JDK, for apksigner when github signs the APK (with the Android SDK build-tools)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
loadEnvLocal();
const argv = process.argv.slice(2);
const versionFlag = argv.indexOf("--version");
// Defaults to the version in package.json; --version republishes or fetches an older one.
const version = versionFlag >= 0 ? argv.splice(versionFlag, 2)[1] : JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
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
  // The bundle folders keep installers from earlier versions; take only this one's.
  const current = (n) => n.includes(`_${version}_`);
  for (const f of findFiles(join(bundle, "nsis"), (n) => current(n) && n.endsWith("-setup.exe"))) copyInto(f);
  for (const f of findFiles(join(bundle, "msi"), (n) => current(n) && n.endsWith(".msi"))) copyInto(f);
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

const gh = () => process.env.GH || "gh";

function repoSlug() {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).stdout.trim();
  return remote.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
}

function latestGreenRun(repo) {
  const r = spawnSync(gh(), ["run", "list", "-R", repo, "--workflow", "build.yml", "--branch", "main", "--status", "success", "--limit", "1", "--json", "databaseId"], { encoding: "utf8" });
  const runId = JSON.parse(r.stdout || "[]")[0]?.databaseId;
  if (!runId) throw new Error("No successful CI run found.");
  return String(runId);
}

function fetchCi(runId) {
  const repo = repoSlug();
  runId ||= latestGreenRun(repo);
  const dir = join(tmpdir(), `lantern-ci-${runId}`);
  rmSync(dir, { recursive: true, force: true });
  run(gh(), ["run", "download", String(runId), "-R", repo, "-D", dir, "-n", "lantern-macos", "-n", "lantern-ios"]);

  const dmg = findFiles(dir, (n) => n.endsWith(".dmg"))[0];
  if (dmg) copyInto(dmg, `Lantern_${version}_universal.dmg`);
  const tarball = findFiles(dir, (n) => n.endsWith(".app.tar.gz"))[0];
  if (tarball) {
    // The macOS update archive is signed by `publish`, so the signing key never leaves this machine.
    copyInto(tarball, `Lantern_${version}_universal.app.tar.gz`);
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

/** Installers the desktop updater can install. */
const UPDATABLE = new Set(["nsis", "msi", "appimage", "deb", "rpm", "app"]);

/**
 * Writes `dir`/release.json, the manifest a hub serves downloads and updates from, after
 * signing every desktop installer in `dir` with the updater key.
 */
function writeRelease(dir, notes) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const kind = KINDS.find(([re]) => re.test(name));
    if (!kind) continue;
    const path = join(dir, name);
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
  if (!files.length) throw new Error(`No installers in ${dir}.`);

  // Sign every desktop update with its version bound into the signature, so a tampered manifest
  // can't offer an older (genuinely signed) release as an "update".
  const env = { ...process.env, ...signingEnv() };
  for (const f of files.filter((f) => UPDATABLE.has(f.kind))) {
    if (!env.TAURI_SIGNING_PRIVATE_KEY) break;
    const path = join(dir, f.name);
    const r = spawnSync("npx", ["tauri", "signer", "sign", "--app-version", version, path], { cwd: root, env, shell: isWindows, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`signing ${f.name} failed: ${r.stderr || r.stdout}`);
    f.signature = readFileSync(`${path}.sig`, "utf8").trim();
  }
  const release = { version, notes: notes ?? `Lantern ${version}`, pubDate: new Date().toISOString(), files };
  writeFileSync(join(dir, "release.json"), JSON.stringify(release, null, 2));
  return release;
}

function publish(notes) {
  const target = process.env.LANTERN_PUBLISH_SSH;
  const dir = process.env.LANTERN_PUBLISH_DIR || "/srv/lantern/releases";
  if (!target) throw new Error("Set LANTERN_PUBLISH_SSH (user@host of your hub) in .env.local.");
  if (!existsSync(outDir)) throw new Error(`Nothing to publish: release/${version}/ doesn't exist. Run the build first.`);
  const { files } = writeRelease(outDir, notes);

  console.log(`Publishing Lantern ${version} (${files.length} files) to ${target}:${dir}/${version}`);
  run("ssh", [target, `mkdir -p '${dir}/${version}'`], { shell: false });
  run("scp", ["-q", ...files.map((f) => join(outDir, f.name)), `${target}:${dir}/${version}/`], { shell: false });
  // The hub lists a release only once its release.json exists, so upload it last.
  run("scp", ["-q", join(outDir, "release.json"), `${target}:${dir}/${version}/`], { shell: false });
  for (const f of files) console.log(`  ${f.platform.padEnd(8)} ${f.kind.padEnd(9)} ${f.name}${f.signature ? "  (auto-update)" : ""}`);
}

// ------------------------------------------------------------------ GitHub release

function androidSdk() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA || join(homedir(), "Library"), "Android", "Sdk");
}

/** Signs a CI-built (unsigned) APK with the release keystore, so it installs and updates like the hub's builds. */
function signApk(unsigned, dest) {
  const propsFile = process.env.LANTERN_ANDROID_SIGNING || join(homedir(), ".lantern", "android-signing.properties");
  if (!existsSync(propsFile)) throw new Error(`No Android signing file at ${propsFile}.`);
  const props = Object.fromEntries(
    readFileSync(propsFile, "utf8")
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const tools = join(androidSdk(), "build-tools");
  const latest = readdirSync(tools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  const bin = (name) => join(tools, latest, isWindows ? (name === "apksigner" ? "apksigner.bat" : "zipalign.exe") : name);
  const aligned = `${dest}.aligned`;
  run(bin("zipalign"), ["-p", "-f", "4", unsigned, aligned], { shell: false });
  // The password goes through the environment, never the command line.
  const env = { ...process.env, LANTERN_KS_PASS: props.password };
  const ks = resolve(dirname(propsFile), props.storeFile);
  run(`"${bin("apksigner")}"`, ["sign", "--ks", `"${ks}"`, "--ks-key-alias", props.keyAlias, "--ks-pass", "env:LANTERN_KS_PASS", "--key-pass", "env:LANTERN_KS_PASS", "--out", `"${dest}"`, `"${aligned}"`], { env, shell: true });
  rmSync(aligned, { force: true });
  rmSync(`${dest}.idsig`, { force: true });
  run(`"${bin("apksigner")}"`, ["verify", `"${dest}"`], { shell: true });
}

/** Files in the hub archive that must be executable (a tar made on Windows would lose the bit). */
const EXECUTABLE = new Set(["lantern-hub", "install.sh", "lantern-hub-fetch-release"]);

/** A .tar.gz with explicit file modes, written here so it doesn't depend on the platform's tar. */
function tarGz(entries) {
  const blocks = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    const dir = e.data === undefined;
    const size = dir ? 0 : e.data.length;
    const h = Buffer.alloc(512);
    const field = (value, offset, length) => h.write(value, offset, length, "ascii");
    const octal = (n, length) => n.toString(8).padStart(length - 1, "0") + "\0";
    field(e.name, 0, 100);
    field(octal(e.mode, 8), 100, 8);
    field(octal(0, 8), 108, 8);
    field(octal(0, 8), 116, 8);
    field(octal(size, 12), 124, 12);
    field(octal(mtime, 12), 136, 12);
    field("        ", 148, 8);
    field(dir ? "5" : "0", 156, 1);
    field("ustar\0", 257, 6);
    field("00", 263, 2);
    field("root", 265, 32);
    field("root", 297, 32);
    let sum = 0;
    for (const b of h) sum += b;
    field(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(h);
    if (!dir) blocks.push(e.data, Buffer.alloc((512 - (size % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/**
 * Publishes a CI run's builds as a GitHub Release for anyone to download. CI builds have
 * no hub address baked in. Update signatures and the APK signature are made here, so the
 * keys never leave this machine, and release.json lets any hub serve the release
 * (hub/deploy/lantern-hub-fetch-release).
 */
function githubRelease(runId, notes) {
  const repo = repoSlug();
  runId ||= latestGreenRun(repo);
  const info = JSON.parse(spawnSync(gh(), ["run", "view", runId, "-R", repo, "--json", "headSha,conclusion"], { encoding: "utf8" }).stdout || "{}");
  if (info.conclusion !== "success") throw new Error(`CI run ${runId} didn't succeed (${info.conclusion ?? "not found"}).`);
  const built = JSON.parse(spawnSync("git", ["show", `${info.headSha}:package.json`], { cwd: root, encoding: "utf8" }).stdout || "{}").version;
  if (built !== version) throw new Error(`CI run ${runId} built ${built}, not ${version}.`);

  const dl = join(tmpdir(), `lantern-gh-${runId}`);
  rmSync(dl, { recursive: true, force: true });
  run(gh(), ["run", "download", runId, "-R", repo, "-D", dl]);
  const out = join(outDir, "github");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const put = (src, name = basename(src)) => {
    copyFileSync(src, join(out, name));
    console.log(`  → release/${version}/github/${name}`);
  };
  const one = (test, what) => {
    const f = findFiles(dl, test)[0];
    if (!f) throw new Error(`CI run ${runId} has no ${what}.`);
    return f;
  };
  const ofVersion = (n) => n.includes(version);
  put(one((n) => ofVersion(n) && n.endsWith("-setup.exe"), "Windows installer"));
  put(one((n) => ofVersion(n) && n.endsWith(".msi"), "MSI"));
  put(one((n) => ofVersion(n) && n.endsWith(".deb"), "deb"));
  put(one((n) => ofVersion(n) && n.endsWith(".rpm"), "rpm"));
  put(one((n) => ofVersion(n) && n.endsWith(".AppImage"), "AppImage"));
  put(one((n) => ofVersion(n) && n.endsWith(".dmg"), "DMG"), `Lantern_${version}_universal.dmg`);
  put(one((n) => n.endsWith(".app.tar.gz"), "macOS update archive"), `Lantern_${version}_universal.app.tar.gz`);
  signApk(one((n) => n.endsWith(".apk") && n.includes("universal") && n.includes("release"), "release APK"), join(out, `Lantern_${version}_android-universal.apk`));
  const iosApp = findFiles(dl, (n, isDir) => isDir && n.endsWith(".app"))[0];
  if (iosApp) {
    const zip = join(out, `Lantern_${version}_ios-simulator.zip`);
    if (isWindows) run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${iosApp}' -DestinationPath '${zip}'`], { shell: false });
    else run("zip", ["-qr", zip, basename(iosApp)], { cwd: resolve(iosApp, "..") });
  }
  const release = writeRelease(out, notes);

  // The hub: binary and deploy files, one archive per CPU.
  const hubFiles = [];
  for (const arch of ["x86_64", "aarch64"]) {
    const src = findFiles(dl, (n, isDir) => isDir && n === `lantern-hub-${arch}`)[0];
    if (!src) throw new Error(`CI run ${runId} has no lantern-hub-${arch}.`);
    const name = `lantern-hub_${version}_linux-${arch}.tar.gz`;
    const top = `lantern-hub-${version}`;
    const files = readdirSync(src)
      .filter((f) => f !== "CLAUDE.md")
      .sort()
      .map((f) => ({ name: `${top}/${f}`, data: readFileSync(join(src, f)), mode: EXECUTABLE.has(f) ? 0o755 : 0o644 }));
    writeFileSync(join(out, name), tarGz([{ name: `${top}/`, mode: 0o755 }, ...files]));
    hubFiles.push(name);
    console.log(`  → release/${version}/github/${name}`);
  }

  const assets = [...release.files.flatMap((f) => [f.name, ...(f.signature ? [`${f.name}.sig`] : [])]), ...hubFiles, "release.json"];
  const sums = assets.filter((n) => n !== "release.json").map((n) => `${createHash("sha256").update(readFileSync(join(out, n))).digest("hex")}  ${n}`);
  writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
  assets.push("SHA256SUMS");

  const tag = `v${version}`;
  const body = `${notes ?? `Lantern ${version}`}\n\nInstall the app for your device below. To share one environment across your devices, run your own Lantern Hub: see [docs/HUB.md](https://github.com/${repo}/blob/main/docs/HUB.md).`;
  const notesFile = join(dl, "notes.md");
  writeFileSync(notesFile, body);
  const exists = spawnSync(gh(), ["release", "view", tag, "-R", repo], { encoding: "utf8" }).status === 0;
  const paths = assets.map((n) => join(out, n));
  if (exists) run(gh(), ["release", "upload", tag, "-R", repo, "--clobber", ...paths]);
  else run(gh(), ["release", "create", tag, "-R", repo, "--target", info.headSha, "--title", `Lantern ${version}`, "--notes-file", notesFile, ...paths]);
  console.log(`GitHub release ${tag}: https://github.com/${repo}/releases/tag/${tag}`);
}

// ------------------------------------------------------------------ main

const [command, ...rest] = argv;
try {
  if (command === "build") {
    const wanted = (rest[0] ?? (isWindows ? "windows,android" : process.platform === "linux" ? "linux,android" : "")).split(",").filter(Boolean);
    if (!wanted.length) throw new Error("Say what to build: windows, linux, android (macOS and iOS come from CI: fetch-ci).");
    const builders = { windows: buildWindows, linux: buildLinux, android: buildAndroid };
    for (const p of wanted) {
      if (builders[p]) builders[p]();
      else console.warn(`Unknown platform ${p}`);
    }
  } else if (command === "fetch-ci") {
    fetchCi(rest[0]);
  } else if (command === "publish") {
    const i = rest.indexOf("--notes");
    publish(i >= 0 ? rest[i + 1] : undefined);
  } else if (command === "github") {
    const i = rest.indexOf("--notes");
    const notes = i >= 0 ? rest.splice(i, 2)[1] : undefined;
    githubRelease(rest[0], notes);
  } else {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(command ? 1 : 0);
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}
