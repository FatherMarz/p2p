// End-to-end: two Chromium contexts transfer a real file through the full
// stack (mailbox handshake -> WebRTC data channel), then verify the bytes.
// Run with the dev api (:3000) and vite (:5175) already up.
import { chromium } from "playwright";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:5175";
const SIZE = 5 * 1024 * 1024;

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

const dir = mkdtempSync(join(tmpdir(), "p2p-e2e-"));
const srcPath = join(dir, "payload.bin");
const srcBytes = randomBytes(SIZE);
writeFileSync(srcPath, srcBytes);
const srcHash = sha256(srcBytes);

const browser = await chromium.launch();
try {
  // --- Sender picks a file, gets a passphrase -------------------------------
  const senderCtx = await browser.newContext();
  const sender = await senderCtx.newPage();
  await sender.goto(BASE);
  await sender.setInputFiles('[data-testid="file-input"]', srcPath);
  const code = (await sender.locator('[data-testid="passphrase"]').textContent({ timeout: 15000 })).trim();
  console.log("passphrase:", code);
  if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(code)) fail(`unexpected passphrase format: ${code}`);

  // --- Receiver claims it and accepts (forced in-memory path) ---------------
  const receiverCtx = await browser.newContext();
  const receiver = await receiverCtx.newPage();
  await receiver.addInitScript(() => {
    window.__p2pForceMemoryPath = true;
  });
  await receiver.goto(BASE);
  await receiver.click('[data-testid="receive-tile"]');
  await receiver.fill('[data-testid="passphrase-input"]', code);
  await receiver.click('[data-testid="connect-btn"]');
  await receiver.waitForSelector('[data-testid="accept-prompt"]', { timeout: 20000 });
  const gotName = (await receiver.locator('[data-testid="incoming-name"]').textContent()).trim();
  if (gotName !== "payload.bin") fail(`incoming name mismatch: ${gotName}`);

  const [download] = await Promise.all([
    receiver.waitForEvent("download", { timeout: 60000 }),
    receiver.click('[data-testid="accept-btn"]'),
  ]);
  const savedPath = join(dir, "received.bin");
  await download.saveAs(savedPath);
  const gotHash = sha256(readFileSync(savedPath));
  if (gotHash === srcHash) console.log("PASS: 5MB transfer, sha256 match");
  else fail(`hash mismatch: ${gotHash} != ${srcHash}`);

  // --- Both sides report done ------------------------------------------------
  await sender.waitForSelector('[data-testid="transfer-panel"][data-status="done"]', { timeout: 15000 });
  await receiver.waitForSelector('[data-testid="transfer-panel"][data-status="done"]', { timeout: 15000 });
  console.log("PASS: both sides show done");

  // --- The passphrase is one-time: a third party gets rejected --------------
  const thirdCtx = await browser.newContext();
  const third = await thirdCtx.newPage();
  await third.goto(BASE);
  await third.click('[data-testid="receive-tile"]');
  await third.fill('[data-testid="passphrase-input"]', code);
  await third.click('[data-testid="connect-btn"]');
  const claimErr = await third.locator('[data-testid="error-text"]').textContent({ timeout: 10000 });
  if (/already used/i.test(claimErr)) console.log("PASS: second claim rejected");
  else fail(`unexpected claim error: ${claimErr}`);
  await thirdCtx.close();

  // --- Send another file over the same session; receiver declines -----------
  const src2 = join(dir, "second.bin");
  writeFileSync(src2, randomBytes(64 * 1024));
  await sender.setInputFiles('[data-testid="file-input-again"]', src2);
  await receiver.waitForSelector('[data-testid="accept-prompt"]', { timeout: 15000 });
  await receiver.click('text=Decline');
  await sender.waitForSelector('[data-testid="transfer-panel"][data-status="declined"]', { timeout: 15000 });
  console.log("PASS: decline propagates to sender");

  await receiverCtx.close();
  await senderCtx.close();
} finally {
  await browser.close();
}
console.log(process.exitCode ? "E2E FAILED" : "E2E OK");
