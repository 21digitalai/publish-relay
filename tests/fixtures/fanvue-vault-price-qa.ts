import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const evidenceDir = process.env.PUBLISH_RELAY_QA_EVIDENCE_DIR ?? 'test-results/fanvue-vault-price';
await mkdir(evidenceDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const openScenario = async (
  scenario: string,
  viewport: { name: string; width: number; height: number },
) => {
  const page = await browser.newPage({ viewport });
  await page.goto(
    `http://127.0.0.1:43205/fanvue-vault-price.html?scenario=${encodeURIComponent(scenario)}`,
  );
  await page.getByRole('button', { name: 'Vault media prices' }).click();
  return page;
};

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  const page = await openScenario('populated', viewport);
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

  const loading = await openScenario('loading', viewport);
  await loading.getByLabel('Loading vault media').waitFor();
  await loading.screenshot({
    path: `${evidenceDir}/${viewport.name}-loading.png`,
    fullPage: true,
  });
  await loading.close();

  const folderEmpty = await openScenario('folder-empty', viewport);
  await folderEmpty.getByLabel('Vault folder').click();
  await folderEmpty.getByRole('option', { name: 'Paid DMs' }).click();
  await folderEmpty.getByText('No media in this folder.').waitFor();
  await folderEmpty.screenshot({
    path: `${evidenceDir}/${viewport.name}-folder-empty.png`,
    fullPage: true,
  });
  await folderEmpty.close();

  const saving = await openScenario('populated', viewport);
  const savingPrice = saving.getByLabel('USD price for FoxyAI portrait by the window');
  await savingPrice.fill('3.50');
  await saving.getByRole('button', { name: 'Save' }).first().click();
  await saving.getByRole('button', { name: 'Saving…' }).waitFor();
  await saving.screenshot({
    path: `${evidenceDir}/${viewport.name}-saving.png`,
    fullPage: true,
  });
  await saving.close();

  const validation = await openScenario('populated', viewport);
  const invalidPrice = validation.getByLabel('USD price for FoxyAI portrait by the window');
  await invalidPrice.fill('0');
  await validation.getByRole('button', { name: 'Save' }).first().click();
  await validation.getByText(/Enter a positive USD amount/).waitFor();
  await validation.screenshot({
    path: `${evidenceDir}/${viewport.name}-validation-error.png`,
    fullPage: true,
  });
  await validation.close();

  const saveError = await openScenario('save-error', viewport);
  const errorPrice = saveError.getByLabel('USD price for FoxyAI portrait by the window');
  await errorPrice.fill('3.50');
  await saveError.getByRole('button', { name: 'Save' }).first().click();
  await saveError.getByText('Price was not saved. Retry.').waitFor();
  await saveError.screenshot({
    path: `${evidenceDir}/${viewport.name}-save-error.png`,
    fullPage: true,
  });
  await saveError.close();

  const appendError = await openScenario('append-error', viewport);
  await appendError.getByRole('button', { name: 'Load more' }).click();
  await appendError.getByText('More media could not be loaded.').waitFor();
  await appendError.screenshot({
    path: `${evidenceDir}/${viewport.name}-append-error.png`,
    fullPage: true,
  });
  await appendError.close();

  const previewRecovery = await openScenario('preview-error', viewport);
  await previewRecovery.getByRole('button', { name: 'Refresh preview' }).waitFor();
  await previewRecovery.getByRole('button', { name: 'Refresh preview' }).click();
  await previewRecovery
    .getByRole('img', { name: 'Preview of FoxyAI portrait by the window' })
    .waitFor();
  await previewRecovery.screenshot({
    path: `${evidenceDir}/${viewport.name}-preview-recovered.png`,
    fullPage: true,
  });
  await previewRecovery.close();
}

const empty = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await empty.goto('http://127.0.0.1:43205/fanvue-vault-price.html?scenario=vault-empty');
await empty.getByRole('button', { name: 'Vault media prices' }).click();
await empty.getByText('This account has no vault media.').waitFor();
await empty.screenshot({ path: `${evidenceDir}/desktop-vault-empty.png`, fullPage: true });
await empty.close();

const filterDirty = await openScenario('folder-empty', {
  name: 'desktop',
  width: 1440,
  height: 900,
});
const dirtyPrice = filterDirty.getByLabel('USD price for FoxyAI portrait by the window');
await dirtyPrice.fill('8.50');
await filterDirty.getByLabel('Vault folder').click();
await filterDirty.getByRole('option', { name: 'Paid DMs' }).click();
await filterDirty.getByText('No media in this folder.').waitFor();
await filterDirty.keyboard.press('Escape');
await filterDirty.getByText('Discard unsaved price changes?').waitFor();
await filterDirty.close();

const accountSwitch = await openScenario('account-switch', {
  name: 'desktop',
  width: 1440,
  height: 900,
});
const accountPrice = accountSwitch.getByLabel('USD price for FoxyAI portrait by the window');
await accountPrice.fill('6.50');
await accountSwitch.getByRole('button', { name: 'Save' }).first().click();
await accountSwitch.getByRole('heading', { name: /Account B/ }).waitFor();
await accountSwitch.waitForTimeout(800);
if (await accountSwitch.getByText('✓ Saved').count())
  throw new Error('Stale account A save updated account B dialog');
await accountSwitch.close();
await browser.close();

console.log(`Fanvue vault price fixture QA passed; evidence: ${evidenceDir}`);
