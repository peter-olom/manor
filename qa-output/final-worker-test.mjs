export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  // Initial screenshot
  await page.screenshot({ path: artifacts.dir + '/00-initial.png', fullPage: true });

  // 1. Find the worker pane: section with class 'pane' and aria-label containing 'Worker'
  const workerPane = await page.$('section.pane[aria-label*="Worker"]');
  if (!workerPane) {
    throw new Error('Worker pane not found');
  }

  // 2. Inside the worker pane, find the pinned bar div
  const pinnedBar = await workerPane.$('div[class*="worker-output-pinned"]');
  if (!pinnedBar) {
    throw new Error('Pinned bar not found');
  }

  // 3. Get bounding boxes
  const barBox = await pinnedBar.boundingBox();
  const paneBox = await workerPane.boundingBox();
  if (!barBox || !paneBox) {
    throw new Error('Could not get bounding boxes');
  }

  // Check if the bar is at the bottom of the pane (within 5 pixels)
  const isAtBottom = Math.abs((barBox.y + barBox.height) - (paneBox.y + paneBox.height)) < 5;

  // 4. Screenshot before clicking
  await page.screenshot({ path: artifacts.dir + '/01-before-click.png', fullPage: true });

  // 5. Click the toggle button inside the bar
  const toggleBtn = await pinnedBar.$('button.worker-output-pinned-toggle');
  if (!toggleBtn) {
    throw new Error('Toggle button not found');
  }
  await toggleBtn.click();
  await page.waitForTimeout(500); // wait for animation

  // 6. Screenshot after clicking
  await page.screenshot({ path: artifacts.dir + '/02-after-click.png', fullPage: true });

  // 7. Check if the list of outputs is now visible
  // After clicking, we expect to see the worker-output-summary-list or similar
  const listVisible = await workerPane.evaluate(() => {
    const list = document.querySelector('.worker-output-summary-list, .outputs-list, [class*="outputs-list"]');
    if (!list) return false;
    const rect = list.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  // 8. Check for Open and Download buttons (within the worker pane)
  const hasOpen = await workerPane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => btn.textContent.trim() === 'Open');
  });

  const hasDownload = await workerPane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => btn.textContent.trim() === 'Download');
  });

  // Return results
  return {
    isAtBottom,
    listVisible,
    hasOpen,
    hasDownload
  };
};