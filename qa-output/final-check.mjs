export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  // Take initial screenshot
  await page.screenshot({ path: artifacts.dir + '/00-initial.png', fullPage: true });

  // Find the worker pane
  const pane = await page.$('section.pane');
  if (!pane) {
    throw new Error('Worker pane not found');
  }

  // Find the toggle button inside the pane
  const toggleBtn = await pane.$('button.worker-output-pinned-toggle');
  if (!toggleBtn) {
    throw new Error('Toggle button not found');
  }

  // Get bounding boxes
  const btnBox = await toggleBtn.boundingBox();
  const paneBox = await pane.boundingBox();

  // Check if the button is at the bottom of the pane (within 5px)
  const isAtBottom = Math.abs((btnBox.y + btnBox.height) - (paneBox.y + paneBox.height)) < 5;

  // Screenshot before clicking
  await page.screenshot({ path: artifacts.dir + '/01-before-click.png', fullPage: true });

  // Click the button
  await toggleBtn.click();
  await page.waitForTimeout(500);

  // Screenshot after clicking
  await page.screenshot({ path: artifacts.dir + '/02-after-click.png', fullPage: true });

  // Check if the list of outputs is now visible
  // We'll look for an element that likely contains the list, e.g., a div with class containing 'worker-output-list'
  const listVisible = await pane.evaluate(() => {
    const list = document.querySelector('.worker-output-list, .outputs-list, [class*="outputs-list"]');
    if (!list) return false;
    const rect = list.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  // Check for Open and Download buttons in the entire page (or within the pane)
  const hasOpen = await pane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => {
      const text = btn.textContent.trim();
      return text === 'Open';
    });
  });

  const hasDownload = await pane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => {
      const text = btn.textContent.trim();
      return text === 'Download';
    });
  });

  // Also, we can try to see if the button text changed (optional)

  // Return results
  return {
    isAtBottom,
    listVisible,
    hasOpen,
    hasDownload
  };
};