export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const paneBody = document.querySelector('.pane-body');
    if (!paneBody) return {error: 'no pane-body'};
    const all = Array.from(paneBody.querySelectorAll('*'));
    const classes = new Set();
    all.forEach(el => {
      if (el.className) {
        el.className.split(' ').forEach(c => { if (c) classes.add(c); });
      }
    });
    return Array.from(classes).sort();
  });
  console.log('Classes in pane-body:', info);
};