// Lifecycle check: the passphrase dies when the sender leaves. Also grabs
// UI screenshots for a visual pass.
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const BASE = process.env.E2E_BASE ?? "http://localhost:5175";
const SHOTS = process.env.SHOTS_DIR ?? tmpdir();

const dir = mkdtempSync(join(tmpdir(), "p2p-life-"));
const srcPath = join(dir, "doc.pdf");
writeFileSync(srcPath, randomBytes(512 * 1024));

const browser = await chromium.launch();
try {
  const senderCtx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const sender = await senderCtx.newPage();
  await sender.goto(BASE);
  await sender.screenshot({ path: join(SHOTS, "p2p-landing.png") });

  await sender.setInputFiles('[data-testid="file-input"]', srcPath);
  const code = (await sender.locator('[data-testid="passphrase"]').textContent({ timeout: 15000 })).trim();
  await sender.screenshot({ path: join(SHOTS, "p2p-waiting.png") });

  // Sender walks away (pagehide fires the room-close beacon).
  await sender.goto("about:blank");
  await sender.waitForTimeout(500);

  const rxCtx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const rx = await rxCtx.newPage();
  await rx.goto(BASE);
  await rx.click('[data-testid="receive-tile"]');
  await rx.screenshot({ path: join(SHOTS, "p2p-receive.png") });
  await rx.fill('[data-testid="passphrase-input"]', code);
  await rx.click('[data-testid="connect-btn"]');
  const err = await rx.locator('[data-testid="error-text"]').textContent({ timeout: 10000 });
  if (/isn't live/i.test(err)) console.log("PASS: sender left, code is dead");
  else {
    console.error(`FAIL: expected dead-code error, got: ${err}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
console.log(process.exitCode ? "LIFECYCLE FAILED" : "LIFECYCLE OK");
