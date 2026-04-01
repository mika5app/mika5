// MIKA5 Diagnostic — paste this in DevTools Console (Ctrl+Shift+I)
// This will help identify what freezes when clicking the textarea

(function() {
  const textarea = document.getElementById('input');
  if (!textarea) { console.error('❌ Textarea #input not found!'); return; }
  
  console.log('=== MIKA5 FREEZE DIAGNOSTIC ===');
  console.log('1. Textarea found:', textarea.tagName, textarea.className);
  console.log('2. Disabled?', textarea.disabled);
  console.log('3. ReadOnly?', textarea.readOnly);
  console.log('4. Pointer-events:', getComputedStyle(textarea).pointerEvents);
  console.log('5. Visibility:', getComputedStyle(textarea).visibility);
  console.log('6. Display:', getComputedStyle(textarea).display);
  console.log('7. Z-index:', getComputedStyle(textarea).zIndex);
  console.log('8. Position:', getComputedStyle(textarea).position);
  
  // Check what's on top of the textarea
  const rect = textarea.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const topElement = document.elementFromPoint(centerX, centerY);
  console.log('9. Element at textarea center:', topElement?.tagName, topElement?.id, topElement?.className);
  console.log('   Is textarea itself?', topElement === textarea);
  
  if (topElement !== textarea) {
    console.error('❌ SOMETHING IS COVERING THE TEXTAREA!');
    console.log('   Covering element:', topElement);
    console.log('   Its z-index:', getComputedStyle(topElement).zIndex);
    console.log('   Its position:', getComputedStyle(topElement).position);
    console.log('   Its pointer-events:', getComputedStyle(topElement).pointerEvents);
    
    // Walk up to find the overlay
    let el = topElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'absolute') {
        console.log('   OVERLAY:', el.tagName, el.id, el.className, 
          'pos:', style.position, 'z:', style.zIndex,
          'display:', style.display, 'opacity:', style.opacity);
      }
      el = el.parentElement;
    }
  }
  
  // Check for event listeners that might block
  console.log('\n10. Testing focus...');
  const start = performance.now();
  textarea.focus();
  const elapsed = performance.now() - start;
  console.log('    Focus took:', elapsed.toFixed(2), 'ms');
  if (elapsed > 100) console.error('❌ FOCUS IS SLOW — possible spellcheck or GPU issue');
  
  // Check for modals/overlays blocking
  console.log('\n11. Checking for visible overlays...');
  document.querySelectorAll('.modal, [style*="position: fixed"], [style*="position:fixed"]').forEach(el => {
    const style = getComputedStyle(el);
    if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
      console.warn('   ⚠️ Visible overlay:', el.tagName, el.id, el.className, 
        'display:', style.display, 'z-index:', style.zIndex);
    }
  });
  
  // Check all fixed/absolute positioned elements
  console.log('\n12. All fixed-position elements:');
  document.querySelectorAll('*').forEach(el => {
    const style = getComputedStyle(el);
    if ((style.position === 'fixed' || style.position === 'sticky') && 
        style.display !== 'none' && style.pointerEvents !== 'none') {
      const r = el.getBoundingClientRect();
      // Check if it overlaps with textarea
      if (r.bottom > rect.top && r.top < rect.bottom && r.right > rect.left && r.left < rect.right) {
        console.error('   ❌ OVERLAPPING:', el.tagName, el.id, el.className,
          'rect:', JSON.stringify({top:r.top|0, left:r.left|0, w:r.width|0, h:r.height|0}));
      }
    }
  });
  
  // Check CSS applied to textarea
  console.log('\n13. Textarea computed styles:');
  const cs = getComputedStyle(textarea);
  console.log('    font-size:', cs.fontSize);
  console.log('    color:', cs.color);
  console.log('    background:', cs.backgroundColor);
  console.log('    border:', cs.border);
  console.log('    padding:', cs.padding);
  console.log('    min-height:', cs.minHeight);
  console.log('    max-height:', cs.maxHeight);
  console.log('    overflow:', cs.overflow);
  console.log('    resize:', cs.resize);
  
  // Check if spellcheck could be an issue
  console.log('\n14. Spellcheck:', textarea.spellcheck);
  console.log('    contentEditable:', textarea.contentEditable);
  
  // Check loaded stylesheets
  console.log('\n15. Loaded stylesheets:');
  Array.from(document.styleSheets).forEach((ss, i) => {
    try {
      console.log(`    [${i}]`, ss.href || 'inline', '- rules:', ss.cssRules?.length);
    } catch(e) {
      console.log(`    [${i}]`, ss.href || 'inline', '- CORS blocked');
    }
  });

  console.log('\n=== DIAGNOSTIC COMPLETE ===');
  console.log('If you see ❌ markers above, those are the likely causes.');
  console.log('Copy this entire console output and send it.');
})();
