'use strict';
// Digital ID badge: drawn on a <canvas> (CR80 portrait ratio) so it can be shown, saved as PNG, or wrapped in a one-page PDF.
const BADGE_W = 640, BADGE_H = 1016;
const BAND = { green: ['#2fbf5b', 'CLEARED TO DEPLOY'], yellow: ['#e0b022', 'FIX BEFORE NEXT ROTATION'], red: ['#d93636', 'NO-GO — NOT CLEARED'] };
function loadImg(src) { return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
async function drawBadge(cv, b) {
  cv.width = BADGE_W; cv.height = BADGE_H; const x = cv.getContext('2d');
  const [logo, photo] = await Promise.all([loadImg('/icons/logo.png'), loadImg(`/api/headshot/${b.contractor_id}?approved=1&v=${encodeURIComponent(b.headshot_status + (b.v || ''))}`)]);
  x.fillStyle = '#0d0f0a'; x.fillRect(0, 0, BADGE_W, BADGE_H);
  x.fillStyle = '#4b5b2a'; x.fillRect(0, 0, BADGE_W, 150);
  if (logo) x.drawImage(logo, 24, 15, 120, 120);
  x.fillStyle = '#fff'; x.font = 'bold 52px Arial, Helvetica, sans-serif'; x.fillText('FFD', 164, 78);
  x.font = '22px Arial, Helvetica, sans-serif'; x.fillStyle = '#dfe4cf'; x.fillText('FIT FOR DEPLOYMENT · CONTRACTOR ID', 164, 114);
  // photo
  x.fillStyle = '#26301a'; x.fillRect(150, 182, 340, 340);
  if (photo) x.drawImage(photo, 155, 187, 330, 330);
  x.strokeStyle = '#8a9a5b'; x.lineWidth = 4; x.strokeRect(150, 182, 340, 340);
  if (b.headshot_status !== 'approved') { x.fillStyle = 'rgba(0,0,0,.65)'; x.fillRect(155, 472, 330, 45); x.fillStyle = '#ffd877'; x.font = 'bold 20px Arial'; x.textAlign = 'center'; x.fillText(b.headshot_status === 'pending' ? 'PHOTO PENDING APPROVAL' : 'NO APPROVED PHOTO', 320, 502); x.textAlign = 'left'; }
  // name + title
  x.textAlign = 'center'; x.fillStyle = '#fff'; let fs = 46; x.font = `bold ${fs}px Arial`; while (x.measureText(b.name).width > 580 && fs > 26) { fs -= 2; x.font = `bold ${fs}px Arial`; }
  x.fillText(b.name, 320, 590); x.font = '28px Arial'; x.fillStyle = '#c9d3a8'; x.fillText(b.title, 320, 632);
  // stoplight band
  const [col, txt] = BAND[b.status] || BAND.red; x.fillStyle = col; x.fillRect(0, 662, BADGE_W, 84);
  x.fillStyle = b.status === 'yellow' ? '#111' : '#fff'; x.font = 'bold 34px Arial'; x.fillText(txt, 320, 717);
  // fields
  x.textAlign = 'left'; const row = (label, val, y) => { x.fillStyle = '#9aa38a'; x.font = '20px Arial'; x.fillText(label.toUpperCase(), 48, y); x.fillStyle = '#fff'; x.font = 'bold 28px Arial'; x.fillText(val, 48, y + 34); };
  row('ID number', b.employee_no, 790); row(b.site_label, b.site, 870);
  x.textAlign = 'right'; x.fillStyle = '#9aa38a'; x.font = '20px Arial'; x.fillText('VALID THROUGH', 592, 790); x.fillStyle = b.valid_through ? '#fff' : '#ff8a8a'; x.font = 'bold 28px Arial';
  x.fillText(b.valid_through || 'NOT VALID', 592, 824);
  x.fillStyle = '#6f7764'; x.font = '18px Arial'; x.textAlign = 'center'; x.fillText(`Issued ${b.issued} · Demo badge — verify status in FFD`, 320, 990); x.textAlign = 'left';
  return cv;
}
function saveBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
const badgeFile = (b, ext) => `ffd-badge-${b.employee_no}.${ext}`;
function badgePng(cv, b) { cv.toBlob((bl) => saveBlob(bl, badgeFile(b, 'png')), 'image/png'); }
function badgePdf(cv, b) {
  // Minimal one-page PDF (credit-card size 2.125" x 3.375") embedding the badge as a JPEG.
  const bin = atob(cv.toDataURL('image/jpeg', 0.92).split(',')[1]); const img = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) img[i] = bin.charCodeAt(i);
  const W = 153, H = 243; const enc = new TextEncoder(); const parts = []; const offs = []; let len = 0;
  const push = (p) => { const u = typeof p === 'string' ? enc.encode(p) : p; parts.push(u); len += u.length; };
  push('%PDF-1.4\n');
  const obj = (n, body) => { offs[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${BADGE_W} /Height ${BADGE_H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`); push(img); push('\nendstream'); });
  const cs = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`; obj(5, () => push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
  const xref = len; push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offs[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  saveBlob(new Blob(parts, { type: 'application/pdf' }), badgeFile(b, 'pdf'));
}
// Headshot capture: camera (capture=user) or upload -> face guide -> pan/zoom square crop -> 512px JPEG
function headshotPicker(onDone) {
  modal(`<div class="row"><h2>📸 Headshot</h2><button class="btn sm right" data-close>✕</button></div>
    <p class="small mut">Plain background, face the camera, no hat or sunglasses. Center your face in the oval. JPEG/PNG/WebP up to 10 MB.</p>
    <div class="row mt"><label class="btn pri">📷 Take photo<input type="file" accept="image/*" capture="user" id="hsCam" hidden></label><label class="btn">⬆️ Upload<input type="file" accept="image/jpeg,image/png,image/webp" id="hsUp" hidden></label></div>
    <div id="hsCrop" class="hs-crop hidden mt"><div class="hs-view" id="hsView"><img id="hsImg" alt=""><div class="hs-guide"></div></div>
      <label class="small">Zoom</label><input type="range" id="hsZoom" min="1" max="3" step="0.01" value="1">
      <p class="small mut">Drag the photo to line your face up with the oval.</p>
      <button class="btn pri mt" id="hsUse">Use this photo</button></div>`, (m, close) => {
    const view = $('#hsView', m); const imgEl = $('#hsImg', m); const S = { x: 0, y: 0, z: 1, base: 1, w: 0, h: 0 };
    const V = 300;
    const apply = () => {
      const sc = S.base * S.z; const w = S.w * sc; const h = S.h * sc;
      S.x = Math.min(0, Math.max(V - w, S.x)); S.y = Math.min(0, Math.max(V - h, S.y));
      imgEl.style.width = `${w}px`; imgEl.style.height = `${h}px`; imgEl.style.transform = `translate(${S.x}px, ${S.y}px)`;
    };
    const pick = (f) => {
      if (!f) return;
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return toast('Use a JPEG, PNG or WebP photo', true);
      if (f.size > 10 * 1024 * 1024) return toast('Photo too large (max 10 MB)', true);
      const url = URL.createObjectURL(f); imgEl.onload = () => {
        S.w = imgEl.naturalWidth; S.h = imgEl.naturalHeight;
        if (Math.min(S.w, S.h) < 256) { toast('Photo is too small — at least 256 px', true); return; }
        S.base = V / Math.min(S.w, S.h); S.z = 1; S.x = (V - S.w * S.base) / 2; S.y = (V - S.h * S.base) / 2; $('#hsZoom', m).value = 1; apply(); $('#hsCrop', m).classList.remove('hidden');
      };
      imgEl.src = url;
    };
    $('#hsCam', m).addEventListener('change', (e) => pick(e.target.files[0])); $('#hsUp', m).addEventListener('change', (e) => pick(e.target.files[0]));
    $('#hsZoom', m).addEventListener('input', (e) => { const old = S.base * S.z; S.z = +e.target.value; const nw = S.base * S.z; const c = V / 2; S.x = c - (c - S.x) * nw / old; S.y = c - (c - S.y) * nw / old; apply(); });
    let drag = null;
    view.addEventListener('pointerdown', (e) => { drag = { x: e.clientX - S.x, y: e.clientY - S.y }; view.setPointerCapture(e.pointerId); });
    view.addEventListener('pointermove', (e) => { if (!drag) return; S.x = e.clientX - drag.x; S.y = e.clientY - drag.y; apply(); });
    view.addEventListener('pointerup', () => { drag = null; });
    $('#hsUse', m).addEventListener('click', () => guard(async () => {
      const out = document.createElement('canvas'); out.width = 512; out.height = 512; const sc = S.base * S.z;
      out.getContext('2d').drawImage(imgEl, -S.x / sc, -S.y / sc, V / sc, V / sc, 0, 0, 512, 512);
      const data = out.toDataURL('image/jpeg', 0.88);
      if (data.length > 1.3e6) throw new Error('Photo too large after cropping');
      await onDone(data); close();
    }));
  });
}
