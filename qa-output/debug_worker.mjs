export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const workers = Array.from(document.querySelectorAll('[class*="worker"]')).map(el => ({
      tag: el.tagName,
      class: el.className,
      id: el.id,
      width: el.offsetWidth,
      height: el.offsetHeight,
      left: el.offsetLeft,
      top: el.offsetTop,
      visible: el.offsetWidth > 0 && el.offsetHeight > 0
    }));
    return { workers };
  });
  console.log(info);
};