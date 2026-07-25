export default async ({ page }) => {
  const text = await page.evaluate(() => {
    const el = document.querySelector('.workspace-view.is-conversation.is-active');
    return el ? el.innerText : null;
  });
  console.log('Text of workspace-view:');
  console.log('---');
  console.log(text);
  console.log('---');
  
  // Also look for the specific line
  const lines = text ? text.split('\n') : [];
  for (let i = 0; i < lines.length; i++) {
    if (/accepted/i.test(lines[i])) {
      console.log(`Line ${i}: ${JSON.stringify(lines[i])}`);
      // Also print next few lines
      for (let j = i; j < Math.min(i+3, lines.length); j++) {
        console.log(`  ${j}: ${JSON.stringify(lines[j])}`);
      }
    }
  }
};