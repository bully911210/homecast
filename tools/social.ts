// Renders docs/media/social-preview.png (1280x640) for the GitHub social preview. Needs Google Chrome.
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.goto(pathToFileURL(resolve('tools', 'social.html')).href);
await page.waitForLoadState('networkidle');
await page.screenshot({ path: resolve('docs', 'media', 'social-preview.png') });
await browser.close();
