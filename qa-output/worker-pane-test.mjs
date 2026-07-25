import { promises as fs } from 'fs';

export default async ({ page, artifacts }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000);

  // Initial screenshot
  await page.screenshot({ path: artifacts.dir + '/01-initial.png', fullPage: true });

  // Find the pinned bar button
  const pinnedBtn = await page.$('button.worker-output-pinned-toggle');
  if (!pinnedBtn) {
    throw new Error('Could not find the pinned bar button');
  }

  // Find the scrollable container: traverse up from the button until we find an element with overflow-y: auto or scroll
  const scrollContainer = await pane.evaluate((btn) => {
    let el = btn.parentElement;
    while (el) {
      const style = getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
        return el;
      }
      el = el.parentElement;
    }
    // Fallback: return the document.body
    return document.body;
  }, pinnedBtn);

  // Scroll the container to the bottom
  await pane.evaluate((container) => {
    container.scrollTop = container.scrollHeight;
  }, scrollContainer);

  await page.waitForTimeout(500);

  // Screenshot after scrolling to bottom
  await page.screenshot({ path: artifacts.dir + '/02-scrolled-bottom.png', fullPage: true });

  // Now verify the pinned bar is visible and has the expected features
  // Check if the button is visible
  const isVisible = await pane.evaluate((btn) => {
    const rect = btn.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= viewportHeight &&
      rect.right <= viewportWidth
    );
  }, pinnedBtn);

  // Check for green dot: we assume there is a span or dot inside the button or adjacent
  // From the HTML we saw, the button has text "Task outputs3 available" and there is a span with class "worker-output-pinned-label" that says "Task outputs"
  // The green dot might be a separate element. Let's look for an element with a green background near the button.
  const hasGreenDot = await pane.evaluate(() => {
    // Look for any element with a green background color near the button
    const dots = document.querySelectorAll('.dot, .status-dot, [class*="dot"]');
    for (const dot of dots) {
      const color = getComputedStyle(dot).backgroundColor;
      if (color.includes('rgb(0, 128, 0)') || color.includes('green')) {
        return true;
      }
    }
    return false;
  });

  // Check for chevron: look for an icon with a class containing chevron
  const hasChevron = await pane.evaluate(() => {
    return document.querySelector('.chevron, .expand-icon, [class*="chevron"]') !== null;
  });

  // Click the button to expand
  await pinnedBtn.click();
  await page.waitForTimeout(500);

  // Screenshot after expanding
  await page.screenshot({ path: artifacts.dir + '/03-expanded.png', fullPage: true });

  // Wait for the expanded list to appear
  const listVisible = await pane.waitForFunction(() => {
    const list = document.querySelector('.task-outputs-list, .outputs-list, [class*="outputs-list"]');
    return list && list.offsetParent !== null;
  }, {}); // wait for the element to be visible

  // Check for Open and Download buttons
  const hasOpenButton = await pane.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(btn => btn.textContent.trim() === 'Open');
  });

  const hasDownloadButton = await pane.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(btn => btn.textContent.trim() === 'Download');
  });

  // Return results
  return {
    isVisible,
    hasGreenDot,
    hasChevron,
    listVisible: !!listVisible,
    hasOpenButton,
    hasDownloadButton
  };
};