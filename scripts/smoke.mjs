/**
 * Browser smoke test.
 *
 * Signs in via dev login, creates its own candidate (so the seeded demo data
 * stays pristine), then exercises the flows that matter: personalising a
 * candidate's process, advancing a stage, and adding a note. Captures a
 * screenshot of every screen.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SHOTS = process.env.SMOKE_SHOT_DIR ?? "/tmp/rec-e2e-shots";
const CHROME =
  process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

mkdirSync(SHOTS, { recursive: true });

const problems = [];
let step = 0;

async function shot(page, name) {
  step++;
  await page.screenshot({
    path: `${SHOTS}/${String(step).padStart(2, "0")}-${name}.png`,
    fullPage: true,
  });
  console.log(`  captured ${name}`);
}

async function go(page, path) {
  const response = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  const status = response?.status() ?? 0;
  if (status >= 400) problems.push(`${path} returned HTTP ${status}`);
}

/**
 * Server actions re-render through an RSC round trip, so "networkidle" can fire
 * before the new markup is committed. Always wait for the expected text.
 */
async function expectText(page, text, label) {
  try {
    await page.getByText(text).first().waitFor({ state: "visible", timeout: 15000 });
    console.log(`  ok: ${label}`);
    return true;
  } catch {
    problems.push(`${label} — never showed "${text}"`);
    return false;
  }
}

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
});
page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));

const stamp = Date.now();
const candidateName = `Smoke Tester ${stamp}`;

try {
  console.log("1. Login page");
  await go(page, "/login");
  await shot(page, "login");

  console.log("2. Dev login");
  await page.getByRole("button", { name: /Alex Rivera/ }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 20000 });
  await expectText(page, "Open roles", "dashboard rendered");
  await shot(page, "dashboard");

  console.log("3. Jobs list");
  await go(page, "/jobs");
  await expectText(page, "Senior Backend Engineer", "jobs list rendered");
  await shot(page, "jobs");

  console.log("4. Job board");
  await page.getByRole("link", { name: /Senior Backend Engineer/ }).first().click();
  await expectText(page, "Add a candidate", "job board rendered");
  await shot(page, "job-board");

  console.log("5. Add a candidate");
  await page.fill('input[name="fullName"]', candidateName);
  await page.fill('input[name="email"]', `smoke-${stamp}@example.com`);
  await page.fill('input[name="headline"]', "Created by the smoke test");
  await page.getByRole("button", { name: "Add to pipeline" }).click();
  await page.waitForURL(/\/applications\//, { timeout: 20000 });
  await expectText(page, "Hiring flow", "application page rendered");
  await expectText(page, "Standard ·", "new application starts on the standard flow");
  const applicationUrl = page.url();
  await shot(page, "application-standard");

  console.log("6. Personalise — add a custom step");
  await page.fill('input[name="name"]', "Architecture Deep Dive");
  await page.getByRole("button", { name: "Add step" }).click();
  await expectText(page, "Architecture Deep Dive", "custom stage appears in the tracker");
  await expectText(page, "Personalised", "application is marked personalised");
  await shot(page, "application-personalised");

  console.log("7. Personalise — skip a stage");
  const assessmentRow = page
    .locator("li")
    .filter({ hasText: "Take-home Assessment" })
    .first();
  await assessmentRow.hover();
  await assessmentRow.locator('button[title="Skip for this candidate"]').click();
  await expectText(page, 'Skipped stage "Take-home Assessment"', "skip is recorded on the timeline");
  await shot(page, "application-skipped");

  console.log("8. Advance the stage");
  await page.getByRole("button", { name: /^Advance$/ }).click();
  await expectText(page, "Moved from", "advancing recorded a transition");
  await shot(page, "application-advanced");

  console.log("9. Add a note");
  await page.goto(applicationUrl, { waitUntil: "domcontentloaded" });
  await page.fill('textarea[name="body"]', `Smoke note ${stamp}`);
  await page.getByRole("button", { name: "Add note" }).click();
  await expectText(page, `Smoke note ${stamp}`, "note appears");

  console.log("10. Remaining screens");
  for (const [path, name, marker] of [
    ["/candidates", "candidates", candidateName],
    ["/pipelines", "pipelines", "Standard Engineering Hire"],
    ["/automations", "automations", "When an event is booked"],
    ["/integrations", "integrations", "Google Workspace"],
  ]) {
    await go(page, path);
    await expectText(page, marker, `${name} rendered`);
    await shot(page, name);
  }
} catch (err) {
  problems.push(`threw: ${err.message}`);
} finally {
  await browser.close();
}

console.log(`\nScreenshots in ${SHOTS}`);
if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log("\nSmoke test passed.");
