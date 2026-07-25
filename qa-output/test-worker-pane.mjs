export default async ({ page, artifacts }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  // Wait for initial load
  await page.waitForTimeout(3000);

  // We need to scroll to the bottom of the Worker pane (right side)
  // Let's assume the Worker pane is the right pane in a split view.
  // We'll try to find panes by a common class or by position.
  // If we can't find, we'll scroll the whole page to bottom and hope the Worker pane is there.
  // But better to be specific.

  // First, let's try to find the Worker pane by looking for a container that has the pinned bar.
  // The pinned bar has text "Task outputs · N available"
  // We'll wait for that bar to be present in the DOM.

  // However, we are to scroll the Worker pane to the bottom first.
  // Let's try to get the Worker pane by: the pane that is on the right.
  // We can use JavaScript to get all divs and find the one that takes the right half.

  // Alternatively, we can rely on the fact that the split view might have a class for panes.
  // Let's inspect the page to see if we can find a selector.

  // Since we cannot inspect interactively, we'll try a few strategies.

  // Strategy 1: Find the element that contains the text "Task outputs ·" and then scroll its parent container to bottom.
  // But the bar is pinned at the bottom of the Worker pane, so the Worker pane is the scroll container.

  // Let's wait for the bar to be present (so we know the Worker pane is loaded).
  const pinnedBarSelector = '.task-outputs-bar'; // guessing
  // We don't know the exact selector, so we'll try to find by text content.

  // We'll use page.evaluate to find an element that contains the text.
  const barHandle = await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll('*'));
    return el => el.textContent && el.textContent.includes('Task outputs ·');
  }, {}); // This waitForFunction will wait until the function returns a truthy value.

  // Actually, waitForFunction can take a predicate and returns the return value.
  // Let's do:
  const barElement = await page.waitForFunction(() => {
    const els = document.querySelectorAll('*');
    for (const el of els) {
      if (el.textContent && el.textContent.includes('Task outputs ·')) {
        return el;
      }
    }
    return null;
  });

  if (!barElement) {
    throw new Error('Could not find the pinned bar with text "Task outputs ·"');
  }

  // Now, we need to scroll the Worker pane to the bottom.
  // The Worker pane is likely a parent container of this bar that is scrollable.
  // Let's traverse up to find a scrollable parent (with overflow auto or scroll).
  const scrollContainer = await page.evaluate((bar) => {
    let el = bar.parentElement;
    while (el) {
      const style = getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
        return el;
      }
      el = el.parentElement;
    }
    // If not found, return the bar's offsetParent or the body?
    return document.body;
  }, barElement);

  // Now scroll the scrollContainer to the bottom.
  await page.evaluate((container) => {
    container.scrollTop = container.scrollHeight;
  }, scrollContainer);

  // Wait a bit for any animations
  await page.waitForTimeout(500);

  // Take screenshot after scrolling to bottom
  await page.screenshot({ path: artifacts.dir + '/worker-pane-bottom.png', fullPage: false });

  // Now verify the bar is visible and pinned at the bottom.
  // We'll check the bar's position relative to the viewport or the scrollContainer.
  // We'll also check for the green dot and chevron.

  // Let's get the bar's bounding box and the scrollContainer's bounding box.
  const barBox = await barElement.boundingBox();
  const containerBox = await page.evaluate((cont) => {
    return cont.getBoundingClientRect();
  }, scrollContainer);

  // The bar should be at the bottom of the container: barBox.bottom should be close to containerBox.bottom.
  // We'll allow a few pixels difference.
  const isPinnedAtBottom = Math.abs(barBox.bottom - containerBox.bottom) < 5;

  // Check for green dot: maybe a class or a child element with a green color.
  // We'll look for an element with a green dot inside the bar.
  const hasGreenDot = await page.evaluate((bar) => {
    const dot = bar.querySelector('.dot, .status-dot, [class*="dot"]');
    if (!dot) return false;
    const color = getComputedStyle(dot).backgroundColor;
    // Check if color is green (rgb(0, 128, 0) or similar)
    return color.includes('rgb(0, 128, 0)') || color.includes('green');
  }, barElement);

  // Check for chevron icon: maybe an SVG or an icon with a specific class.
  const hasChevron = await page.evaluate((bar) => {
    return bar.querySelector('.chevron, .expand-icon, [class*="chevron"]') !== null;
  }, barElement);

  // Now click the bar to expand it.
  await barElement.click();
  await page.waitForTimeout(500); // wait for expansion

  // Take screenshot after expanding
  await page.screenshot({ path: artifacts.dir + '/worker-pane-expanded.png', fullPage: false });

  // Verify the expanded list shows output entries with Open/Download buttons.
  // We'll look for a list that appears after the bar, and check for buttons with text Open or Download.
  const expandedListVisible = await page.waitForFunction(() => {
    const list = document.querySelector('.task-outputs-list, .outputs-list, [class*="outputs-list"]');
    return list && list.offsetParent !== null; // visible
  }, {}); // wait for the list to be visible

  const hasOpenButton = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(btn => btn.textContent.trim() === 'Open');
  });

  const hasDownloadButton = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(btn => btn.textContent.trim() === 'Download');
  });

  // Return an object with the results for the test.
  return {
    isPinnedAtBottom,
    hasGreenDot,
    hasChevron,
    expandedListVisible,
    hasOpenButton,
    hasDownloadButton
  };
};