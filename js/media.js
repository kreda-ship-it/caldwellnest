// ============================================================
// MEDIA
// Photos: resize before upload, upload/delete from storage, galleries, and avatars.
// Split out of index.html on 2026-07-11. Loaded as a plain script (not a
// module) so every function stays global — the HTML's onclick="..." handlers
// depend on that. Load order is set in index.html; boot.js must stay last.
// ============================================================

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = e => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX = 1600;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Resize failed')), 'image/jpeg', 0.85);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function uploadListingPhoto(blob, posterId) {
  const path = `${posterId || 'guest'}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabaseClient.storage
    .from('listing-photos')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  const { data } = supabaseClient.storage.from('listing-photos').getPublicUrl(path);
  return data.publicUrl;
}

async function deleteListingPhotos(photoUrls) {
  if (!photoUrls || !photoUrls.length) return;
  const paths = photoUrls.map(url => {
    const m = url.split('/listing-photos/');
    return m.length === 2 ? m[1] : null;
  }).filter(Boolean);
  if (paths.length) await supabaseClient.storage.from('listing-photos').remove(paths);
}

// Renders a photo gallery: one main image + (if more than one) a strip of
// clickable thumbnails. Tapping a thumbnail swaps the main image. mainId must
// be unique per gallery on the page so multiple galleries don't collide.
function photoGalleryHtml(urls, opts = {}) {
  if (!urls || !urls.length) return '';
  const radius = opts.radius || '0';
  const mainId = opts.mainId || 'galMain';
  const alt = escAttr(opts.alt || '');
  // `natural` shows the image at its true aspect ratio (capped), instead of a fixed-height crop box.
  const sizeStyle = opts.natural
    ? `width:100%;height:auto;max-height:${opts.maxHeight || '60vh'};object-fit:cover;`
    : `width:100%;height:${opts.height || 220}px;object-fit:cover;`;
  const main = `<img id="${mainId}" src="${urls[0]}" style="${sizeStyle}display:block;border-radius:${radius};" loading="lazy" alt="${alt}">`;
  if (urls.length === 1) return main;
  const thumbs = `<div style="display:flex;gap:6px;padding:8px 12px;overflow-x:auto;">` +
    urls.map((u, i) => `<img src="${u}" onclick="document.getElementById('${mainId}').src=this.src;[...this.parentNode.children].forEach(t=>t.style.borderColor='transparent');this.style.borderColor='var(--brand)'" style="width:54px;height:42px;object-fit:cover;border-radius:4px;cursor:pointer;flex-shrink:0;border:2px solid ${i === 0 ? 'var(--brand)' : 'transparent'};" loading="lazy" alt="">`).join('') +
    `</div>`;
  return main + thumbs;
}

// ---- Avatar (profile picture) helpers ----
// Paints an existing circular element: shows the image if a url is given,
// otherwise falls back to initials on the colour background.
function paintAvatarEl(el, url, initials, color) {
  if (!el) return;
  if (url) {
    el.textContent = '';
    el.style.backgroundImage = `url('${url}')`;
  } else {
    el.style.backgroundImage = '';
    el.style.background = color || el.style.background;
    el.textContent = initials || '?';
  }
}

async function uploadAvatar(blob, userId) {
  const path = `${userId}/avatar.jpg`; // first folder must be the user id to pass the storage policy
  const { error } = await supabaseClient.storage
    .from('listing-photos')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;
  const { data } = supabaseClient.storage.from('listing-photos').getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`; // ?v= busts the browser cache so a replaced photo shows immediately
}

function pickAvatar(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  const isHEIC = file.type === 'image/heic' || file.type === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
  if (isHEIC) { toast('HEIC photos aren\'t supported yet — please choose a JPEG or PNG.'); return; }
  if (!file.type.startsWith('image/')) { toast('Please choose an image file (JPEG, PNG, or WebP).'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('That photo is over 10 MB — please choose a smaller one.'); return; }
  _pendingAvatarFile = file;
  _avatarRemoved = false;
  const prev = document.getElementById('epAvatarPreview');
  paintAvatarEl(prev, URL.createObjectURL(file), null, null);
  document.getElementById('epAvatarRemoveBtn').style.display = 'inline';
}

function removeAvatar() {
  _pendingAvatarFile = null;
  _avatarRemoved = true;
  const u = getEffectiveUser();
  paintAvatarEl(document.getElementById('epAvatarPreview'), null, u?.initials, u?.color);
  document.getElementById('epAvatarRemoveBtn').style.display = 'none';
}
