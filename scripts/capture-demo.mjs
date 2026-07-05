// scripts/capture-demo.mjs
// Records a short screencast of the app driving the built-in demo dataset, then
// (if ffmpeg is on PATH) converts it to a compact GIF. Node built-ins + Playwright
// only — no shell built-ins — so it runs on Windows, macOS, and Linux.
//
// Prerequisites: see scripts/README.md (backend on :8000 with an empty cache,
// frontend dev server on :5173). Override the target with DEMO_URL.

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, existsSync, statSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const MEDIA_DIR = join(REPO_ROOT, "docs", "media");
const RAW_DIR = join(MEDIA_DIR, ".raw");
const WEBM = join(MEDIA_DIR, "demo.webm");
const GIF = join(MEDIA_DIR, "demo.gif");
const PALETTE = join(MEDIA_DIR, "demo.palette.png");
const DEMO_URL = process.env.DEMO_URL ?? "http://localhost:5173";
const VIEWPORT = { width: 1280, height: 800 };

// Deliberate on-screen dwell so each state is legible in the recording. This is
// pacing for the viewer, NOT synchronization — every state change below is first
// awaited on a visible element.
const dwell = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hasFfmpeg() {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", shell: false });
  return !probe.error && probe.status === 0;
}

async function record() {
  mkdirSync(RAW_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: RAW_DIR, size: VIEWPORT },
  });
  // Hint suppression: pre-seed the "seen" flag for the first-run glossary
  // coachmark (frontend/src/shell/useGlossaryHint.ts, key
  // "ccfr-glossary-hint-seen") so it never renders. Left undismissed, it
  // clips into the left edge of the recording — this runs before any app
  // script so useGlossaryHint's initial read already sees it as seen.
  await context.addInitScript(() => {
    window.localStorage.setItem("ccfr-glossary-hint-seen", "1");
  });
  const page = await context.newPage();
  const video = page.video();

  // 1. App loads on the Import screen.
  await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });
  const loadDemo = page.getByRole("button", { name: /load demo/i });
  await loadDemo.waitFor({ state: "visible", timeout: 60_000 });
  await dwell(1200);

  // 2. Load the built-in synthetic demo dataset.
  await loadDemo.click();

  // 3. Overview triage board — wait for real session rows to prove the import ran.
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByPlaceholder("Search sessions").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator("tbody tr").first().waitFor({ state: "visible", timeout: 60_000 });
  await dwell(2000);

  // 4. Open Context Economics via the Explore sub-nav.
  await page.getByRole("button", { name: "Explore" }).click();
  await page.getByRole("button", { name: "Context economics" }).click();
  const meter = page.locator(".tax-meter-bar").first();
  await meter.waitFor({ state: "visible", timeout: 60_000 });
  await dwell(1200);

  // 5. Hover the avoidable-spend meter to reveal its segment tooltips.
  await meter.hover();
  await dwell(2000);

  await context.close();
  await video.saveAs(WEBM);
  await browser.close();
  rmSync(RAW_DIR, { recursive: true, force: true });
  console.log(`Saved screencast: ${WEBM}`);
}

function toGif() {
  if (!hasFfmpeg()) {
    console.warn(
      "ffmpeg not found on PATH — kept the webm only. Install ffmpeg " +
        "(Windows: `winget install Gyan.FFmpeg`) and re-run to produce docs/media/demo.gif.",
    );
    return;
  }
  const vf = "fps=10,scale=960:-1:flags=lanczos";
  const pal = spawnSync("ffmpeg", ["-y", "-i", WEBM, "-vf", `${vf},palettegen`, PALETTE],
    { stdio: "inherit", shell: false });
  if (pal.status !== 0) { console.error("ffmpeg palettegen failed"); return; }
  const enc = spawnSync("ffmpeg",
    ["-y", "-i", WEBM, "-i", PALETTE, "-lavfi", `${vf}[x];[x][1:v]paletteuse`, GIF],
    { stdio: "inherit", shell: false });
  if (existsSync(PALETTE)) rmSync(PALETTE);
  if (enc.status !== 0) { console.error("ffmpeg gif encode failed"); return; }
  const mb = statSync(GIF).size / (1024 * 1024);
  console.log(`Saved GIF: ${GIF} (${mb.toFixed(2)} MB)`);
  if (mb > 5) {
    console.warn(`GIF is ${mb.toFixed(2)} MB (> 5 MB target) — lower fps or the 960px scale to shrink it.`);
  }
}

await record();
toGif();
