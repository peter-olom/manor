export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  // Initial screenshot
  await page.screenshot({ path: artifacts.dir + '/00-initial.png', fullPage: true });

  // 1. Find the worker pane
  const workerPane = await page.$('section.pane[aria-label*="Worker"]');
  if (!workerPane) {
    throw new Error('Worker pane not found');
  }

  // 2. Find the pinned bar
  const pinnedBar = await workerPane.$('div[class*="worker-output-pinned"]');
  if (!pinnedBar) {
    throw new Error('Pinned bar not found');
  }

  // 3. Get bounding boxes
  const barBox = await pinnedBar.boundingBox();
  const paneBox = await workerPane.boundingBox();

  // 4. Check if the bar is near the bottom (within 20 pixels)
  const bottomDiff = Math.abs((barBox.y + barBox.height) - (paneBox.y + paneBox.height));
  const isAtBottom = bottomDiff <= 20; // tolerance of 20 pixels

  // 5. Check for green dot
  const hasGreenDot = await workerPane.evaluate((bar) => {
    const dot = bar.querySelector('span.worker-output-pinned-dot');
    if (!dot) return false;
    const style = getComputedStyle(dot);
    const bgColor = style.backgroundColor;
    // Check for green color variations
    return bgColor && (bgColor.includes('green') || 
                       bgColor.includes('rgb(0, 128, 0)') || 
                       bgColor.includes('rgb(0,100,0)') ||
                       bgColor.includes('hsl(120,') || // hue 120 is green
                       bgColor.includes('#008000') ||
                       bgColor.includes('#006400'));
  }, pinnedBar);

  // 6. Check for chevron
  const hasChevron = await workerPane.evaluate((bar) => {
    return bar.querySelector('span.worker-output-pinned-chevron svg') !== null;
  }, pinnedBar);

  // 7. Screenshot before clicking
  await page.screenshot({ path: artifacts.dir + '/01-before-click.png', fullPage: true });

  // 8. Click the button inside the bar
  const toggleBtn = await pinnedBar.$('button.worker-output-pinned-toggle');
  if (!toggleBtn) {
    throw new Error('Toggle button not found');
  }
  await toggleBtn.click();
  await page.waitForTimeout(500);

  // 9. Screenshot after clicking
  await page.screenshot({ path: artifacts.dir + '/02-after-click.png', fullPage: true });

  // 10. Check if the list of outputs is now visible
  const listVisible = await workerPane.evaluate(() => {
    // Look for the list that appears after expanding
    const list = document.querySelector('.worker-output-summary-list');
    if (!list) return false;
    const rect = list.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0;
  });

  // 11. Check for Open and Download buttons (within the worker pane)
  const hasOpen = await workerPane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => {
      const text = btn.textContent.trim();
      return text === 'Open';
    });
  });

  const hasDownload = await workerPane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => {
      const text = btn.textContent.trim();
      return text === 'Download';
    });
  });

  // Return results
  return {
    isAtBottom,
    bottomDiff,
    hasGreenDot,
    hasChevron,
    listVisible,
    hasOpen,
    hasDownload
  };
};