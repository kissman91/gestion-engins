/* ============ charts.js — graphiques canvas légers ============ */

const CHART_COLORS = ['#4f8cff','#2ecc8f','#ffb547','#ff6b7a','#a78bfa','#38bdf8','#f472b6','#facc15'];

function setupCanvas(canvas){
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 400;
  // NB : canvas.height se répercute sur l'attribut HTML, on fige la hauteur de référence
  if(!canvas.dataset.h) canvas.dataset.h = canvas.getAttribute('height') || '220';
  const h = parseInt(canvas.dataset.h) || 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function fmtShort(n){
  const a = Math.abs(n);
  if(a >= 1000000) return (n/1000000).toLocaleString('fr-FR',{maximumFractionDigits:1}) + ' M';
  if(a >= 1000) return (n/1000).toLocaleString('fr-FR',{maximumFractionDigits:0}) + ' k';
  return fmtNum(n);
}

/* ---------- Barres groupées (CA vs Dépenses par mois) ---------- */
function drawGroupedBar(canvas, labels, series){
  const { ctx, w, h } = setupCanvas(canvas);
  const padL = 52, padR = 10, padT = 14, padB = 30;
  const iw = w - padL - padR, ih = h - padT - padB;

  if(!labels.length){
    ctx.fillStyle = '#8f9cba'; ctx.font = '13px Segoe UI';
    ctx.textAlign = 'center'; ctx.fillText('Aucune donnée sur la période', w/2, h/2);
    return;
  }

  let max = 0;
  series.forEach(s => s.data.forEach(v => { if(v > max) max = v; }));
  if(max <= 0) max = 1;

  // grille
  ctx.strokeStyle = 'rgba(42,52,82,.7)'; ctx.fillStyle = '#8f9cba';
  ctx.font = '10.5px Segoe UI'; ctx.textAlign = 'right';
  const steps = 4;
  for(let i = 0; i <= steps; i++){
    const y = padT + ih - (ih * i / steps);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(fmtShort(max * i / steps), padL - 6, y + 3);
  }

  const groupW = iw / labels.length;
  const barW = Math.min(26, (groupW * 0.62) / series.length);

  labels.forEach((lab, i) => {
    const cx = padL + groupW * i + groupW / 2;
    series.forEach((s, j) => {
      const v = s.data[i] || 0;
      const bh = (v / max) * ih;
      const x = cx - (barW * series.length) / 2 + j * barW;
      const y = padT + ih - bh;
      ctx.fillStyle = s.color;
      roundRect(ctx, x, y, barW - 3, Math.max(bh, v > 0 ? 2 : 0), 3);
    });
    ctx.fillStyle = '#8f9cba'; ctx.font = '10.5px Segoe UI'; ctx.textAlign = 'center';
    ctx.fillText(lab, cx, h - 10);
  });
}

function roundRect(ctx, x, y, w2, h2, r){
  r = Math.min(r, w2/2, h2/2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w2, y, x + w2, y + h2, r);
  ctx.arcTo(x + w2, y + h2, x, y + h2, r);
  ctx.arcTo(x, y + h2, x, y, r);
  ctx.arcTo(x, y, x + w2, y, r);
  ctx.closePath();
  ctx.fill();
}

/* ---------- Barres horizontales (CA par engin) ---------- */
function drawHBar(canvas, items){
  const { ctx, w, h } = setupCanvas(canvas);
  if(!items.length){
    ctx.fillStyle = '#8f9cba'; ctx.font = '13px Segoe UI'; ctx.textAlign = 'center';
    ctx.fillText('Aucune donnée sur la période', w/2, h/2);
    return;
  }
  const padL = 4, padR = 90, padT = 6, padB = 6;
  const ih = h - padT - padB;
  const rowH = Math.min(34, ih / items.length);
  const max = Math.max(...items.map(i => i.v), 1);
  const iw = w - padL - padR;

  items.forEach((it, i) => {
    const y = padT + i * rowH;
    ctx.fillStyle = '#151b2b';
    roundRect(ctx, padL, y + 4, iw, rowH - 10, 6);
    ctx.fillStyle = it.color || CHART_COLORS[i % CHART_COLORS.length];
    const bw = Math.max(4, (it.v / max) * iw);
    roundRect(ctx, padL, y + 4, bw, rowH - 10, 6);
    ctx.fillStyle = '#e7ecf7'; ctx.font = '11.5px Segoe UI'; ctx.textAlign = 'left';
    ctx.fillText(clip(ctx, it.label, 120), padL + 8, y + rowH/2 + 4);
    ctx.fillStyle = '#8f9cba'; ctx.textAlign = 'right';
    ctx.fillText(money(it.v), w - 6, y + rowH/2 + 4);
  });
}

function clip(ctx, text, maxW){
  if(ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while(t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/* ---------- Donut (répartition des charges) ---------- */
function drawDonut(canvas, segments){
  const { ctx, w, h } = setupCanvas(canvas);
  const total = segments.reduce((s, x) => s + x.v, 0);
  const cx = w/2, cy = h/2, R = Math.min(w, h)/2 - 12, r = R * 0.62;

  if(total <= 0){
    ctx.fillStyle = '#8f9cba'; ctx.font = '13px Segoe UI'; ctx.textAlign = 'center';
    ctx.fillText('Aucune charge', w/2, h/2);
    return;
  }

  let angle = -Math.PI / 2;
  segments.forEach(seg => {
    if(seg.v <= 0) return;
    const sweep = (seg.v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    angle += sweep;
  });

  // trou
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#1a2135';
  ctx.fill();

  ctx.fillStyle = '#8f9cba'; ctx.font = '11px Segoe UI'; ctx.textAlign = 'center';
  ctx.fillText('Total', cx, cy - 8);
  ctx.fillStyle = '#e7ecf7'; ctx.font = 'bold 15px Segoe UI';
  ctx.fillText(fmtShort(total), cx, cy + 12);
}
