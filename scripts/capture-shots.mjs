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
const DEMO_URL = process.env.DEMO_URL ?? "http://localhost:5174";
const VIEWPORT = { width: 1440, height: 900 };
const WAIT = { state: "visible", timeout: 60_000 };
const DEMO_PROJECTS = ["demo-data-pipeline", "demo-mobile-app", "demo-web-shop"];
const DEMO_SESSION_COUNT = 46;
// Stand-in shown in import.png so the capture machine's real export root is
// never published.
const MASKED_ROOT = "<configured Claude export root>";

// Brief settle for physics/transition-driven views (mindmap force sim, slide
// transitions) so a still is not captured mid-animation. Not synchronization —
// every screen is first awaited on a visible element.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const nav = (page, label) =>
  page.locator(".app-sidebar nav").getByRole("button", { name: label, exact: true }).click();

// App panels scroll inside the viewport. A full element screenshot includes
// blank pixels below that scroll container, so capture only its visible area.
// Cost's overview ends after the model tile; turn details have their own shot.
async function captureVisibleElement(page, element, path, lastElement) {
  const box = await element.boundingBox();
  const end = lastElement ? await lastElement.boundingBox() : box;
  const viewport = page.viewportSize();
  if (!box || !end || !viewport) throw new Error("Capture region is unavailable.");
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const width = Math.min(viewport.width, box.x + box.width) - x;
  const height = Math.min(viewport.height, end.y + end.height) - y;
  if (width <= 0 || height <= 0) throw new Error("Capture region is outside the viewport.");
  await page.screenshot({ path, clip: { x, y, width, height } });
}

// Keep captures on the full fixed demo corpus even if date-filter defaults
// change later.
async function selectAllTime(p) {
  await p.getByLabel("Date range").selectOption("all");
  await p
    .getByText("No cost data in range")
    .waitFor({ state: "hidden", timeout: 60_000 })
    .catch(() => {});
}

