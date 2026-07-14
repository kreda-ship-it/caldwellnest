// Builds a snapshot harness from index.html: same markup + same styles.css, but with the
// app's JS stripped out so the DOM is static and deterministic. Then walks EVERY element and
// records its computed style. Run before and after the refactor; if the two dumps match, no
// element's rendering changed — including elements that are hidden or behind a login.
const fs = require('fs');
const path = require('path');
const ROOT = '/Users/kalkidanreda/Documents/Amahle/CaldwellNest';

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Drop the app scripts (they mutate the DOM on load) and the Supabase CDN.
html = html.replace(/<script[^>]*src="js\/[^"]*"[^>]*><\/script>\s*/g, '');
html = html.replace(/<script[^>]*src="https:\/\/cdn[^"]*"[^>]*><\/script>\s*/g, '');

// Properties that an inline style -> class conversion could plausibly change.
const PROPS = [
  'display','position','top','right','bottom','left','z-index','float','clear',
  'width','height','min-width','min-height','max-width','max-height',
  'margin-top','margin-right','margin-bottom','margin-left',
  'padding-top','padding-right','padding-bottom','padding-left',
  'flex-direction','flex-wrap','justify-content','align-items','align-self','flex-grow','flex-shrink','flex-basis','gap',
  'grid-template-columns','grid-template-rows',
  'font-size','font-weight','font-family','font-style','line-height','letter-spacing','text-align',
  'text-transform','text-decoration-line','white-space','overflow-x','overflow-y','text-overflow',
  'color','background-color','background-image','opacity','visibility',
  'border-top-width','border-right-width','border-bottom-width','border-left-width',
  'border-top-color','border-right-color','border-bottom-color','border-left-color',
  'border-top-left-radius','border-top-right-radius','border-bottom-left-radius','border-bottom-right-radius',
  'box-shadow','cursor','transform','object-fit','vertical-align',
];

const snapScript = `
<script>
(function () {
  const PROPS = ${JSON.stringify(PROPS)};
  const out = [];
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.tagName === 'SCRIPT') continue;
    const cs = getComputedStyle(el);
    const rec = { i, tag: el.tagName, id: el.id || '' };
    for (const p of PROPS) rec[p] = cs.getPropertyValue(p);
    out.push(rec);
  }
  const pre = document.createElement('pre');
  pre.id = 'SNAPSHOT';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script>
`;
html = html.replace('</body>', snapScript + '</body>');

const outPath = path.join(ROOT, '_snap.html');
fs.writeFileSync(outPath, html);
console.log('wrote _snap.html (' + html.split('\n').length + ' lines), ' + PROPS.length + ' properties per element');
