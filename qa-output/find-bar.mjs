export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  const pane = await page.$('section.pane');
  if (!pane) {
    throw new Error('No pane');
  }
  const innerHTML = await pane.evaluate(el => el.innerHTML);
  const idx = innerHTML.indexOf('worker-output-pinned');
  if (idx === -1) {
    console.log('worker-output-pinned not found');
    return;
  }
  const snippet = innerHTML.substring(Math.max(0, idx - 200), idx + 200);
  console.log('Snippet around worker-output-pinned:');
  console.log(snippet);
};