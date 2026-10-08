// The whole TV flow twice: once with the remote (keyboard only), once with a pointer (mouse only).
import { expect, test, type Page } from '@playwright/test';

const MOVIE = 'Long Feature (2015)'; // 90 s HEVC: forces the HLS path and gives room to seek

async function currentPin(page: Page): Promise<string> {
  const res = await page.request.get('/admin/api/status');
  return ((await res.json()) as { pin: string }).pin;
}

const focusedTitle = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector('.focused .title')?.textContent ?? document.querySelector('.focused')?.textContent ?? '');

const playerTime = async (page: Page): Promise<number> => Number((await page.locator('.player').getAttribute('data-time')) ?? '0');

/** Snake through the grid with arrow keys until the focused tile has this title. */
async function arrowTo(page: Page, title: string): Promise<void> {
  let dir: 'ArrowRight' | 'ArrowLeft' = 'ArrowRight';
  for (let i = 0; i < 80; i++) {
    if ((await focusedTitle(page)).trim() === title) return;
    const before = await page.evaluate(() => document.querySelector('.focused')?.getAttribute('data-id'));
    await page.keyboard.press(dir);
    const after = await page.evaluate(() => document.querySelector('.focused')?.getAttribute('data-id'));
    if (before === after) {
      await page.keyboard.press('ArrowDown');
      dir = dir === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
    }
  }
  throw new Error(`could not reach "${title}" with the arrow keys; focused: ${await focusedTitle(page)}`);
}

test('remote only: pair, browse, play, seek, back, resume', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.pin')).toBeVisible();
  for (const d of await currentPin(page)) await page.keyboard.press(d);

  await page.locator('.screen[data-ready] .tile').first().waitFor();
  await page.keyboard.press('ArrowDown'); // Recently Added row -> Folders grid
  await arrowTo(page, '.fixtures');
  await page.keyboard.press('Enter');
  await expect(page.locator('.crumbs')).toContainText('.fixtures');
  await page.locator('.screen[data-ready]').waitFor();
  await arrowTo(page, 'Long');
  await page.keyboard.press('Enter');
  await expect(page.locator('.crumbs')).toContainText('Long');
  await page.locator('.screen[data-ready]').waitFor();
  await arrowTo(page, MOVIE);
  await page.keyboard.press('Enter');

  await expect(page.locator('.player video')).toBeVisible();
  await expect.poll(() => playerTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);

  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight'); // +40 s
  await expect.poll(() => playerTime(page), { timeout: 30_000 }).toBeGreaterThan(38);

  await page.keyboard.press('Escape');
  await expect(page.locator('.player')).toHaveCount(0);
  await page.locator('.screen[data-ready]').waitFor();
  expect((await focusedTitle(page)).trim()).toBe(MOVIE); // focus returns to the tile we left

  for (const crumbs of ['HomeCast › .fixtures', 'HomeCast']) {
    await page.keyboard.press('Escape');
    await expect(page.locator('.crumbs')).toHaveText(crumbs);
    await page.locator('.screen[data-ready]').waitFor();
  }
  await expect(page.locator('h2').first()).toHaveText('Continue Watching');
  await page.locator('.screen[data-ready]').waitFor();
  // Focus comes back on the folder we left; climb to the first row and its first tile.
  for (let i = 0; i < 4 && (await focusedTitle(page)).trim() !== MOVIE; i++) await page.keyboard.press('ArrowUp');
  expect((await focusedTitle(page)).trim()).toBe(MOVIE);
  await page.keyboard.press('Enter');
  await expect.poll(() => playerTime(page), { timeout: 30_000 }).toBeGreaterThan(36); // resumed, not from 0
  await page.keyboard.press('Backspace');
  await expect(page.locator('.player')).toHaveCount(0);
});

test('mouse only: hover, click a tile, click-to-seek, click Back', async ({ page }) => {
  await page.goto('/');
  for (const d of await currentPin(page)) await page.locator('.keypad .key', { hasText: new RegExp(`^${d}$`) }).click();

  const folders = page.locator('.grid .tile');
  await folders.first().hover();
  await expect(folders.first()).toHaveClass(/focused/); // hover = focus
  await page.locator('.tile:has(.title:text-is(".fixtures"))').click();
  await page.locator('.tile:has(.title:text-is("Long"))').click();
  await page.locator(`.tile:has(.title:text-is("${MOVIE}"))`).click();
  await expect.poll(() => playerTime(page), { timeout: 30_000 }).toBeGreaterThan(0.5);

  await page.mouse.move(400, 400);
  const bar = page.locator('.progress');
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2); // 60% of 90 s
  await expect.poll(() => playerTime(page), { timeout: 30_000 }).toBeGreaterThan(50);

  await page.mouse.move(500, 500);
  await page.locator('.player .btn', { hasText: '← Back' }).click();
  await expect(page.locator('.player')).toHaveCount(0);
  await page.locator('.topbar .back').click();
  await expect(page.locator('.crumbs')).toHaveText('HomeCast › .fixtures');
});

test('cursor hides after 3 s idle and returns on move', async ({ page }) => {
  await page.goto('/');
  await page.mouse.move(200, 200);
  await expect(page.locator('body')).not.toHaveClass(/idle/);
  await expect(page.locator('body')).toHaveClass(/idle/, { timeout: 5000 });
  await page.mouse.move(300, 300);
  await expect(page.locator('body')).not.toHaveClass(/idle/);
});
