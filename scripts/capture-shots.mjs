// scripts/capture-shots.mjs
// Re-captures the six landing-carousel stills from the 100%-synthetic demo
// dataset (P03), replacing screenshots that previously contained real client
// data. Node built-ins + Playwright only. Output: ../docs/media/shots/*.png.
// Prereqs: same as capture-demo.mjs (backend on :8000 with an EMPTY cache so the
// "Load demo data" card shows, frontend dev server). Override target with DEMO_URL.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const SHOTS_DIR = join(REPO_ROOT, "docs", "media", "shots");
const DEMO_URL = process.env.DEMO_URL ?? "http://localhost:5173";
const VIEWPORT = { width: 1440, height: 900 };
const WAIT = { state: "visible", timeout: 60_000 };

// Brief settle for physics/transition-driven views (mindmap force sim, slide
// transitions) so a still is not captured mid-animation. Not synchronization —
// every screen is first awaited on a visible element.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });

  // Ensure the demo dataset is loaded (idempotent: the card only shows on an
  // empty cache; if data is already present we just continue).
  const loadDemo = page.getByRole("button", { name: /load demo/i });
  if (await loadDemo.isVisible().catch(() => false)) {
    await loadDemo.click();
    await page.getByRole("button", { name: "Overview" }).click();
    await page.getByPlaceholder("Search sessions").waitFor(WAIT);
    await page.locator("tbody tr").first().waitFor(WAIT);
  }

  const shot = async (file, selector, pre = 400) => {
    const el = page.locator(selector).first();
    await el.waitFor(WAIT);
    await el.scrollIntoViewIfNeeded();
    await settle(pre);
    await el.screenshot({ path: join(SHOTS_DIR, file) });
    console.log(`shot: ${file}`);
  };

  // 01 — Habit & anti-pattern mindmap.
  await page.getByRole("button", { name: "Explore" }).click();
  await page.getByRole("button", { name: "Usage Mindmap" }).click();
  await shot("mindmap.png", ".mindmap-stage", 1600); // let the d3-force layout settle

  // 02 — Tool error subgroup analysis.
  await page.getByRole("button", { name: "Subgroups" }).click();
  await page.getByRole("tab", { name: "Tool errors" }).click();
  await shot("subgroups.png", ".driver-board", 500);

  // 03 — Late compaction / context forensics.
  await page.getByRole("button", { name: "Context economics" }).click();
  await page.locator(".tax-meter-hero").first().waitFor(WAIT);
  await shot("context.png", ".discover-page-inner", 500);

  // 04 — Project & session cost.
  await page.getByRole("button", { name: "Cost" }).click();
  await shot("cost.png", ".cost-bento", 600);

  // 06 — Turn outlier analysis (a Cost-page tile, always shown in local scope).
  const turnTile = page
    .locator("section.tile")
    .filter({ has: page.getByRole("heading", { name: "Turn distribution" }) })
    .first();
  await turnTile.waitFor(WAIT);
  await turnTile.scrollIntoViewIfNeeded();
  await settle(400);
  await turnTile.screenshot({ path: join(SHOTS_DIR, "turns.png") });
  console.log("shot: turns.png");

  // 05 — Session forensics (open the first triage session).
  await page.getByRole("button", { name: "Overview" }).click();
  await page.locator("tbody tr").first().waitFor(WAIT);
  await page.locator("tbody tr").first().click();
  await shot("session.png", ".session-workspace", 600);

  // --- README screenshots (docs/screenshots/*.png) — Task 5b ---------------
  // Same synthetic dataset, 1x scale (README renders these small; 1x keeps
  // the repo size flat). Filename-matched so README.md needs no edit.
  const readmeCtx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const rp = await readmeCtx.newPage();
  await rp.goto(DEMO_URL, { waitUntil: "domcontentloaded" });

  const README_DIR = join(REPO_ROOT, "docs", "screenshots");
  mkdirSync(README_DIR, { recursive: true });
  const rshotPage = async (file, pre = 400) => {
    await settle(pre);
    await rp.screenshot({ path: join(README_DIR, file) });
    console.log(`readme shot: ${file}`);
  };
  const rshotEl = async (file, selector, pre = 400) => {
    const el = rp.locator(selector).first();
    await el.waitFor(WAIT);
    await el.scrollIntoViewIfNeeded();
    await settle(pre);
    await el.screenshot({ path: join(README_DIR, file) });
    console.log(`readme shot: ${file}`);
  };

  // import.png — Import screen with populated cache totals.
  // exact: true — the page also has an "Import all new" action button whose
  // accessible name would otherwise substring-match the sidebar nav button.
  await rp.getByRole("button", { name: "Import", exact: true }).click();
  await rp.getByPlaceholder("Path to the Claude Code export root").waitFor(WAIT);
  await rshotPage("import.png", 600);

  // triage-board.png — Overview with demo sessions.
  await rp.getByRole("button", { name: "Overview" }).click();
  await rp.getByPlaceholder("Search sessions").waitFor(WAIT);
  await rp.locator("tbody tr").first().waitFor(WAIT);
  await rshotPage("triage-board.png", 600);

  // session-workspace.png — first session opened.
  await rp.locator("tbody tr").first().click();
  await rshotEl("session-workspace.png", ".session-workspace", 800);

  // cost-analytics-1.png — Cost dashboard.
  await rp.getByRole("button", { name: "Cost" }).click();
  await rshotEl("cost-analytics-1.png", ".cost-bento", 600);

  // cost-analytics-2.png — turn distribution / outlier tile.
  const rTurnTile = rp
    .locator("section.tile")
    .filter({ has: rp.getByRole("heading", { name: "Turn distribution" }) })
    .first();
  await rTurnTile.waitFor(WAIT);
  await rTurnTile.scrollIntoViewIfNeeded();
  await settle(400);
  await rTurnTile.screenshot({ path: join(README_DIR, "cost-analytics-2.png") });
  console.log("readme shot: cost-analytics-2.png");

  // subgroup.png — Subgroups on its DEFAULT tab (README caption says
  // "session conditions ranked by lift over baseline" — no tab click).
  await rp.getByRole("button", { name: "Explore" }).click();
  await rp.getByRole("button", { name: "Subgroups" }).click();
  await rshotEl("subgroup.png", ".driver-board", 500);

  // context-economics.png — avoidable vs necessary spend.
  await rp.getByRole("button", { name: "Context economics" }).click();
  await rp.locator(".tax-meter-hero").first().waitFor(WAIT);
  await rshotEl("context-economics.png", ".discover-page-inner", 500);

  await readmeCtx.close();

  await context.close();
  await browser.close();
  console.log(`Saved 6 stills to ${SHOTS_DIR}`);
}

await main();
