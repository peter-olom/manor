export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  // Initial screenshot
  await page.screenshot({ path: artifacts.dir + '/00-initial.png', fullPage: true });

  // Find the worker pane
  const pane = await page.$('section.pane');
  if (!pane) {
    throw new Error('Worker pane not found');
  }

  const pinnedBar = await pane.$('div.worker-output-pinned');
  if (!pinnedBar) {
    throw new Error('Pinned bar not found');
  }

  // Get bounding boxes for the pinned bar and the pane
  const barBox = await pinnedBar.boundingBox();
  const paneBox = await pane.boundingBox();

  // Check if the bar is at the bottom of the pane (within 5px)
  const isAtBottom = Math.abs((barBox.y + barBox.height) - (paneBox.y + paneBox.height)) < 5;

  // Screenshot before clicking
  await page.screenshot({ path: artifacts.dir + '/01-before-click.png', fullPage: true });

  // Click the button inside the bar (the button is a direct child)
  const toggleBtn = await pinnedBar.$('button.worker-output-pinned-toggle');
  if (!toggleBtn) {
    throw new Error('Toggle button not found inside the bar');
  }
  await toggleBtn.click();
  await page.waitForTimeout(500);

  // Screenshot after clicking
  await page.screenshot({ path: artifacts.dir + '/02-after-click.png', fullPage: true });

  // Check if the list of outputs is now visible
  const listVisible = await pane.evaluate(() => {
    const list = document.querySelector('.worker-output-summary-list, .outputs-list, [class*="outputs-list"]');
    if (!list) return false;
    const rect = list.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  // Check for Open and Download buttons
  const hasOpen = await pane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => btn.textContent.trim() === 'Open');
  });

  const hasDownload = await pane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => btn.textContent.trim() === 'Download');
  });

  return {
    isAtBottom,
    listVisible,
    hasOpen,
    hasDownload
  };
};