// scripts/capture-audit.mjs
// Design-audit capture (P13): screenshots every Wave-1-touched screen AND the
// reference screens, in BOTH themes, so they can be judged side by side against
// ship-kit/DESIGN-LANGUAGE.md. Full-viewport shots (1440x900) — the crop is the
// page as a user sees it, which is what the visual gate judges.
// Output: ../docs/media/audit/<name>.<theme>.png (scratch dir, git-ignored).
// Prereqs: backend on an EMPTY import root + temp DB (demo card visible or demo
// already loaded), frontend dev server. Override target with DEMO_URL.
//
// Wave-1 screen map (derived from `git diff --name-only main...ship/integration`):
//   usage-drivers     Explore > Usage drivers            (P09 UsageDrivers.tsx + UsageCharacteristicsPanel.tsx)
//   uc-dialog         Explore > Usage Mindmap > "Usage drivers" button (P09 UsageCharacteristicsDialog.tsx)
//   context           Explore > Context economics        (P08 TaxMeterHero.tsx; also a REFERENCE screen)
//   context-drilldown Context economics with a finding open (P08 SessionDrilldown.tsx)
//   cost              Cost                               (P08 InsightStrip.tsx; also a REFERENCE screen)
//   session           Overview > first session           (P08 InsightStrip via SessionInsightStrip)
//   import            Import                             (P03 demo card / P07 import root)
//   team-export       Export                             (P05 removed privacy rungs)
//   subgroups         Explore > Subgroups                (REFERENCE only — never edited)
// The Explore technique rail (P05 techniques.tsx) is visible in every Explore shot.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const AUDIT_DIR = join(REPO_ROOT, "docs", "media", "audit");
const DEMO_URL = process.env.DEMO_URL ?? "http://localhost:5174";
const VIEWPORT = { width: 1440, height: 900 };
const WAIT = { state: "visible", timeout: 60_000 };

// Brief settle for transition/physics-driven views only; every screen is first
// awaited on a visible element (condition-based), never on the sleep alone.
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Sidebar navigation, scoped to .sb-nav so page-body buttons with the same
// accessible name ("Export PNG", "Import all new", …) never collide.
const nav = (page, label) =>
  page.locator("nav.sb-nav").getByRole("button", { name: label, exact: true }).click();

// Each screen: navigate from a known state (go), wait for real content (ready),
// optional extra settle for animations.
const SCREENS = [
  {
    name: "subgroups",
    go: async (page) => {
      await nav(page, "Explore");
      await page.getByRole("button", { name: "Subgroups" }).click();
    },
    ready: ".driver-board",
  },
  {
    name: "context",
    go: async (page) => {
      await nav(page, "Explore");
      await page.getByRole("button", { name: "Context economics" }).click();
    },
    ready: ".tax-meter-hero",
    pre: 500,
  },
  {
    name: "context-drilldown",
    go: async (page) => {
      // Already on Context economics; open the first finding so the P08
      // SessionDrilldown panel renders. Both steps tolerate an auto-selected
      // state (clicking the already-active item is a no-op).
      const finding = page.locator(".context-side button, .context-side [role='button'], .context-side li").first();
      if (await finding.isVisible().catch(() => false)) await finding.click();
    },
    ready: ".archetype-detail",
    pre: 400,
  },
  {
    name: "cost",
    go: async (page) => {
      await nav(page, "Cost");
    },
    ready: ".cost-bento",
    pre: 600,
  },
  {
    name: "usage-drivers",
    go: async (page) => {
      await nav(page, "Explore");
      await page.getByRole("button", { name: "Usage drivers" }).click();
    },
    ready: ".usage-drivers-body .uc-row",
    pre: 400,
  },
  {
    name: "uc-dialog",
    go: async (page) => {
      await nav(page, "Explore");
      await page.getByRole("button", { name: "Usage Mindmap" }).click();
      await page.locator(".mindmap-stage").waitFor(WAIT);
      // The mindmap-toolbar button that opens the characteristics dialog —
      // scoped to .ghost-action to avoid the Explore rail's technique button
      // of the same name.
      await page.locator("button.ghost-action", { hasText: "Usage drivers" }).click();
    },
    ready: ".uc-body .uc-row",
    pre: 400,
    // Close the (native <dialog>) so it doesn't block the next screen's
    // navigation. Escape triggers its onClose; wait until it's really gone.
    after: async (page) => {
      await page.keyboard.press("Escape");
      await page.locator(".uc-body .uc-row").first().waitFor({ state: "hidden", timeout: 10_000 });
    },
  },
  {
    name: "session",
    go: async (page) => {
      await nav(page, "Overview");
      await page.locator("tbody tr").first().waitFor(WAIT);
      await page.locator("tbody tr").first().click();
    },
    ready: ".session-workspace",
    pre: 600,
  },
  {
    name: "import",
    go: async (page) => {
      await nav(page, "Import");
    },
    ready: "input[placeholder='Path to the Claude Code export root']",
    pre: 400,
  },
  {
    name: "team-export",
    go: async (page) => {
      await nav(page, "Export");
    },
    ready: ".team-export-page .card",
    pre: 400,
  },
];

async function ensureDemoLoaded(page) {
  const loadDemo = page.getByRole("button", { name: /load demo/i });
  if (await loadDemo.isVisible().catch(() => false)) {
    await loadDemo.click();
    await page.getByRole("button", { name: "Overview" }).click();
    await page.getByPlaceholder("Search sessions").waitFor(WAIT);
    await page.locator("tbody tr").first().waitFor(WAIT);
  }
}

async function captureTheme(browser, theme) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.addInitScript(
    ([t]) => {
      // Deterministic theme (frontend/src/theme/useTheme.ts, key "ccfr-theme")
      // and first-run glossary coachmark suppression (same reasoning as
      // capture-shots.mjs) — both read before any app script runs.
      window.localStorage.setItem("ccfr-theme", t);
      window.localStorage.setItem("ccfr-glossary-hint-seen", "1");
    },
    [theme],
  );
  const page = await context.newPage();
  await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });
  await ensureDemoLoaded(page);

  for (const screen of SCREENS) {
    try {
      await screen.go(page);
      await page.locator(screen.ready).first().waitFor(WAIT);
      await settle(screen.pre ?? 300);
      const file = `${screen.name}.${theme}.png`;
      await page.screenshot({ path: join(AUDIT_DIR, file) });
      console.log(`shot: ${file}`);
      if (screen.after) await screen.after(page);
    } catch (err) {
      console.error(`FAILED: ${screen.name}.${theme} — ${String(err).split("\n")[0]}`);
      process.exitCode = 1;
    }
  }
  await context.close();
}

async function main() {
  mkdirSync(AUDIT_DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const theme of ["dark", "light"]) {
    await captureTheme(browser, theme);
  }
  await browser.close();
  console.log(`Audit shots saved to ${AUDIT_DIR}`);
}

await main();
