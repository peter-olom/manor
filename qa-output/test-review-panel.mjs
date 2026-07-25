// Test script for reviewing the Butler UI review panel
export default async ({ page, context, artifacts, args }) => {
  // Use the provided URL from the task
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  console.log(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000); // wait 3 seconds for initial load
  
  // Take initial screenshot
  await page.screenshot({ path: 'qa-output/01-initial.png', fullPage: false });
  console.log('Saved initial screenshot');
  
  // Get current URL to verify
  const currentUrl = page.url();
  console.log(`Current URL: ${currentUrl}`);
  
  // Look for review panel
  const reviewPanelSelectors = [
    '.review-panel',
    '[data-testid="review-panel"]',
    '.review-panel-container',
    '.review-sidebar',
  ];
  
  let reviewPanel = null;
  for (const selector of reviewPanelSelectors) {
    reviewPanel = await page.$(selector);
    if (reviewPanel) {
      console.log(`Found review panel with selector: ${selector}`);
      break;
    }
  }
  
  if (!reviewPanel) {
    // Try to find a button that opens the review panel
    const openReviewSelectors = [
      'button:has-text("Review")',
      '[data-testid="open-review"]',
      '.review-toggle',
      'button[aria-label*="review" i]',
    ];
    let openButton = null;
    for (const selector of openReviewSelectors) {
      openButton = await page.$(selector);
      if (openButton) {
        console.log(`Found open review button with selector: ${selector}`);
        break;
      }
    }
    
    if (openButton) {
      await openButton.click();
      await page.waitForTimeout(2000); // wait for panel to open
      // Now try to find the panel again
      for (const selector of reviewPanelSelectors) {
        reviewPanel = await page.$(selector);
        if (reviewPanel) {
          console.log(`Found review panel after clicking with selector: ${selector}`);
          break;
        }
      }
    }
  }
  
  if (!reviewPanel) {
    console.warn('Could not find review panel. Taking full page screenshot for inspection.');
    await page.screenshot({ path: 'qa-output/02-review-panel-not-found.png', fullPage: true });
  } else {
    // Review panel found, take a screenshot of it
    await reviewPanel.screenshot({ path: 'qa-output/02-review-panel.png' });
    console.log('Saved review panel screenshot');
    
    // Optionally, get some text content for sanity check
    const panelText = await reviewPanel.evaluate(el => el.innerText);
    console.log('Review panel text preview:', panelText.substring(0, 200));
  }
  
  // Final screenshot
  await page.screenshot({ path: 'qa-output/03-final.png', fullPage: false });
  console.log('Test completed.');
};