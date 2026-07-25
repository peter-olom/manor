export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  // Initial screenshot
  await page.screenshot({ path: artifacts.dir + '/01-initial.png', fullPage: true });

  // Find the worker pane: a section with class 'pane' that contains the word 'Worker'
  const pane = await page.$('section.pane');
  if (!pane) {
    throw new Error('No section.pane found');
  }
  const paneText = await pane.evaluate(el => el.textContent);
  if (!paneText.includes('Worker')) {
    throw new Error('The pane found does not contain Worker');
  }

  // Get the pane's bounding box
  const paneBox = await pane.boundingBox();

  // Find the pinned bar inside the pane: look for div with class 'worker-output-pinned'
  const pinnedBar = await pane.$('div.worker-output-pinned');
  if (!pinnedBar) {
    throw new Error('Pinned bar not found inside the pane');
  }

  const barBox = await pinnedBar.boundingBox();

  // Check if the bar is at the bottom of the pane (within 5 pixels)
  const isAtBottom = Math.abs((barBox.y + barBox.height) - (paneBox.y + paneBox.height)) < 5;

  // Screenshot after locating
  await page.screenshot({ path: artifacts.dir + '/02-located.png', fullPage: true });

  // Now click the pinned bar
  await pinnedBar.click();
  await page.waitForTimeout(500);

  // Screenshot after click
  await page.screenshot({ path: artifacts.dir + '/03-after-click.png', fullPage: true });

  // Check if the list of outputs is visible
  const listVisible = await pane.evaluate(() => {
    const list = document.querySelector('.worker-output-list, .outputs-list, [class*="outputs-list"]');
    if (!list) return false;
    // Check if the element is visible (not hidden and has dimensions)
    const rect = list.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  // Check for Open and Download buttons within the pane
  const hasOpen = await pane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Open');
  });
  const hasDownload = await pane.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Download');
  });

  return {
    isAtBottom,
    listVisible,
    hasOpen,
    hasDownload
  };
};