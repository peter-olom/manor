export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  const pane = await page.$('section.pane');
  if (!pane) {
    throw new Error('Pane not found');
  }

  const innerHTML = await pane.evaluate(el => el.innerHTML);
  // Write to a file using the artifacts? We'll just log a snippet.
  console.log('Pane innerHTML length:', innerHTML.length);
  // Look for worker-output-pinned in the innerHTML
  if (innerHTML.includes('worker-output-pinned')) {
    console.log('Found worker-output-pinned in innerHTML');
    // Extract a snippet
    const idx = innerHTML.indexOf('worker-output-pinned');
    const snippet = innerHTML.substring(Math.max(0, idx - 100), idx + 100);
    console.log('Snippet:', snippet);
  } else {
    console.log('worker-output-pinned NOT found in innerHTML');
    // Show first 500 chars
    console.log('First 500 chars:', innerHTML.substring(0, 500));
  }
};