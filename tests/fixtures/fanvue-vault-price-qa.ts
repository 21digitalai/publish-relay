import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const evidenceDir = '../../../local-operations/publish-relay-16635';
await mkdir(evidenceDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  const page = await browser.newPage({ viewport });
  await page.goto('http://127.0.0.1:43205/fanvue-vault-price.html');
  await page.getByRole('button', { name: 'Vault media prices' }).click();
  await page.getByRole('heading', { name: /Vault media prices/ }).waitFor();
  await page.screenshot({ path: `${evidenceDir}/${viewport.name}-populated.png`, fullPage: true });

  const firstPrice = page.getByLabel('USD price for FoxyAI portrait by the window');
  await firstPrice.fill('3.50');
  await firstPrice.press('Enter');
  await page.getByText('✓ Saved').waitFor();
  await firstPrice.fill('4.25');
  await page.keyboard.press('Escape');
  await page.getByText('Discard unsaved price changes?').waitFor();
  await page.screenshot({
    path: `${evidenceDir}/${viewport.name}-dirty-close.png`,
    fullPage: true,
  });

  const bodyOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (bodyOverflow) throw new Error(`${viewport.name} fixture has horizontal page overflow`);
  if (viewport.name === 'mobile') {
    const saveBox = await page.getByRole('button', { name: 'Save' }).first().boundingBox();
    if (!saveBox || saveBox.height < 44) throw new Error('Mobile Save target is below 44px');
  }
  await page.close();
}

const empty = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await empty.goto('http://127.0.0.1:43205/fanvue-vault-price.html?scenario=vault-empty');
await empty.getByRole('button', { name: 'Vault media prices' }).click();
await empty.getByText('This account has no vault media.').waitFor();
await empty.screenshot({ path: `${evidenceDir}/desktop-vault-empty.png`, fullPage: true });
await browser.close();

console.log(`Fanvue vault price fixture QA passed; evidence: ${evidenceDir}`);