async function assertSyntheticSessions(page) {
  const sessions = await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .toReversed()
      .find((entry) => new URL(entry.name).pathname.endsWith("/api/sessions"));
    if (!resource) throw new Error("Could not locate the Sessions API request.");
    const url = new URL(resource.name);
    url.search = "";
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Sessions API returned ${response.status}.`);
    return response.json();
  });
  if (!Array.isArray(sessions)) {
    throw new Error("Refusing to capture: the Sessions API returned an unexpected payload.");
  }
  const seen = new Set();
  for (const session of sessions) {
    const project = session?.project_name;
    if (typeof project !== "string" || !DEMO_PROJECTS.includes(project)) {
      throw new Error("Refusing to capture: the Sessions table contains non-demo data.");
    }
    seen.add(project);
  }
  if (sessions.length !== DEMO_SESSION_COUNT || seen.size !== DEMO_PROJECTS.length) {
    throw new Error("Refusing to capture: the complete bundled demo corpus is not loaded.");
  }
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  // Hint suppression: pre-seed the "seen" flag for the first-run glossary
  // coachmark (frontend/src/shell/useGlossaryHint.ts, key
  // "ccfr-glossary-hint-seen") so it never renders. Left undismissed, it
  // clips into the left edge of these stills — this runs before any app
  // script so useGlossaryHint's initial read already sees it as seen.
  await context.addInitScript(() => {
    if (window.location.origin !== "null") window.localStorage.setItem("ccfr-glossary-hint-seen", "1");
  });
  const page = await context.newPage();
  await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });

  // Load the demo into an empty cache, or verify that an existing cache contains
  // only the complete bundled demo before writing any public artifact.
  const loadDemo = page.getByRole("button", { name: /load demo/i });
  const demoAvailable = await loadDemo
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (demoAvailable) {
    await loadDemo.click();
  }
  await nav(page, "Sessions");
  await page.getByPlaceholder("Search sessions").waitFor(WAIT);
  await page.locator("tbody tr").first().waitFor(WAIT);
  await assertSyntheticSessions(page);

  const shot = async (file, selector, pre = 400, endSelector) => {
    const el = page.locator(selector).first();
    await el.waitFor(WAIT);
    await el.scrollIntoViewIfNeeded();
    await settle(pre);
    await captureVisibleElement(page, el, join(SHOTS_DIR, file), endSelector ? page.locator(endSelector).first() : undefined);
    console.log(`shot: ${file}`);
  };

  // 01 — Habit & anti-pattern mindmap.
  await nav(page, "Explore");
  await page.getByRole("button", { name: "Usage Mindmap" }).click();
  await shot("mindmap.png", ".mindmap-stage", 1600); // let the d3-force layout settle

  // 02 — Tool error subgroup analysis.
  await page.getByRole("button", { name: "Subgroups" }).click();
  await page.getByRole("tab", { name: "Tool errors" }).click();
  await shot("subgroups.png", ".driver-board", 500);

  // 03 — Estimated context opportunity with receipt-backed evidence.
  await page.getByRole("button", { name: "Context economics" }).click();
  await page.locator(".opportunity-meter-hero").first().waitFor(WAIT);
  await shot("context.png", ".discover-page-inner", 500);

  // 04 — Project & session cost.
  await nav(page, "Cost");
  await selectAllTime(page);
  await shot("cost.png", ".cost-bento", 600, ".cost-model-tile");

  // 06 — Turn outlier analysis (a Cost-page tile, always shown in local scope).
  const turnTile = page
    .locator("section.tile")
    .filter({ has: page.getByRole("heading", { name: "Turn distribution" }) })
    .first();
  await turnTile.waitFor(WAIT);
  await turnTile.scrollIntoViewIfNeeded();
  await settle(400);
  await captureVisibleElement(page, turnTile, join(SHOTS_DIR, "turns.png"));
  console.log("shot: turns.png");

  // 05 — Session forensics (open the first triage session).
  await nav(page, "Sessions");
  await page.locator("tbody tr").first().waitFor(WAIT);
  await page.locator("tbody tr").first().click();
  await shot("session.png", ".session-workspace", 600);

  // --- README screenshots (docs/screenshots/*.png) — Task 5b ---------------
  // Same synthetic dataset, 1x scale (README renders these small; 1x keeps
  // the repo size flat). Filename-matched so README.md needs no edit.
  const readmeCtx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  // Hint suppression (same reasoning as the main context above): this is a
  // separate browser context with its own localStorage, so the "seen" flag
  // must be seeded here too.
  await readmeCtx.addInitScript(() => {
    if (window.location.origin !== "null") window.localStorage.setItem("ccfr-glossary-hint-seen", "1");
  });
  const rp = await readmeCtx.newPage();
  await rp.goto(DEMO_URL, { waitUntil: "domcontentloaded" });
  // Returning users land on Cost. Open Sessions explicitly before checking
  // the synthetic dataset and capturing the source-management page.
  await nav(rp, "Sessions");
  await rp.locator("tbody tr").first().waitFor(WAIT);

  const README_DIR = join(REPO_ROOT, "docs", "screenshots");
  mkdirSync(README_DIR, { recursive: true });
  const rshotPage = async (file, pre = 400) => {
    await settle(pre);
    await rp.screenshot({ path: join(README_DIR, file) });
    console.log(`readme shot: ${file}`);
  };
  const rshotEl = async (file, selector, pre = 400, endSelector) => {
    const el = rp.locator(selector).first();
    await el.waitFor(WAIT);
    await el.scrollIntoViewIfNeeded();
    await settle(pre);
    await captureVisibleElement(rp, el, join(README_DIR, file), endSelector ? rp.locator(endSelector).first() : undefined);
    console.log(`readme shot: ${file}`);
  };

  // import.png — Import screen with populated cache totals.
  // exact: true — the page also has an "Import all new" action button whose
  // accessible name would otherwise substring-match the sidebar nav button.
  await nav(rp, "Sources & sync");
  const sourcePath = rp.getByPlaceholder("Path to the Claude Code export root");
  await sourcePath.waitFor(WAIT);
  // fill(), not a raw input.value assignment: this input is React-controlled
  // (value={draft} in frontend/src/pages/ImportPage.tsx), so a direct value
  // write is reverted on the next render and the real local export path ends up
  // in a public screenshot. fill() dispatches the input event React listens for.
  await sourcePath.fill(MASKED_ROOT);
  // fill() leaves the field focused; drop focus so the still shows the resting
  // state rather than a focus ring.
  await sourcePath.blur();
  await settle(600);
  const shownRoot = await sourcePath.inputValue();
  if (!(await sourcePath.isVisible())) {
    throw new Error("Refusing to capture: expected the Import page, got another view.");
  }
  if (shownRoot !== MASKED_ROOT) {
    throw new Error(
      `Refusing to capture: Import source root reads ${JSON.stringify(shownRoot)}, ` +
        "not the masked placeholder. This would publish a real local path.",
    );
  }
  await rp.screenshot({ path: join(README_DIR, "import.png") });
  console.log("readme shot: import.png");

  // triage-board.png — Sessions with the synthetic demo corpus.
  await nav(rp, "Sessions");
  await rp.getByPlaceholder("Search sessions").waitFor(WAIT);
  await rp.locator("tbody tr").first().waitFor(WAIT);
  await rshotPage("triage-board.png", 600);

  // session-workspace.png — first session opened.
  await rp.locator("tbody tr").first().click();
  await rshotEl("session-workspace.png", ".session-workspace", 800);

  // cost-analytics-1.png — Cost dashboard.
  await nav(rp, "Cost");
  await selectAllTime(rp);
  await rshotEl("cost-analytics-1.png", ".cost-bento", 600, ".cost-model-tile");

  // cost-analytics-2.png — turn distribution / outlier tile.
  const rTurnTile = rp
    .locator("section.tile")
    .filter({ has: rp.getByRole("heading", { name: "Turn distribution" }) })
    .first();
  await rTurnTile.waitFor(WAIT);
  await rTurnTile.scrollIntoViewIfNeeded();
  await settle(400);
  await captureVisibleElement(rp, rTurnTile, join(README_DIR, "cost-analytics-2.png"));
  console.log("readme shot: cost-analytics-2.png");

  // subgroup.png — Subgroups on its default, explicitly non-causal view.
  await nav(rp, "Explore");
  await rp.getByRole("button", { name: "Subgroups" }).click();
  await rshotEl("subgroup.png", ".driver-board", 500);

  // context-economics.png — estimated context opportunity and evidence.
  await rp.getByRole("button", { name: "Context economics" }).click();
  await rp.locator(".opportunity-meter-hero").first().waitFor(WAIT);
  await rshotEl("context-economics.png", ".discover-page-inner", 500);

  await readmeCtx.close();

  await context.close();
  await browser.close();
  console.log(`Saved 6 stills to ${SHOTS_DIR}`);
}

await main();
