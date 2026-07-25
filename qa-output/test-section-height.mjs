export default async ({ page }) => {
  console.log('Checking review verdict section height...');
  
  const section = await page.waitForSelector('.butler-review-verdict', { timeout: 5000 }).catch(() => null);
  if (!section) {
    console.error('Section not found');
    return;
  }
  
  const initial = await section.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return {
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      innerHTML: el.innerHTML.substring(0, 200),
    };
  });
  console.log('Initial section:', initial);
  
  await page.screenshot({ path: 'qa-output/01-section-before.png', fullPage: false });
  
  // Click the button inside
  const button = await section.$('.butler-review-verdict-toggle');
  if (button) {
    await button.click();
    await page.waitForTimeout(1000);
  }
  
  const after = await section.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return {
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      innerHTML: el.innerHTML.substring(0, 200),
    };
  });
  console.log('After section:', after);
  
  await page.screenshot({ path: 'qa-output/02-section-after.png', fullPage: false });
  
  const heightDiff = after.height - initial.height;
  console.log(`Section height changed by ${heightDiff}px`);
  
  // Click again to close
  if (button) {
    await button.click();
    await page.waitForTimeout(1000);
    const closed = await section.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return Math.round(rect.height);
    });
    console.log('Section height after re-close:', closed);
    await page.screenshot({ path: 'qa-output/03-section-closed.png', fullPage: false });
  }
};