export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  // Find the worker pane by aria-label
  const workerPane = await page.$('section.pane[aria-label*="Worker"]');
  if (!workerPane) {
    throw new Error('Worker pane not found');
  }

  const outerHTML = await workerPane.evaluate(el => el.outerHTML);
  console.log('Worker pane outerHTML length:', outerHTML.length);
  // Look for worker-output-pinned
  if (outerHTML.includes('worker-output-pinned')) {
    console.log('Found worker-output-pinned in worker pane');
    const idx = outerHTML.indexOf('worker-output-pinned');
    const snippet = outerHTML.substring(Math.max(0, idx - 200), idx + 200);
    console.log('Snippet:', snippet);
  } else {
    console.log('worker-output-pinned NOT found in worker pane');
    // Show first 500 chars
    console.log('First 500 chars:', outerHTML.substring(0, 500));
  }
};