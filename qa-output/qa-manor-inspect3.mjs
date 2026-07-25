export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  
  const timestamp = Date.now();
  const screenshotPath = `qa-output/manor-inspect-${timestamp}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  
  const data = await page.evaluate(() => {
    const info = {};
    info.title = document.title;
    info.bodyInnerHTMLLength = document.body.innerHTML.length;
    const visibleText = document.body.innerText || '';
    info.visibleTextFirst500 = visibleText.substring(0, 500);
    
    const topBarSelectors = ['.top-bar', 'header', '[role="banner"]', '.app-header', '#header'];
    info.topBarVisible = false;
    info.topBarSelectorFound = null;
    for (const sel of topBarSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        info.topBarVisible = true;
        info.topBarSelectorFound = sel;
        break;
      }
    }
    
    const sidebarSelectors = ['.sidebar', 'aside', '[role="navigation"]', '.left-pane', '#sidebar'];
    info.sidebarExists = false;
    info.sidebarSelectorFound = null;
    info.sidebarContent = '';
    for (const sel of sidebarSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        info.sidebarExists = true;
        info.sidebarSelectorFound = sel;
        info.sidebarContent = el.innerText.trim().substring(0, 200);
        break;
      }
    }
    
    const mainSelectors = ['main', '.main-content', '#main', '.content', '.workspace'];
    info.mainContentExists = false;
    info.mainContentSelectorFound = null;
    info.mainContentText = '';
    for (const sel of mainSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        info.mainContentExists = true;
        info.mainContentSelectorFound = sel;
        info.mainContentText = el.innerText.trim().substring(0, 200);
        break;
      }
    }
    
    const errorSelectors = ['.error', '.alert-danger', '.msg-error', '[role="alert"]', '.notification-error'];
    info.errorMessages = [];
    for (const sel of errorSelectors) {
      const els = document.querySelectorAll(sel);
      els.forEach(el => {
        if (el.offsetParent !== null) {
          info.errorMessages.push(el.innerText.trim());
        }
      });
    }
    
    const classesToCheck = [
      'workspace-views',
      'workspace-view is-conversation',
      'pane',
      'butler-review-verdict',
      'worker-output-summary'
    ];
    info.classPresence = {};
    for (const cls of classesToCheck) {
      const classArray = cls.split(' ');
      let present = true;
      for (const c of classArray) {
        if (!document.querySelector('.' + c)) {
          present = false;
          break;
        }
      }
      info.classPresence[cls] = present;
    }
    
    const sections = Array.from(document.querySelectorAll('section'));
    info.visibleSectionsCount = sections.filter(s => s.offsetParent !== null).length;
    
    const allElements = Array.from(document.querySelectorAll('*'));
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const overlapIssues = [];
    allElements.forEach(el => {
      if (!el.offsetParent) return;
      const rect = el.getBoundingClientRect();
      if (rect.left < 0 || rect.top < 0 || rect.right > viewportWidth || rect.bottom > viewportHeight) {
        overlapIssues.push({
          tag: el.tagName,
          className: el.className,
          rect: {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom}
        });
      }
    });
    info.overlapIssues = overlapIssues.slice(0,5);
    
    return info;
  });
  
  console.log('=== Inspection Results ===');
  console.log('Title:', data.title);
  console.log('Body innerHTML length:', data.bodyInnerHTMLLength);
  console.log('Visible text first 200 chars:', data.visibleTextFirst500.substring(0,200));
  console.log('Top bar visible:', data.topBarVisible, 'selector:', data.topBarSelectorFound);
  console.log('Sidebar exists:', data.sidebarExists, 'selector:', data.sidebarSelectorFound);
  if (data.sidebarExists) console.log('Sidebar preview:', data.sidebarContent);
  console.log('Main content exists:', data.mainContentExists, 'selector:', data.mainContentSelectorFound);
  if (data.mainContentExists) console.log('Main content preview:', data.mainContentText);
  console.log('Error messages:', data.errorMessages);
  console.log('Class presence:', data.classPresence);
  console.log('Visible sections count:', data.visibleSectionsCount);
  console.log('Overlap issues count:', data.overlapIssues.length);
  if (data.overlapIssues.length > 0) console.log('First overlap issue:', data.overlapIssues[0]);
  
  return {
    ...data,
    screenshot: screenshotPath
  };
};
