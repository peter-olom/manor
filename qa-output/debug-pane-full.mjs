import { promises as fs } from 'fs';

export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);

  const pane = await page.$('section.pane');
  if (!pane) {
    throw new Error('Pane not found');
  }

  const innerHTML = await pane.evaluate(el => el.innerHTML);
  await fs.writeFile(artifacts.dir + '/pane-inner.html', innerHTML);
  console.log('Written pane innerHTML to', artifacts.dir + '/pane-inner.html');
  console.log('Length:', innerHTML.length);
};