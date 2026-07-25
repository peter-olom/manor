export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  const workerPane = await page.$('section.pane[aria-label*="Worker"]');
  if (!workerPane) {
    throw new Error('Worker pane not found');
  }
  const paneBox = await workerPane.boundingBox();
  console.log('Worker pane box:', paneBox);

  const pinnedBar = await workerPane.$('div[class*="worker-output-pinned"]');
  if (!pinnedBar) {
    throw new Error('Pinned bar not found');
  }
  const barBox = await pinnedBar.boundingBox();
  console.log('Pinned bar box:', barBox);

  console.log('Bar bottom:', barBox.y + barBox.height);
  console.log('Pane bottom:', paneBox.y + paneBox.height);
  console.log('Difference:', Math.abs((barBox.y + barBox.height) - (paneBox.y + paneBox.height)));
};