export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  // Take initial screenshot
  await page.screenshot({ path: artifacts.dir + '/01-before-scroll.png', fullPage: true });

  // Scroll to the bottom of the Worker pane
  // First, find the Worker pane: we'll look for the right pane by position
  const workerPane = await page.evaluateHandle(() => {
    const all = document.querySelectorAll('*');
    let best = null;
    let maxArea = 0;
    const midX = window.innerWidth / 2;
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) continue;
      if (rect.left > midX) {
        const area = rect.width * rect.height;
        if (area > maxArea) {
          maxArea = area;
          best = el;
        }
      }
    }
    return best;
  });

  if (!workerPane) {
    throw new Error('Could not find the Worker pane');
  }

  // Scroll the worker pane to the bottom
  await page.evaluate((pane) => {
    pane.scrollTop = pane.scrollHeight;
  }, workerPane);

  await page.waitForTimeout(500);

  // Screenshot after scrolling
  await page.screenshot({ path: artifacts.dir + '/02-after-scroll.png', fullPage: true });

  // Find the pinned bar button inside the worker pane
  const pinnedBarBtn = await workerPane.$('button.worker-output-pinned-toggle');
  if (!pinnedBarBtn) {
    throw new Error('Could not find the pinned bar button');
  }

  // Get bounding boxes
  const btnBox = await pinnedBarBtn.boundingBox();
  const paneBox = await workerPane.boundingBox();

  // Check if the button is pinned at the bottom (within 5px)
  const isPinnedAtBottom = Math.abs((btnBox.y + btnBox.height) - (paneBox.y + paneBox.height)) < 5;

  // Check for green dot: look for a child element with a green background
  const hasGreenDot = await paneBadge.evaluate((btn) => {
    const children = Array.from(btn.children);
    for (const child of children) {
      const bg = getComputedStyle(child).backgroundColor;
      if (bg.includes('green') || bg.includes('rgb(0, 128, 0)')) {
        return true;
      }
    }
    return false;
  }, pinnedBarBtn);

  // Check for chevron icon: look for an SVG or element with chevron in class
  const hasChevron = await paneBadge.evaluate((btn) => {
    return btn.querySelector('.chevron, .expand-icon, [class*="chevron"], svg') !== null;
  }, pinnedBarBtn);

  // Click the button to expand
  await pinnedBarBtn.click();
  await page.waitForTimeout(500);

  // Screenshot after expanding
  await page.screenshot({ path: artifacts.dir + '/03-expanded.png', fullPage: true });

  // After expansion, look for the list of outputs
  const expandedList = await workerPane.$('.worker-output-list, .outputs-list, [class*="outputs-list"]');
  const listVisible = expandedList !== null;

  // Check for Open and Download buttons in the worker pane
  const hasOpenButton = await workerPane.evaluate((pane) => {
    const btns = Array.from(pane.querySelectorAll('button'));
    return btns.some(btn => btn.textContent.trim() === 'Open');
  });

  const hasDownloadButton = await workerPane.evaluate((pane) => {
    const btns = Array.from(pane.querySelectorAll('button'));
    return btns.some(btn => btn.textContent.trim() === 'Download');
  });

  // Return results
  return {
    isPinnedAtBottom,
    hasGreenDot,
    hasChevron,
    listVisible,
    hasOpenButton,
    hasDownloadButton
  };
};