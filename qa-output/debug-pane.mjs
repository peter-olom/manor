export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  const pane = await page.$('section.pane');
  if (!pane) {
    throw new Error('No pane');
  }
  const innerHTML = await pane.evaluate(el => el.innerHTML);
  console.log('Pane innerHTML length:', innerHTML.length);
  console.log('First 500 chars:', innerHTML.substring(0, 500));
};