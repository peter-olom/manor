// Test script to interact with the review panel
export default async ({ page, context, artifacts, args }) => {
  console.log('URL:', page.url());
  
  // Wait for initial load
  await page.waitForTimeout(2000);
  
  // Take initial screenshot
  await page.screenshot({ path: 'qa-output/01-initial.png', fullPage: false });
  console.log('Saved initial screenshot');
  
  // Find the review panel header by text pattern
  const header = await page.evaluateHandle(() => {
    const pattern = /Accepted\s*·\s*\d+\s*findings\s*·\s*\d+\s*earlier\s*▸/i;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      null,
      false
    );
    let node;
    while ((node = walker.nextNode())) {
      if (node.innerText && pattern.test(node.innerText)) {
        return node;
      }
    }
    return null;
  });
  
  const headerExists = await header.evaluate(el => !!el);
  if (!headerExists) {
    console.warn('Could not find review panel header with expected text pattern.');
    // Take a full page screenshot for inspection
    await page.screenshot({ path: 'qa-output/02-header-not-found-full.png', fullPage: true });
    return;
  }
  
  // Get the header's bounding box and text
  const headerInfo = await page.evaluate((handle) => {
    const el = handle.asElement();
    const rect = el.getBoundingClientRect();
    return {
      text: el.innerText.trim(),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
    };
  }, header);
  
  console.log('Header info:', headerInfo);
  
  // Screenshot of the header
  await header.asElement().screenshot({ path: 'qa-output/02-header.png' });
  console.log('Saved header screenshot');
  
  // Click the header to toggle expand/collapse
  await header.asElement().click();
  await page.waitForTimeout(2000); // wait for animation
  
  // After clicking, re-evaluate the header to see if it changed (maybe the text changes?)
  const afterClickInfo = await page.evaluate((handle) => {
    const el = handle.asElement();
    const rect = el.getBoundingClientRect();
    return {
      text: el.innerText.trim(),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
    };
  }, header);
  
  console.log('Header after click:', afterClickInfo);
  
  // Check if the height changed significantly (indicating expansion)
  const heightDiff = afterClickInfo.height - headerInfo.height;
  console.log(`Height change: ${heightDiff}px`);
  
  // Also, look for any additional content that might have appeared below the header
  // We can check the next sibling or the parent's innerHTML for new elements
  const expandedContent = await page.evaluate((handle) => {
    const el = handle.asElement();
    // Look for common patterns of expanded review content: lists, divs with class containing 'finding', 'review', etc.
    const selectors = [
      '.finding',
      '.review-item',
      '.review-content',
      '.collapsible-content',
      'ul',
      'ol',
    ];
    for (const selector of selectors) {
      const found = el.querySelector(selector);
      if (found) {
        return {
          found: true,
          selector,
          text: found.innerText.slice(0, 200),
        };
      }
    }
    // Also check if the element's innerHTML changed length significantly
    return { found: false };
  }, header);
  
  console.log('Expanded content check:', expandedContent);
  
  // Take a screenshot after click
  await page.screenshot({ path: 'qa-output/03-after-click.png', fullPage: false });
  console.log('Saved after-click screenshot');
  
  // If we expanded, we can try to collapse again by clicking once more
  if (heightDiff > 20) {
    console.log('Panel appears to have expanded; clicking again to collapse...');
    await header.asElement().click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'qa-output/04-re-collapsed.png', fullPage: false });
    console.log('Saved re-collapsed screenshot');
  }
  
  // Final screenshot
  await page.screenshot({ path: 'qa-output/05-final.png', fullPage: false });
  console.log('Test completed.');
};