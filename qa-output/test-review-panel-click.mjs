export default async ({ page }) => {
  console.log('Testing review panel expand/collapse...');
  
  // Wait for the review verdict button
  const button = await page.waitForSelector('.butler-review-verdict-toggle', { timeout: 5000 }).catch(() => null);
  if (!button) {
    console.error('Review verdict button not found');
    return;
  }
  
  console.log('Found review verdict button');
  
  // Get its initial state
  const initialState = await button.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return {
      className: el.className,
      innerHTML: el.innerHTML,
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      outerHTML: el.outerHTML.slice(0, 200),
    };
  });
  console.log('Initial state:', initialState);
  
  // Take screenshot before click
  await page.screenshot({ path: 'qa-output/01-before-click.png', fullPage: false });
  console.log('Screenshot before click saved');
  
  // Click the button
  await button.click();
  await page.waitForTimeout(1000); // wait for animation
  
  // Get state after click
  const afterState = await button.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return {
      className: el.className,
      innerHTML: el.innerHTML,
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      outerHTML: el.outerHTML.slice(0, 200),
    };
  });
  console.log('State after click:', afterState);
  
  // Check if the class changed (maybe toggles is-accepted or adds expanded)
  const classChanged = initialState.className !== afterState.className;
  console.log('Class changed:', classChanged);
  
  // Check if height changed significantly
  const heightDiff = afterState.height - initialState.height;
  console.log(`Height change: ${heightDiff}px`);
  
  // Take screenshot after click
  await page.screenshot({ path: 'qa-output/02-after-click.png', fullPage: false });
  console.log('Screenshot after click saved');
  
  // Look for any new content that might have appeared below the button
  // We can check the next sibling or the parent's innerHTML for new elements
  const newContent = await page.evaluate((button) => {
    const parent = button.parentElement;
    if (!parent) return null;
    // Look for common patterns of expanded content within the parent or next siblings
    const selectors = [
      '.review-details',
      '.findings-list',
      '.collapsible-content',
      'ul',
      'ol',
      '.butler-review-details',
    ];
    for (const selector of selectors) {
      const el = parent.querySelector(selector);
      if (el) {
        return {
          found: true,
          selector,
          text: el.innerText.slice(0, 200),
        };
      }
    }
    // Also check if the button's parent has more children than before? Hard without before state.
    return { found: false };
  }, button);
  
  console.log('New content check:', newContent);
  
  // Click again to collapse
  await button.click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'qa-output/03-after-second-click.png', fullPage: false });
  console.log('Screenshot after second click (should be collapsed) saved');
  
  // Final verdict
  if (heightDiff !== 0) {
    console.log(`Panel height changed by ${heightDiff}px on click.`);
  } else {
    console.log('Panel height did not change; maybe already expanded or not clickable?');
  }
};