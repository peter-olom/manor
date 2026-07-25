export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll('[class*="pane"]')).filter(el => !el.className.includes('head') && !el.className.includes('tab')).map(el => ({
      tag: el.tagName,
      class: el.className,
      id: el.id,
      width: el.offsetWidth,
      height: el.offsetHeight,
      left: el.offsetLeft,
      top: el.offsetTop,
      visible: el.offsetWidth > 0 && el.offsetHeight > 0
    }));
    return { panes };
  });
  console.log(info);
};