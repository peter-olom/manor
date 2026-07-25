export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  const workerPane = await page.$('section.pane[aria-label*="Worker"]');
  if (!workerPane) {
    throw new Error('Worker pane not found');
  }

  const style = await workerPane.evaluate(el => {
    const s = getComputedStyle(el);
    return {
      paddingTop: s.paddingTop,
      paddingRight: s.paddingRight,
      paddingBottom: s.paddingBottom,
      paddingLeft: s.paddingLeft,
      height: s.height,
      overflowY: s.overflowY
    };
  });
  console.log('Pane style:', style);

  // Also get the bounding box of the pane's content area? We can get the clientHeight.
  const clientInfo = await workerPane.evaluate(el => ({
    clientHeight: el.clientHeight,
    offsetHeight: el.offsetHeight,
    scrollHeight: el.scrollHeight
  }));
  console.log('Client info:', clientInfo);
};