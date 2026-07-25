// Test script for reviewing the Butler UI review panel on the current page
export default async ({ page, context, artifacts, args }) => {
  // Use the provided page (should be the one we are connected to)
  console.log(`Current URL: ${page.url()}`);
  
  // Wait 3 seconds as instructed
  await page.waitForTimeout(3000);
  console.log('Waited 3 seconds');
  
  // Take initial screenshot
  await page.screenshot({ path: 'qa-output/01-initial.png', fullPage: false });
  console.log('Saved initial screenshot');
  
  // Look for the review panel
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
    
    // Get its bounding box to check size
    const box = await reviewPanel.boundingBox();
    if (box) {
      console.log(`Review panel dimensions: width=${box.width}, height=${box.height}`);
      // Check if it's collapsed: we expect height to be small (e.g., less than 60px for a single line)
      // This is a heuristic; we'll just log it.
      if (box.height < 60) {
        console.log('Review panel appears collapsed (height < 60px)');
      } else {
        console.log('Review panel appears expanded (height >= 60px)');
      }
    }
    
    // Get text content to see if it matches the expected pattern
    const text = await reviewPanel.evaluate(el => el.innerText);
    console.log(`Review panel text: "${text}"`);
    // Check for pattern like "Accepted · N findings · M earlier ▸"
    const pattern = /Accepted\s*·\s*\d+\s*findings\s*·\s*\d+\s*earlier\s*▸/;
    if (pattern.test(text)) {
      console.log('Text matches expected collapsed pattern');
    } else {
      console.log('Text does not match expected collapsed pattern; maybe expanded or different state');
    }
  }
  
  // Final screenshot
  await page.screenshot({ path: 'qa-output/03-final.png', fullPage: false });
  console.log('Test completed.');
};