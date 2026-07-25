export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  const pane = await page.$('section.pane');
  if (!pane) {
    throw new Error('Pane not found');
  }

  const outerHTML = await pane.evaluate(el => el.outerHTML);
  // Save to a file for inspection? Instead, let's look for the transcript div.
  if (outerHTML.includes('transcript')) {
    console.log('Found transcript in pane outerHTML');
    const idx = outerHTML.indexOf('transcript');
    const snippet = outerHTML.substring(Math.max(0, idx - 200), idx + 200);
    console.log('Snippet around transcript:', snippet);
  } else {
    console.log('Transcript NOT found in pane outerHTML');
  }

  // Also look for worker-output-pinned
  if (outerHTML.includes('worker-output-pinned')) {
    console.log('Found worker-output-pinned in pane outerHTML');
  } else {
    console.log('worker-output-pinned NOT found in pane outerHTML');
  }
};