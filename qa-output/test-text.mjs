export default async ({ page, artifacts }) => {
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  await page.waitForTimeout(3000);
  const els = await page.$$eval('*', els => {
    const matches = [];
    for (const el of els) {
      if (el.textContent && el.textContent.includes('Task outputs')) {
        matches.push({
          tag: el.tagName,
          class: el.className,
          id: el.id,
          text: el.textContent.trim().substring(0, 200)
        });
      }
    }
    return matches;
  });
  console.log('Found elements:', JSON.stringify(els, null, 2));
};