(() => {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function findValue(properties, names, matches) {
    const entries = Object.entries(properties || {});
    const normalize = (value) => String(value).toLocaleLowerCase().replace(/[\s_-]+/g, '');
    const found = entries.find(([key]) => names.includes(normalize(key))) || entries.find(([key]) => matches.test(String(key).toLocaleLowerCase()));
    if (!found || found[1] === null || found[1] === undefined) return '';
    return typeof found[1] === 'object' ? JSON.stringify(found[1]) : String(found[1]).trim();
  }

  function buttonHtml(filename, properties) {
    const owner = findValue(properties, ['owner', 'ownername', 'homeowner', 'เจ้าของบ้าน'], /owner|เจ้าของ/);
    const address = findValue(properties, ['address', 'ที่อยู่', 'ที่อยู่บ้าน', 'hseno', 'houseno', 'housenumber', 'เลขที่บ้าน', 'บ้านเลขที่'], /^address$|ที่อยู่|hse.?no|house.?no|บ้าน.*เลขที่|เลขที่บ้าน/);
    const photoSrc = 'DCIM/' + encodeURIComponent(filename);
    return `<button class="popup-export" type="button" data-print-photo data-photo-src="${escapeHtml(photoSrc)}" data-owner="${escapeHtml(owner)}" data-address="${escapeHtml(address)}">พิมพ์รูปพร้อมป้าย</button>`;
  }

  function openPrintPage(button) {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      window.alert('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาต Pop-ups สำหรับเว็บไซต์นี้');
      return;
    }
    printWindow.opener = null;
    const imageUrl = new URL(button.dataset.photoSrc, window.location.href).href;
    const owner = escapeHtml(button.dataset.owner || '—');
    const address = escapeHtml(button.dataset.address || '—');
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>รูปถ่ายพร้อมป้ายกำกับ</title><style>
      *{box-sizing:border-box}body{font-family:Arial,"Noto Sans Thai",sans-serif;color:#172b25;margin:0;padding:20px;background:#f4f6f4}.sheet{max-width:1000px;margin:0 auto;background:#fff;padding:24px;border:1px solid #d8e0dc}.photo-frame{position:relative;display:table;max-width:100%;margin:0 auto}.photo{display:block;max-width:100%;max-height:72vh;object-fit:contain}.label{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);width:max-content;max-width:calc(100% - 20px);padding:9px 14px;border:1px solid #263e34;border-radius:4px;background:rgba(255,255,255,.92);color:#172b25;display:grid;gap:4px;text-align:center}.item{display:flex;justify-content:center;gap:6px;font-size:16px;line-height:1.3}.item b{white-space:nowrap}.actions{margin-top:16px;text-align:center}.print-button{border:0;border-radius:6px;background:#176b57;color:white;padding:9px 20px;font-size:15px;cursor:pointer}
      @page{margin:12mm}@media print{body{padding:0;background:white}.sheet{max-width:none;border:0;padding:0}.photo{max-height:72vh}.label{-webkit-print-color-adjust:exact;print-color-adjust:exact}.actions{display:none}}
      </style></head><body><main class="sheet"><figure class="photo-frame"><img class="photo" src="${escapeHtml(imageUrl)}" alt="ภาพถ่าย"><figcaption class="label"><div class="item"><b>เจ้าของบ้าน:</b><span>${owner}</span></div><div class="item"><b>ที่อยู่:</b><span>${address}</span></div></figcaption></figure><div class="actions"><button class="print-button" type="button" onclick="window.print()">พิมพ์รูปพร้อมข้อความ</button></div></main></body></html>`);
    printWindow.document.close();
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-print-photo]');
    if (button) openPrintPage(button);
  });

  window.PhotoLabel = { buttonHtml };
})();
