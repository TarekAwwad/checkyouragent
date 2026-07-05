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

  await context.close();
  await browser.close();
  console.log(`Saved 6 stills to ${SHOTS_DIR}`);
}

await main();
