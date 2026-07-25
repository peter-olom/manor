export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  // Initial screenshot
  await page.screenshot({ path: artifacts.dir + '/01-initial.png', fullPage: true });

  // 1. Find the worker pane: section with class 'pane' and aria-label containing 'Worker'
  const workerPane = await page.$('section.pane[aria-label*="Worker"]');
  if (!workerPane) {
    throw new Error('Worker pane not found');
  }

  // Get the pane's bounding box
  const paneBox = await workerPane.boundingBox();
  if (!paneBox) {
    throw new Error('Could not get bounding box of worker pane');
  }

  // 2. Inside the pane, find the pinned bar div
  const pinnedBarDiv = await workerPane.$('div.worker-output-pinned');
  if (!pinnedBarDiv) {
    throw new Error('Pinned bar div not found');
  }

  const barBox = await pinnedBarDiv.boundingBox();
  if (!barBox) {
    throw new Error('Could not get bounding box of pinned bar');
  }

  // 3. Check if the bar is at the bottom of the pane (within 5 pixels)
  const isAtBottom = Math.abs((barBox.y + barBox.height) - (paneBox.y + paneBox.height)) < 5;

  // 4. Check for green dot: look for span.worker-output-pinned-dot inside the bar and see if its background is green
  const hasGreenDot = await workerPane.evaluate((bar) => {
    const dot = bar.querySelector('span.worker-output-pinned-dot');
    if (!dot) return false;
    const style = getComputedStyle(dot);
    // The dot might have a background-color of green or be a colored circle via background-image
    const bgColor = style.backgroundColor;
    if (bgColor && (bgColor.includes('green') || bgColor.includes('rgb(0, 128, 0)') || bgColor.includes('rgb(0,100,0)')) {
      return true;
    }
    // Also check if it has a background-image (like a gradient or inline SVG)
    const bgImage = style.backgroundImage;
    if (bgImage && bgImage.includes('green')) {
      return true;
    }
    return false;
  }, pinnedBarDiv);

  // 5. Check for chevron: look for the svg inside span.worker-output-pinned-chevron
  const hasChevron = await workerPane.evaluate((bar) => {
    return bar.querySelector('span.worker-output-pinned-chevron svg') !== null;
  }, pinnedBarDiv);

  // 6. Take a screenshot before clicking
  await page.screenshot({ path: artifacts.dir + '/02-before-click.png', fullPage: true });

  // 7. Click the button inside the bar (the button is the direct child of the div)
  const toggleButton = await workerPane.$('button.worker-output-pinned-toggle');
  if (!toggleButton) {
    throw new Error('Toggle button not found');
  }
  await toggleButton.click();
  await page.waitForTimeout(500); // wait for animation

  // 8. Take a screenshot after clicking
  await page.screenshot({ path: artifacts.dir + '/03-after-click.png', fullPage: true });

  // 9. Check if the list of outputs is now visible
  // After clicking, we expect to see a list with class 'worker-output-summary-list' or similar
  const listVisible = await workerPane.evaluate(() => {
    const list = document.querySelector('.worker-output-summary-list');
    if (!list) return false;
    // Check if the element is not hidden and has height
    const rect = list.getBoundingClientRect();
    return rect.height > 0;
  });

  // 10. Also check for Open and Download buttons in the list
  const hasOpenButton = await workerPane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => {
      const text = btn.textContent.trim();
      return text === 'Open';
    });
  });

  const hasDownloadButton = await workerPane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(btn => {
      const text = btn.textContent.trim();
      return text === 'Download';
    });
  });

  // Return the results
  return {
    isAtBottom,
    hasGreenDot,
    hasChevron,
    listVisible,
    hasOpenButton,
    hasDownloadButton
  };
};