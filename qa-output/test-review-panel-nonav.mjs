// Test script for reviewing the Butler UI review panel on the current page (no navigation)
export default async ({ page, context, artifacts, args }) => {
  console.log(`Current URL: ${page.url()}`);
  
  // Wait 3 seconds as instructed
  await page.waitForTimeout(3000);
  console.log('Waited 3 seconds');
  
  // Take initial screenshot
  await page.screenshot({ path: 'qa-output/01-initial.png', fullPage: false });
  console.log('Saved initial screenshot');
  
  // Evaluate the page to find the review panel
  const panelInfo = await page.evaluate(() => {
    // Pattern for the collapsed review panel text
    const pattern = /Accepted\s*·\s*\d+\s*findings\s*·\s*\d+\s*earlier\s*▸/i;
    
    // Function to find element by text pattern
    function findElementByTextPattern(root = document.body) {
      const walker = document.createTreeWalker(
        root,
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
    }
    
    const el = findElementByTextPattern();
    if (!el) {
      return { found: false };
    }
    
    const rect = el.getBoundingClientRect();
    const computed = window.getComputedStyle(el);
    
    // Determine if it's likely collapsed: height small and maybe overflow hidden
    const isCollapsed = rect.height < 60; // arbitrary threshold for a single line
    
    // Check if there's expandable content inside (e.g., a list that is hidden)
    const hasExpandableContent = !!el.querySelector('.review-content, .findings-list, .review-details, .collapsible-content');
    
    return {
      found: true,
      text: el.innerText.trim(),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      isCollapsed: !!isCollapsed,
      hasExpandableContent: !!hasExpandableContent,
      // Additional info: check if the element has a class that indicates collapsed/expanded
      classes: Array.from(el.classList),
    };
  });
  
  console.log('Panel info:', panelInfo);
  
  if (!panelInfo.found) {
    console.warn('Could not find review panel with expected text pattern.');
    // Take a full page screenshot for inspection
    await page.screenshot({ path: 'qa-output/02-panel-not-found-full.png', fullPage: true });
  } else {
    // Take a screenshot of the panel itself
    // We need to get the element again to screenshot it
    const panelElement = await page.evaluateHandle(() => {
      const pattern = /Accepted\s*·\s*\d+\s*findings\s*·\s*\d+\s*earlier\s*▸/i;
      function findElementByTextPattern(root = document.body) {
        const walker = document.createTreeWalker(
          root,
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
      }
      return findElementByTextPattern();
    });
    if (panelElement) {
      await panelElement.screenshot({ path: 'qa-output/02-panel.png' });
      console.log('Saved panel screenshot');
    }
    
    // Log findings
    console.log(`Panel dimensions: ${panelInfo.width}px x ${panelInfo.height}px`);
    console.log(`Panel text: "${panelInfo.text}"`);
    console.log(`Panel appears collapsed: ${panelInfo.isCollapsed}`);
    console.log(`Panel has expandable content: ${panelInfo.hasExpandableContent}`);
    
    // If the panel is collapsed and has expandable content, try clicking it to expand
    if (panelInfo.isCollapsed && panelInfo.hasExpandableContent) {
      console.log('Attempting to click panel to expand...');
      await panelElement.click();
      await page.waitForTimeout(2000); // wait for expansion
      
      // After clicking, re-evaluate the panel size
      const afterClickInfo = await page.evaluate(() => {
        const pattern = /Accepted\s*·\s*\d+\s*findings\s*·\s*\d+\s*earlier\s*▸/i;
        function findElementByTextPattern(root = document.body) {
          const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT,
            null,
            false
          );
          let node;
          while ((node = walker.nextNode())) {
            if (node.innerText && pattern.test(node.innerText)) {
              const rect = node.getBoundingClientRect();
              return {
                height: Math.round(rect.height),
                width: Math.round(rect.width),
              };
            }
          }
          return null;
        }
        return findElementByTextPattern();
      });
      
      if (afterClickInfo) {
        console.log(`After click dimensions: ${afterClickInfo.width}px x ${afterClickInfo.height}px`);
        // Determine if it expanded significantly
        const heightDiff = afterClickInfo.height - panelInfo.height;
        if (heightDiff > 20) {
          console.log(`Panel expanded by ${heightDiff}px`);
        } else {
          console.log(`Panel did not expand significantly (only ${heightDiff}px)`);
        }
        // Screenshot after click
        await page.screenshot({ path: 'qa-output/03-panel-expanded.png', fullPage: false });
        console.log('Saved expanded panel screenshot');
      }
    }
  }
  
  // Final screenshot
  await page.screenshot({ path: 'qa-output/04-final.png', fullPage: false });
  console.log('Test completed.');
};