// Test script for reviewing the Butler UI review panel
export default async ({ page, context, artifacts, args }) => {
  // Use the provided URL
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  console.log(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  
  // Wait for the app to load; we'll wait for a specific element that indicates the UI is ready
  // Wait for the Butler container or something; we'll just wait a bit longer
  await page.waitForTimeout(5000); // wait 5 seconds for initial load
  
  // Take initial screenshot
  await page.screenshot({ path: 'qa-output/01-initial.png', fullPage: false });
  console.log('Saved initial screenshot');
  
  // Now, evaluate in the page to find the review panel
  const panelInfo = await page.evaluate(() => {
    // Helper to find element by text pattern
    function findElementByTextPattern(pattern) {
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
    }
    
    const pattern = /Accepted\s*·\s*\d+\s*findings\s*·\s*\d+\s*earlier\s*▸/i;
    const el = findElementByTextPattern(pattern);
    if (!el) {
      return { found: false };
    }
    
    const rect = el.getBoundingClientRect();
    const computed = window.getComputedStyle(el);
    return {
      found: true,
      text: el.innerText,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      // Check if it's likely collapsed: height small and maybe overflow hidden
      isCollapsed: rect.height < 60 && (computed.overflow === 'hidden' || computed.overflowY === 'hidden'),
      // Also check if there's a child that might be the expandable content
      hasExpandableContent: !!el.querySelector('.review-content, .findings-list, .review-details'),
    };
  });
  
  console.log('Panel info:', panelInfo);
  
  if (!panelInfo.found) {
    console.warn('Could not find review panel with expected text pattern.');
    // Take a full page screenshot for inspection
    await page.screenshot({ path: 'qa-output/02-panel-not-found-fullpage.png', fullPage: true });
  } else {
    console.log(`Found review panel: "${panelInfo.text}"`);
    console.log(`Dimensions: ${panelInfo.width} x ${panelInfo.height}`);
    console.log(`Position: (${panelInfo.left}, ${panelInfo.top})`);
    console.log(`Is collapsed? ${panelInfo.isCollapsed}`);
    console.log(`Has expandable content? ${panelInfo.hasExpandableContent}`);
    
    // Screenshot of the panel
    // We need to get the element handle to screenshot
    const handle = await page.evaluateHandle(() => {
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
    if (handle.asElement()) {
      await handle.asElement().screenshot({ path: 'qa-output/02-panel.png' });
      console.log('Saved panel screenshot');
    }
    
    // If the panel has expandable content and is collapsed, we can try clicking it to expand
    if (panelInfo.hasExpandableContent && panelInfo.isCollapsed) {
      console.log('Panel appears collapsed but has expandable content; attempting to click to expand...');
      await handle.asElement().click();
      await page.waitForTimeout(2000);
      // After clicking, re-evaluate the panel size
      const afterClickInfo = await page.evaluate(() => {
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
            const rect = node.getBoundingClientRect();
            return {
              height: rect.height,
              width: rect.width,
            };
          }
        }
        return null;
      });
      if (afterClickInfo) {
        console.log(`After click: height=${afterClickInfo.height}, width=${afterClickInfo.width}`);
        // Check if it's now expanded (height increased significantly)
        if (afterClickInfo.height > panelInfo.height + 20) {
          console.log('Panel expanded after click');
        } else {
          console.log('Panel did not expand significantly after click');
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