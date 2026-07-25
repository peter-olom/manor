import { promises as fs } from 'fs';

export default async ({ page, artifacts }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000); // initial load

  // Take a screenshot of the initial state
  await page.screenshot({ path: artifacts.dir + '/01-initial.png', fullPage: true });

  // Find the Worker pane: we'll look for a section with class 'pane' that contains the worker output
  // From the earlier inspection, we saw a SECTION.pane with text containing "Worker"
  const workerPane = await page.$('section.pane');
  if (!workerPane) {
    throw new Error('Could not find Worker pane (section.pane)');
  }

  // Verify it's the right one by checking for worker-related text
  const paneText = await workerPane.evaluate(el => el.textContent);
  if (!paneText.includes('Worker')) {
    throw new Error('The pane found does not seem to be the Worker pane');
  }

  // Scroll the worker pane to the bottom
  await workerPane.evaluate(el => {
    el.scrollTop = el.scrollHeight;
  });

  // Wait a bit for any animations
  await page.waitForTimeout(500);

  // Take a screenshot after scrolling to bottom
  await page.screenshot({ path: artifacts.dir + '/02-scrolled-bottom.png', fullPage: true });

  // Now find the pinned bar: we know it's a button with class 'worker-output-pinned-toggle'
  const pinnedBarBtn = await page.$('button.worker-output-pinned-toggle');
  if (!pinnedBarBtn) {
    throw new Error('Could not find the pinned bar button');
  }

  // Get the bounding box of the button and the pane to verify it's at the bottom
  const btnBox = await pinnedBarBtn.boundingBox();
  const paneBox = await workerPane.boundingBox();

  // The button should be near the bottom of the pane (within 10px)
  const isPinnedAtBottom = Math.abs((btnBox.y + btnBox.height) - (paneBox.y + paneBox.height)) < 10;

  // Check for green dot: look for an element inside the button or nearby that has a green background
  // From the HTML we saw, the button contains a span with class "worker-output-pinned-label"
  // There might be a dot element. Let's look for a span with a dot or a colored circle.
  const hasGreenDot = await pane.evaluate((btn) => {
    // Look for an element that might be the dot: could be a span with a specific class or style
    const dots = btn.querySelectorAll('.dot, .status-dot, [class*="dot"]');
    for (const dot of dots) {
      const color = getComputedStyle(dot).backgroundColor;
      if (color.includes('green') || color.includes('rgb(0, 128, 0)')) {
        return true;
      }
    }
    // Also check if there's an element with a green background that is a child of the button
    const children = btn.children;
    for (const child of children) {
      const color = getComputedStyle(child).backgroundColor;
      if (color.includes('green') || color.includes('rgb(0, 128, 0)')) {
        return true;
      }
    }
    return false;
  }, pinnedBarBtn);

  // Check for chevron icon: look for an SVG or an icon with a class containing chevron
  const hasChevron = await pane.evaluate((btn) => {
    return btn.querySelector('.chevron, .expand-icon, [class*="chevron"], svg') !== null;
  }, pinnedBarBtn);

  // Now click the button to expand the pane
  await pinnedBarBtn.click();
  await page.waitForTimeout(500); // wait for expansion

  // Take a screenshot after expanding
  await page.screenshot({ path: artifacts.dir + '/03-expanded.png', fullPage: true });

  // After expanding, we expect to see a list of outputs with Open/Download buttons
  // Look for a container that appears after the button, maybe a div with class containing 'worker-output-list'
  const expandedList = await page.$('.worker-output-list, .outputs-list, [class*="outputs-list"]');
  const listVisible = expandedList !== null;

  // Check for Open and Download buttons within the expanded area
  const hasOpenButton = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(btn => btn.textContent.trim() === 'Open');
  });

  const hasDownloadButton = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(btn => btn.textContent.trim() === 'Download');
  });

  // Return the results
  return {
    isPinnedAtBottom,
    hasGreenDot,
    hasChevron,
    listVisible,
    hasOpenButton,
    hasDownloadButton
  };
};