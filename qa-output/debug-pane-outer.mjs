export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  const pane = await page.$('section.pane');
  if (!pane) {
    throw new Error('Pane not found');
  }

  const outerHTML = await pane.evaluate(el => el.outerHTML);
  if (outerHTML.includes('worker-output-pinned')) {
    console.log('FOUND in outerHTML');
    const idx = outerHTML.indexOf('worker-output-pinned');
    const snippet = outerHTML.substring(Math.max(0, idx - 100), idx + 100);
    console.log('Snippet:', snippet);
  } else {
    console.log('NOT FOUND in outerHTML');
    // Show first 500 chars
    console.log('First 500 chars of outerHTML:', outerHTML.substring(0, 500));
  }
};