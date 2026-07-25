export default async ({ page }) => {
  console.log('URL:', page.url());
  // Wait a bit for stability
  await page.waitForTimeout(1000);
  
  // Get all elements with text containing "review" (case-insensitive)
  const elements = await page.$$eval('*', (els) => {
    return els
      .filter(el => el.innerText && /review/i.test(el.innerText))
      .map(el => ({
        tag: el.tagName,
        className: el.className,
        id: el.id,
        text: el.innerText.slice(0, 200),
        rect: el.getBoundingClientRect(),
      }));
  });
  console.log(`Found ${elements.length} elements with 'review' in text`);
  elements.forEach((el, i) => {
    console.log(`${i}: ${el.tagName} class="${el.className}" id="${el.id}"`);
    console.log(`   text: "${el.text}"`);
    console.log(`   rect: ${JSON.stringify(el.rect)}`);
  });
  
  // Also look for elements with specific known selectors for review panel
  const selectors = [
    '.review-panel',
    '[data-testid="review-panel"]',
    '.review-sidebar',
    '.review-container',
  ];
  for (const selector of selectors) {
    const el = await page.$(selector);
    if (el) {
      const rect = await el.boundingBox();
      console.log(`Found via selector ${selector}:`, await el.evaluate(e => ({
        tag: e.tagName,
        className: e.className,
        id: e.id,
        text: e.innerText.slice(0,200),
      })), `rect:`, rect);
    }
  }
};