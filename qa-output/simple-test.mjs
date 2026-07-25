export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  // Screenshot before
  await page.screenshot({ path: artifacts.dir + '/01-before.png', fullPage: true });

  // Find the worker pane: a section with class 'pane' that contains the word 'Worker'
  const workerPane = await page.$(() => {
    const panes = document.querySelectorAll('section.pane');
    for (const p of panes) {
      if (p.textContent.includes('Worker')) {
        return p;
      }
    }
    return null;
  });

  if (!worker) {
    throw new Error('Worker pane not found');
  }

  // Get the pane's bounding box
  const paneBox = await workerPane.boundingBox();

  // Find the pinned bar: we'll look for the div with class 'worker-output-pinned'
  const pinnedBar = await worker.$('div.worker-output-pinned');
  if (!pinnedBar) {
    throw new Error('Pinned bar not found');
  }

  const barBox = await pinnedBar.boundingBox();

  // Check if the bar is at the bottom of the pane (within 5 pixels)
  const isAtBottom = Math.abs((barBox.y + barBox.height) - (paneBox.y + paneBox.height)) < 5;

  // Screenshot after locating
  await page.screenshot({ path: artifacts.dir + '/02-located.png', fullPage: true });

  // Now click the pinned bar (or the button inside it? Let's click the bar itself)
  await pinnedBar.click();
  await page.waitForTimeout(500);

  // Screenshot after click
  await page.screenshot({ path: artifacts.dir + '/03-after-click.png', fullPage: true });

  // Check if the list of outputs is visible
  const listVisible = await page.evaluate(() => {
    const list = document.querySelector('.worker-output-list, .outputs-list, [class*="outputs-list"]');
    return list && !list.offsetParent ? false : true; // offsetParent null means not visible
  });

  // Check for Open and Download buttons
  const hasOpen = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Open');
  });
  const hasDownload = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Download');
  });

  return {
    isAtBottom,
    listVisible,
    hasOpen,
    hasDownload
  };
};