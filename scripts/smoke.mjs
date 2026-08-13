/**
 * Browser smoke test.
 *
 * Signs in via dev login, creates its own process (so the seeded demo data
 * stays pristine), then exercises what matters: personalising a company's
 * process, adding a challenge, and walking every screen. Captures a screenshot
 * of each.
 *
 * Does not exercise the assistant — that needs a real API key. See
 * scripts/assistant-check.ts for that path.
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
const companyName = `Smoke Co ${stamp}`;

try {
  console.log("1. Login page");
  await go(page, "/login");
  await shot(page, "login");

  console.log("2. Dev login");
  await page.getByRole("button", { name: /you@example\.com/ }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 20000 });
  await expectText(page, "Live processes", "dashboard rendered");
  await shot(page, "dashboard");

  console.log("3. Inbox-detected process surfaces for review");
  await expectText(page, "Picked up from your inbox", "detection strip on the dashboard");
  await page.getByRole("link", { name: /Halcyon Systems/ }).first().click();
  await page.waitForURL(/\/processes\/[^/]+$/, { timeout: 20000 });
  await expectText(page, "Picked this up from your inbox", "detection banner on the process");
  await expectText(page, "Applied", "detected process starts on Applied, not Researching");
  await shot(page, "detected-process");
  await page.getByRole("button", { name: "Looks right" }).click();
  // Confirming clears the banner; the strip on the dashboard goes with it.
  try {
    await page
      .getByText("Picked this up from your inbox")
      .first()
      .waitFor({ state: "detached", timeout: 15000 });
    console.log("  ok: confirming clears the banner");
  } catch {
    problems.push("banner did not clear after confirming the detection");
  }

  console.log("4. Processes list");
  await go(page, "/processes");
  await expectText(page, "Nimbus Data", "processes list rendered");
  await shot(page, "processes");

  console.log("5. Track a new process");
  await page.fill('input[name="companyName"]', companyName);
  await page.fill('input[name="roleTitle"]', "Principal Engineer");
  await page.fill('input[name="companyDomain"]', `smoke-${stamp}.example`);
  await page.selectOption('select[name="templateId"]', { label: "Standard engineering loop" });
  await page.getByRole("button", { name: "Start tracking" }).click();
  await page.waitForURL(/\/processes\/[^/]+$/, { timeout: 20000 });
  await expectText(page, "Their process", "process page rendered");
  await expectText(page, "Standard ·", "new process starts on the standard flow");
  const processUrl = page.url();
  await shot(page, "process-standard");

  console.log("6. Personalise — they added a step");
  await page.fill('input[name="name"]', "Pairing session");
  await page.getByRole("button", { name: "Add step" }).click();
  await expectText(page, "Pairing session", "custom step appears in the tracker");
  await expectText(page, "Diverged from your flow", "process is marked as diverged");
  await shot(page, "process-personalised");

  console.log("7. Personalise — they skipped a step");
  const takeHomeRow = page.locator("li").filter({ hasText: "Take-home" }).first();
  await takeHomeRow.hover();
  await takeHomeRow.locator('button[title="They skipped this step"]').click();
  await expectText(page, 'Skipped "Take-home"', "skip is recorded on the timeline");
  await shot(page, "process-skipped");

  console.log("8. Advance the stage");
  await page.getByRole("button", { name: /^Next stage$/ }).click();
  await expectText(page, "Applied", "advancing moved the stage");
  await shot(page, "process-advanced");

  console.log("9. Record a next action");
  await page.goto(processUrl, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="action"]', `Chase them ${stamp}`);
  await page.getByRole("button", { name: "Save" }).first().click();
  // It renders back into an input's value, so assert the value, not page text.
  try {
    await page
      .locator(`input[name="action"][value="Chase them ${stamp}"]`)
      .first()
      .waitFor({ state: "attached", timeout: 15000 });
    console.log("  ok: next action saved");
  } catch {
    problems.push("next action was not persisted back into the form");
  }

  console.log("10. Add a challenge");
  await page.fill('input[name="title"]', "Smoke take-home");
  await page.fill('textarea[name="brief"]', "Build a small service. Include tests.");
  await page.getByRole("button", { name: "Add challenge" }).click();
  await page.waitForURL(/\/challenges\/[^/]+$/, { timeout: 20000 });
  await expectText(page, "Requirements", "challenge workspace rendered");
  await expectText(page, "The brief", "brief section rendered");
  await shot(page, "challenge");

  console.log("11. Add a requirement and tick it");
  await page.fill('input[name="text"]', "Ship a README");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expectText(page, "Ship a README", "requirement added");
  await page
    .locator("li")
    .filter({ hasText: "Ship a README" })
    .first()
    .locator('button[aria-label="Mark done"]')
    .click();
  await expectText(page, "1/1 must-haves", "requirement counted as done");
  await shot(page, "challenge-progress");

  console.log("12. Remaining screens");
  for (const [path, name, marker] of [
    ["/challenges", "challenges", "Event ingestion service"],
    ["/drafts", "drafts", "has no ability to send"],
    ["/flows", "flows", "Standard engineering loop"],
    ["/automations", "automations", "When a company emails you"],
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
