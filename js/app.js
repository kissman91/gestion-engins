/* ============ app.js — UI, navigation, formulaires, rendu ============ */

/* ---------- Helpers DOM ---------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function toast(msg, err){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function optionHTML(list, valueKey, labelKey, selected){
  return list.map(x =>
    `<option value="${x[valueKey]}" ${x[valueKey] === selected ? 'selected' : ''}>${escapeHTML(x[labelKey])}</option>`
  ).join('');
}
function escapeHTML(s){
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/* Type de privilège exigé selon le type d'élément supprimé */
const DEL_PRIV = {
  travaux:'travaux', terrain:'travaux', charges:'charges', engin:'engins',
  employe:'parametres', activite:'parametres', prevention:'maintenance', facture:'factures'
};
function badge(cat){
  const c = CATEGORIES[cat] || CATEGORIES.autre;
  return `<span class="badge ${c.badge}">${c.label}</span>`;
}
/* Correspondance kind (appelé par l'UI) → collection (clé de DB) */
const KIND_TO_COLL = {
  travaux:'travaux', terrain:'travaux', charges:'charges',
  engin:'engins', employe:'employes', activite:'activites',
  prevention:'preventions', facture:'factures'
};
function del(id, kind){
  const labels = { travaux:'ce travail', charges:'cette charge', engin:'cet engin (et ses données ?)',
                   employe:'cet employé', activite:'cette activité', prevention:'cet intervalle' };
  const coll = KIND_TO_COLL[kind] || kind;
  if(!Array.isArray(DB[coll])) return;
  const mod = DEL_PRIV[kind] || kind;
  if(!requirePriv(mod + ':suppr')) return;
  const cible = DB[coll].find(x => x.id === id);
  if(!estProprietaire(coll, cible)){ toast('Vous ne pouvez supprimer que vos propres saisies', true); return; }
  if(!confirm('Supprimer ' + (labels[kind]||'cet élément') + ' ?')) return;
  DB[coll] = DB[coll].filter(x => x.id !== id);
  markDeleted(coll, id, (cible||{})._uid);
  saveDB(); renderAll(); toast('Supprimé ✓');
  triggerCloudPush();
}

/* Envoi cloud automatique immédiat en arrière-plan */
function triggerCloudPush(){
  if(syncReady()){
    syncPush().catch(e => console.warn('Push différé:', e.message));
  }
}

/* ---------- CSV ---------- */
function exportCSV(filename, headers, rows){
  const esc = v => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  };
  const csv = [headers.map(esc).join(';')]
    .concat(rows.map(r => r.map(esc).join(';')))
    .join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type:'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ============================================================
   ROUTAGE
   ============================================================ */
function currentView(){
  const h = location.hash.replace('#/','') || 'dashboard';
  return h.split('?')[0];
}
function route(){
  if(!requireAuth()) return;
  const v = currentView();
  $$('.view').forEach(s => s.classList.add('hidden'));
  const refus = !canMod(v, 'vue');
  const vue = refus ? 'acces-refuse' : (($('#view-' + v) ? v : defaultView()));
  $('#view-' + vue).classList.remove('hidden');
  $$('.nav a').forEach(a => a.classList.toggle('active', !refus && a.dataset.view === vue));
  if(refus){
    const m = PRIV_MODULES.find(x => x.key === v);
    $('#accesRefuseCle').textContent = 'Privilège manquant : « ' + (m ? m.label : v) + ' » — vue';
    $('#accesRetour').setAttribute('href', '#/' + defaultView());
  }
  renderView(vue);
}
window.addEventListener('hashchange', route);

/* Vue par défaut autorisée pour le compte connecté */
function defaultView(){
  if(canMod('dashboard', 'vue')) return 'dashboard';
  const m = PRIV_MODULES.find(x => canMod(x.key, 'vue'));
  return m ? m.key : 'acces-refuse';
}

/* Masque les boutons dont le compte n'a pas le privilège (attribut data-priv) */
function applyPrivVisibility(){
  $$('[data-priv]').forEach(el => el.classList.toggle('hidden', !can(el.dataset.priv)));
  // masque du menu les modules que le compte connecté ne peut pas voir
  $$('.nav a[data-view]').forEach(a => a.classList.toggle('hidden', !canMod(a.dataset.view, 'vue')));
}

function renderView(v){
  switch(v){
    case 'dashboard': renderDashboard(); break;
    case 'travaux': renderTravaux(); break;
    case 'terrain': renderTerrain(); break;
    case 'charges': renderCharges(); break;
    case 'factures': renderFactures(); break;
    case 'engins': renderEngins(); break;
    case 'maintenance': renderMaintenance(); break;
    case 'rapports': renderRapports(); break;
    case 'parametres': renderParametres(); break;
    case 'utilisateurs': renderUtilisateurs(); break;
  }
  applyPrivVisibility();
}
function renderAll(){
  const v = currentView();
  renderView(canMod(v, 'vue') ? v : defaultView());
  renderMini();
}
function renderMini(){
  $('#brandName').textContent = DB.settings.nom || 'Mon Entreprise';
  const u = currentUser();
  const chip = $('#userChip');
  if(u){
    chip.classList.remove('hidden');
    $('#ucNom').textContent = u.nom + ' · ' + (ROLES[u.role] ? ROLES[u.role].label : u.role);
    chip.title = 'Connecté en tant que ' + u.login;
  }else{
    chip.classList.add('hidden');
  }
  const k = computeKPIs(periodRange('month'));
  $('#periodSummaryMini').innerHTML =
    `Ce mois : <b class="${k.benefice>=0?'pos':'neg'}">${money(k.benefice)}</b><br>CA ${money(k.ca)}`;
}

/* ============================================================
   CONNEXION / PRIVILÈGES
   ============================================================ */
function requireAuth(){
  if(!utilisateurs().length){ openAuth('first'); return false; }
  if(!currentUser()){ openAuth('login'); return false; }
  closeAuth();
  return true;
}
/* Hash SHA-256 du code PIN maître propriétaire (17271978) */
const MASTER_PIN_HASH = '6857b12ffecf5f311e5cdbc0ab317b498352a4a6804b68b2aba41ec88dc1d4b6';
let _adminUnlocked = false;

async function checkMasterPin(pin){
  const str = String(pin || '').trim();
  if(!str) return false;
  if(typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined'){
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
    return hex.toLowerCase() === MASTER_PIN_HASH;
  }
  return false;
}

function openAuth(mode){
  const s = $('#authScreen');
  s.classList.remove('hidden');
  $('#formLogin').classList.toggle('hidden', mode !== 'login');
  $('#cloudBootBox').classList.toggle('hidden', mode !== 'first');
  $('#formAdminPin').classList.toggle('hidden', mode !== 'pin');
  $('#formFirstAdmin').classList.toggle('hidden', mode !== 'admin');
  $('#authTitle').textContent = mode === 'first' ? 'Récupérer vos comptes'
    : mode === 'pin' ? 'Espace Propriétaire'
    : mode === 'admin' ? 'Créer l\'administrateur' : 'Connexion';
  $('#authSub').textContent = mode === 'login'
    ? (DB.settings.nom || 'Mon Entreprise')
    : mode === 'pin' ? 'Code PIN requis pour installer l\'administrateur'
    : 'Première ouverture de l\'application sur cet appareil';
  $('#lgErr').classList.add('hidden');
  $('#faErr').classList.add('hidden');
  $('#cbErr').classList.add('hidden');
  $('#pinErr').classList.add('hidden');
  if(mode === 'first'){
    if($('#cbUrl') && !$('#cbUrl').value) $('#cbUrl').value = DB.settings.sbUrl || '';
    if($('#cbKey') && !$('#cbKey').value) $('#cbKey').value = DB.settings.sbKey || '';
  }
  setTimeout(() => {
    const f = mode === 'admin' ? $('#faNom') : mode === 'pin' ? $('#adminPinInput') : mode === 'first' ? $('#cbUrl') : $('#lgLogin');
    if(f) f.focus();
  }, 60);
}
function closeAuth(){ $('#authScreen').classList.add('hidden'); }
function authErr(sel, msg){
  const el = $(sel);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function doLogout(){
  stopRealtimeSync();   // coupe le WebSocket proprement
  logout();
  renderMini();
  openAuth('login');
  toast('Déconnecté ✓');
}
function afterLogin(){
  closeAuth();
  const v = currentView();
  if(!canMod(v, 'vue') && v !== defaultView()) location.hash = '#/' + defaultView();
  route();
  renderMini();
  const u = currentUser();
  toast('Bonjour ' + (u ? u.nom.split(' ')[0] : '') + ' 👋');
  // Démarre le WebSocket Realtime (puis tire les données initiales)
  if(syncReady()){
    startRealtimeSync();                    // WebSocket immédiat
    syncPull().then(r => {
      renderAll();
      if(r.added || r.updated) toast('☁️ Données et comptes à jour');
    }).catch(() => {});
  }
}

function initAuth(){
  $('#formLogin').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try{
      await login($('#lgLogin').value, $('#lgMdp').value, $('#lgRemember').checked);
      $('#lgMdp').value = '';
      afterLogin();
    }catch(err){
      authErr('#lgErr', err.message);
    }finally{
      btn.disabled = false;
    }
  });

  // Déverrouillage par Code PIN maître
  $('#btnShowPin').addEventListener('click', () => openAuth('pin'));
  $('#btnCancelPin').addEventListener('click', () => openAuth('first'));
  $('#formAdminPin').addEventListener('submit', async e => {
    e.preventDefault();
    const pin = $('#adminPinInput').value;
    const ok = await checkMasterPin(pin);
    if(!ok){
      return authErr('#pinErr', 'Code PIN maître incorrect');
    }
    _adminUnlocked = true;
    $('#adminPinInput').value = '';
    openAuth('admin');
    toast('Accès propriétaire accordé ✓');
  });

  $('#formFirstAdmin').addEventListener('submit', async e => {
    e.preventDefault();
    if(!_adminUnlocked){
      return authErr('#faErr', 'Action refusée : code PIN maître requis');
    }
    const nom = $('#faNom').value.trim();
    const id = $('#faLogin').value.trim();
    const mdp = $('#faMdp').value;
    if(!nom || !id) return authErr('#faErr', 'Renseignez nom et identifiant');
    if(mdp.length < 4) return authErr('#faErr', 'Mot de passe : 4 caractères minimum');
    if(mdp !== $('#faMdp2').value) return authErr('#faErr', 'Les deux mots de passe ne correspondent pas');
    if(!loginDispo(id)) return authErr('#faErr', 'Cet identifiant est déjà utilisé');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try{
      const u = await enregistrerUtilisateur({ nom, login:id, role:'admin', actif:true, mdp });
      _adminUnlocked = false;
      ouvrirSession(u, false);
      $('#formFirstAdmin').reset();
      afterLogin();
      toast('Administrateur créé ✓');
    }catch(err){
      authErr('#faErr', 'Erreur : ' + err.message);
    }finally{
      btn.disabled = false;
    }
  });

  $('#btnLogout').addEventListener('click', doLogout);
  $('#btnLogout2').addEventListener('click', doLogout);

  // --- appareil vierge : récupération des comptes depuis le cloud ---
  $('#btnShowCloud').addEventListener('click', () => openAuth('first'));
  $('#formCloudBoot').addEventListener('submit', async e => {
    e.preventDefault();
    const url = $('#cbUrl').value.trim();
    const key = $('#cbKey').value.trim();
    if(!url || !key) return authErr('#cbErr', 'Renseignez l\'URL du projet et sa clé anon');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    $('#cbStatus').textContent = 'Récupération des comptes…';
    try{
      DB.settings.sbUrl = url;
      DB.settings.sbKey = key;   // restent locales : jamais synchronisées
      saveDB();
      await syncPull();
      $('#cbStatus').textContent = '';
      if(!utilisateurs().length){
        return authErr('#cbErr', 'Aucun compte sur ce projet : créez d\'abord les comptes depuis l\'ordinateur de l\'administrateur, ou utilisez la création locale.');
      }
      openAuth('login');
      toast('Comptes récupérés ✓ — connectez-vous');
    }catch(err){
      $('#cbStatus').textContent = '';
      authErr('#cbErr', 'Échec : ' + err.message);
    }finally{
      btn.disabled = false;
    }
  });
}

/* Demande un privilège pour une action (retourne false si refusé) */
function requirePriv(cle){
  if(can(cle)) return true;
  toast('Privilège insuffisant (' + cle + ')', true);
  return false;
}

/* ============================================================
   TABLEAU DE BORD
   ============================================================ */
function currentPeriod(){
  const key = $('#periodSelect').value;
  return periodRange(key, $('#periodFrom').value, $('#periodTo').value);
}

function renderDashboard(){
  if(syncReady()) doSilentSync(false);
  const range = currentPeriod();
  const k = computeKPIs(range);

  const periodLabel = `${frDate(range[0])} → ${frDate(range[1])}`;

  const cards = [
    { cls:'accent-ca', label:'💼 Chiffre d\'affaires', value:money(k.ca), sub:`${k.nbTravaux} travaux · ${k.voyages} voyages · ${k.ouvertures} ouvertures` },
    { cls:'accent-dep', label:'💸 Dépenses totales', value:money(k.depenses), sub:`${k.nbCharges} opérations · carburant ${money(k.parCat.carburant)}` },
    { cls:'accent-ben', label:'📈 Bénéfice net', value:money(k.benefice), sub:`Marge : ${pct(k.marge)}`, cls2: k.benefice >= 0 ? 'pos' : 'neg' },
    { cls:'accent-fuel', label:'⛽ Carburant', value:fmtNum(k.litres,0) + ' L', sub:k.parCat.carburant ? money(k.parCat.carburant) : '—' },
    { cls:'', label:'🛢 Consommation', value:k.conso100 !== null ? fmtNum(k.conso100,1) + ' L/100km' : '—', sub:k.km ? fmtNum(k.km) + ' km parcourus' : 'Km non renseignés' },
    { cls:'', label:'🔧 Maintenance', value:money(k.parCat.maintenance), sub:`${pctOf(k.parCat.maintenance, k.depenses)} des dépenses` },
    { cls:'', label:'👥 Salaires', value:money(k.parCat.salaire), sub:`${pctOf(k.parCat.salaire, k.depenses)} des dépenses` },
    { cls:'', label:'🅿️ Coût au km', value:k.coutKm !== null ? money(k.coutKm) : '—', sub:'charges ÷ km' }
  ];

  $('#kpis').innerHTML = cards.map(c => `
    <div class="kpi ${c.cls}">
      <div class="k-label">${c.label}</div>
      <div class="k-value ${c.cls2||''}">${c.value}</div>
      <div class="k-sub">${c.sub}</div>
    </div>`).join('');

  // --- graphique mensuel (12 derniers mois glissants depuis la fin de période ---
  const months = lastMonths(range, 12);
  const labels = months.map(m => monthLabel(m));
  const caData = months.map(m => {
    const r = [m + '-01', m + '-31'];
    return filterTravaux(r).reduce((s,t) => s + trvMontant(t), 0);
  });
  const depData = months.map(m => {
    const r = [m + '-01', m + '-31'];
    return filterCharges(r).reduce((s,c) => s + (Number(c.montant)||0), 0);
  });
  drawGroupedBar($('#chartMonthly'), labels, [
    { name:'CA', color:'#2ecc8f', data:caData },
    { name:'Dépenses', color:'#ff6b7a', data:depData }
  ]);

  // --- donut répartition ---
  const segColors = { carburant:'#ffb547', maintenance:'#a78bfa', salaire:'#4f8cff', autre:'#8f9cba' };
  const segs = Object.keys(CATEGORIES).map(c => ({ c, label:CATEGORIES[c].label, v:k.parCat[c]||0, color:segColors[c] }));
  drawDonut($('#chartSplit'), segs);
  $('#chartSplitLegend').innerHTML = segs.map(s =>
    `<span><span class="dot" style="background:${s.color}"></span>${s.label} · ${money(s.v)}</span>`).join('');

  // --- CA par engin ---
  const items = DB.engins.map((e,i) => ({
    label: e.nom,
    v: computeKPIs(range, e.id).ca,
    color: CHART_COLORS[i % CHART_COLORS.length]
  })).filter(x => x.v > 0).sort((a,b) => b.v - a.v);
  drawHBar($('#chartEngins'), items);

  // --- objectif ---
  const obj = Number(DB.settings.objectifMensuel)||0;
  if(obj > 0){
    const now = new Date();
    const isCurrentMonth = range[0] <= today() && range[1] >= today();
    const caRef = isCurrentMonth
      ? computeKPIs(periodRange('month')).ca
      : k.ca;
    const ratio = Math.min(100, (caRef / obj) * 100);
    $('#objectifBox').innerHTML = `
      <div class="obj-bar"><div class="obj-fill" style="width:${ratio}%"></div></div>
      <div class="obj-legend">
        <span>${fmtNum(ratio,0)} % atteint</span>
        <span>${money(caRef)} / ${money(obj)}</span>
      </div>
      <div class="muted" style="margin-top:6px">Objectif mensuel — période affichée : ${periodLabel}</div>`;
  }else{
    $('#objectifBox').innerHTML = `<div class="muted">Aucun objectif défini. Configurez-le dans Paramètres.</div>`;
  }

  // --- indicateurs avancés ---
  const partCarb = pctOf(k.parCat.carburant, k.depenses);
  const caParKm = k.km > 0 ? money(k.ca / k.km) : '—';
  const top = items[0];
  $('#advKpis').innerHTML = [
    ['Part carburant', partCarb],
    ['CA par km', caParKm],
    ['Coût carburant/100km', k.conso100 !== null && k.parCat.carburant ? money((k.parCat.carburant / k.km) * 100) : '—'],
    ['Meilleur engin', top ? top.label : '—']
  ].map(([l,v]) => `<div class="mini-kpi"><div class="m-l">${l}</div><div class="m-v">${v}</div></div>`).join('');

  // --- tableau par engin ---
  const tbody = $('#tableEnginsKpi tbody');
  let totCa = 0, totDep = 0, totBen = 0, totKm = 0, totV = 0, totO = 0;
  const rowsEngins = DB.engins.map(e => {
    const ke = computeKPIs(range, e.id);
    totCa += ke.ca; totDep += ke.depenses; totBen += ke.benefice; totKm += ke.km;
    totV += ke.voyages; totO += ke.ouvertures;
    return `<tr>
      <td><a href="#/engins" data-open-engin="${e.id}" class="link-engin"><b>${escapeHTML(e.nom)}</b></a></td>
      <td class="num">${ke.voyages}</td>
      <td class="num">${ke.ouvertures}</td>
      <td class="num">${money(ke.ca)}</td>
      <td class="num">${money(ke.depenses)}</td>
      <td class="num ${ke.benefice>=0?'pos':'neg'}">${money(ke.benefice)}</td>
      <td class="num">${ke.km ? fmtNum(ke.km) : '—'}</td>
      <td class="num">${ke.conso100 !== null ? fmtNum(ke.conso100,1) : '—'}</td>
      <td class="num">${ke.coutKm !== null ? money(ke.coutKm) : '—'}</td>
      <td class="num">${pct(ke.marge)}</td>
    </tr>`;
  }).join('');
  const totalRow = DB.engins.length ? `
    <tr style="border-top:2px solid var(--border)">
      <td><b>Total</b></td><td class="num"><b>${totV}</b></td><td class="num"><b>${totO}</b></td>
      <td class="num"><b>${money(totCa)}</b></td><td class="num"><b>${money(totDep)}</b></td>
      <td class="num ${totBen>=0?'pos':'neg'}"><b>${money(totBen)}</b></td>
      <td class="num"><b>${totKm?fmtNum(totKm):'—'}</b></td>
      <td class="num"><b>${k.conso100!==null?fmtNum(k.conso100,1):'—'}</b></td>
      <td class="num"><b>${k.coutKm!==null?money(k.coutKm):'—'}</b></td>
      <td class="num"><b>${pct(k.marge)}</b></td>
    </tr>` : '';
  tbody.innerHTML = rowsEngins + totalRow;

  // clic sur un engin du tableau → fiche engin
  tbody.querySelectorAll('[data-open-engin]').forEach(a => {
    a.addEventListener('click', ev => {
      ev.preventDefault();
      pendingEngin = a.dataset.openEngin;
      location.hash = '#/engins';
      if(currentView() === 'engins') { const id = pendingEngin; pendingEngin = null; openEngin(id); }
    });
  });

  // --- activité récente ---
  const recent = []
    .concat(rowsPour('travaux').map(t => ({ date:t.date, type:'trv', obj:t })))
    .concat(rowsPour('charges').map(c => ({ date:c.date, type:'ch', obj:c })))
    .sort((a,b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 8);
  $('#recentList').innerHTML = recent.length ? recent.map(r => {
    if(r.type === 'trv'){
      const a = activiteById(r.obj.activiteId);
      return `<div class="recent-item">
        <span class="r-date">${frDate(r.obj.date)}</span>
        <span class="r-main">📋 ${escapeHTML(a?a.libelle:'Travail')} — ${r.obj.qte} ${escapeHTML(a?unitePlural(r.obj.qte, a.unite):'unités')} · ${escapeHTML(enginNom(r.obj.enginId))}</span>
        <span class="r-amt pos">+${money(trvMontant(r.obj))}</span>
      </div>`;
    }
    const c = r.obj;
    const detail = c.categorie === 'salaire' && c.employeId
      ? (employeById(c.employeId)||{}).nom || c.libelle || ''
      : (c.libelle || (c.typeMaint) || CATEGORIES[c.categorie].label);
    return `<div class="recent-item">
      <span class="r-date">${frDate(c.date)}</span>
      <span class="r-main">${badge(c.categorie)} ${escapeHTML(detail)}${c.enginId ? ' · ' + escapeHTML(enginNom(c.enginId)) : ''}</span>
      <span class="r-amt neg">-${money(c.montant)}</span>
    </div>`;
  }).join('') : '<div class="muted">Aucune activité enregistrée pour l\'instant.</div>';
}

function unitePlural(qte, unite){
  if(!unite) return 'unités';
  if(Number(qte) > 1 && !unite.endsWith('s')) return unite + 's';
  return unite;
}
function pctOf(v, total){
  if(!total || !isFinite(total) || !isFinite(v)) return '0 %';
  return fmtNum((Number(v)/Number(total))*100,1) + ' %';
}
function frDate(iso){
  if(!iso) return '—';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function monthLabel(m){
  const mois = ['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Août','Sep','Oct','Nov','Déc'];
  const [y,mm] = m.split('-');
  return mois[Number(mm)-1] + ' ' + y.slice(2);
}
function lastMonths(range, n){
  let endStr = range && range[1] ? range[1] : today();
  if(endStr > today()) endStr = today();
  const end = new Date(endStr + 'T00:00:00');
  const out = [];
  for(let i = n - 1; i >= 0; i--){
    const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  return out;
}

/* ============================================================
   TRAVAUX
   ============================================================ */
function fillTravauxSelects(){
  $('#trvActivite').innerHTML = optionHTML(DB.activites, 'id', 'libelle', $('#trvActivite').value);
  const enginOpts = '<option value="">— Choisir —</option>' + optionHTML(DB.engins, 'id', 'nom', $('#trvEngin').value);
  $('#trvEngin').innerHTML = enginOpts;
  $('#trvFilterEngin').innerHTML = '<option value="">Tous les engins</option>' + optionHTML(DB.engins, 'id', 'nom', $('#trvFilterEngin').value);
  const empOpts = '<option value="">—</option>' + optionHTML(DB.employes, 'id', 'nom', $('#trvConducteur').value);
  $('#trvConducteur').innerHTML = empOpts;
}

function updateTrvMontant(){
  const q = Number($('#trvQte').value)||0;
  const p = Number($('#trvPrix').value)||0;
  $('#trvMontant').value = fmtNum(q * p) + ' ' + (DB.settings.devise||'');
}
function syncTrvUnite(){
  const a = activiteById($('#trvActivite').value);
  if(a){
    $('#trvUnite').textContent = '(' + a.unite + ')';
    if(!window._prixTouched) $('#trvPrix').value = a.prix;
    updateTrvMontant();
  }
}

function renderTravaux(){
  fillTravauxSelects();
  if(!$('#trvDate').value) $('#trvDate').value = today();
  syncTrvUnite();

  const month = $('#trvFilterMonth').value;
  const engF = $('#trvFilterEngin').value;
  let rows = rowsPour('travaux').slice().sort((a,b) => a.date < b.date ? 1 : -1);
  if(month) rows = rows.filter(t => monthKey(t.date) === month);
  if(engF) rows = rows.filter(t => t.enginId === engF);

  $('#tableTravaux tbody').innerHTML = rows.map(t => {
    const a = activiteById(t.activiteId);
    return `<tr>
      <td>${frDate(t.date)}</td>
      <td>${escapeHTML(a?a.libelle:'—')}</td>
      <td>${escapeHTML(enginNom(t.enginId))}</td>
      <td class="num">${fmtNum(t.qte)}</td>
      <td class="num">${money(t.prixUnitaire)}</td>
      <td class="num pos">${money(trvMontant(t))}</td>
      <td>${escapeHTML(t.client||'')}</td>
      <td style="white-space:nowrap">
        <button class="btn-icon" data-priv="travaux:edit" title="Modifier" onclick="editTravaux('${t.id}')">✏️</button>
        <button class="btn-icon del" data-priv="travaux:suppr" title="Supprimer" onclick="del('${t.id}','travaux')">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">Aucun travail enregistré.</td></tr>';

  const total = rows.reduce((s,t) => s + trvMontant(t), 0);
  $('#travauxFoot').innerHTML = `<span>Total : <b class="pos">${money(total)}</b></span><span>${rows.length} travail(s)</span>`;
}

function editTravaux(id){
  const t = rowsPour('travaux').find(x => x.id === id);
  if(!t) return;
  fillTravauxSelects();
  $('#trvId').value = t.id;
  $('#trvDate').value = t.date;
  $('#trvActivite').value = t.activiteId;
  $('#trvEngin').value = t.enginId;
  $('#trvQte').value = t.qte;
  $('#trvClient').value = t.client || '';
  $('#trvNotes').value = t.notes || '';
  if(t.conducteur) $('#trvConducteur').value = t.conducteur;
  window._prixTouched = true;          // on ne re-écrit pas le prix de l'activité
  syncTrvUnite();
  $('#trvPrix').value = t.prixUnitaire;
  updateTrvMontant();
  $('#travauxFormTitle').textContent = 'Modifier le travail';
  $('#trvSubmit').textContent = '💾 Mettre à jour';
  $('#trvCancel').classList.remove('hidden');
  window.scrollTo({ top:0, behavior:'smooth' });
}

function resetTravauxForm(){
  $('#formTravaux').reset();
  $('#trvId').value = '';
  window._prixTouched = false;
  $('#trvDate').value = today();
  $('#travauxFormTitle').textContent = 'Enregistrer un travail';
  $('#trvSubmit').textContent = '➕ Enregistrer le travail';
  $('#trvCancel').classList.add('hidden');
  syncTrvUnite();
}

function initTravaux(){
  $('#formTravaux').addEventListener('submit', e => {
    e.preventDefault();
    if(!requirePriv('travaux:edit')) return;
    const id = $('#trvId').value;
    const data = {
      id: id || uid(),
      date: $('#trvDate').value,
      activiteId: $('#trvActivite').value,
      enginId: $('#trvEngin').value,
      qte: Number($('#trvQte').value)||0,
      prixUnitaire: Number($('#trvPrix').value)||0,
      conducteur: $('#trvConducteur').value,
      client: $('#trvClient').value.trim(),
      notes: $('#trvNotes').value.trim()
    };
    if(!data.date || !data.enginId || !data.activiteId){ toast('Remplissez les champs obligatoires', true); return; }
    if(id){
      const i = DB.travaux.findIndex(x => x.id === id);
      if(i >= 0) DB.travaux[i] = Object.assign(DB.travaux[i], data);
    }else{
      data._uid = (currentUser()||{}).id;   // attribution à l'utilisateur qui saisit
      DB.travaux.push(data);
    }
    saveDB(); resetTravauxForm(); renderAll();
    toast(id ? 'Travail mis à jour ✓' : 'Travail enregistré ✓');
    triggerCloudPush();
  });
  $('#trvCancel').addEventListener('click', resetTravauxForm);
  $('#trvQte').addEventListener('input', updateTrvMontant);
  $('#trvPrix').addEventListener('input', () => { window._prixTouched = true; updateTrvMontant(); });
  $('#trvActivite').addEventListener('change', () => { window._prixTouched = false; syncTrvUnite(); });
  $('#trvFilterMonth').addEventListener('input', renderTravaux);
  $('#trvFilterEngin').addEventListener('change', renderTravaux);
  $('#trvExport').addEventListener('click', () => {
    if(!requirePriv('global:export')) return;
    const rows = rowsPour('travaux').slice().sort((a,b) => a.date < b.date ? 1 : -1).map(t => {
      const a = activiteById(t.activiteId);
      return [t.date, a?a.libelle:'', a?a.unite:'', t.qte, t.prixUnitaire, trvMontant(t), enginNom(t.enginId), t.conducteur||'', t.client||'', t.notes||''];
    });
    exportCSV('travaux.csv', ['Date','Activité','Unité','Quantité','Prix unitaire','Montant','Engin','Conducteur','Client','Notes'], rows);
  });
}

/* ============================================================
   SAISIE RAPIDE (terrain / mobile)
   ============================================================ */
let terrainActId = null;

function renderTerrain(){
  // boutons d'activité (transfert / débardage / autres)
  if(!DB.activites.length){
    $('#trActBtns').innerHTML = '<p class="muted">Ajoutez d\'abord une activité (Paramètres).</p>';
  } else {
    if(!terrainActId || !activiteById(terrainActId)) terrainActId = DB.activites[0].id;
    $('#trActBtns').innerHTML = DB.activites.map(a => `
      <button type="button" class="terrain-act ${a.id === terrainActId ? 'active' : ''}" data-id="${a.id}">
        <span class="ta-name">${escapeHTML(a.libelle)}</span>
        <span class="ta-price">${money(a.prix)} / ${escapeHTML(a.unite)}</span>
      </button>`).join('');
    $$('#trActBtns .terrain-act').forEach(b => b.addEventListener('click', () => {
      terrainActId = b.dataset.id;
      const trP = $('#trPrix');
      if(trP) trP.dataset.touched = '';
      renderTerrain();
    }));
  }

  $('#trEngin').innerHTML = '<option value="">— Choisir —</option>' +
    optionHTML(DB.engins, 'id', 'nom', $('#trEngin').value);
  const condSel = $('#trConducteur');
  condSel.innerHTML = '<option value="">—</option>' +
    optionHTML(DB.employes, 'id', 'nom', condSel.value);
  const moiU = currentUser();
  if(moiU && moiU.employeId && !condSel.value && employeById(moiU.employeId)) condSel.value = moiU.employeId;
  $('#trClients').innerHTML = Array.from(new Set(rowsPour('travaux').map(t => (t.client||'').trim()).filter(Boolean)))
    .map(c => `<option value="${escapeHTML(c)}">`).join('');
  if(!$('#trDate').value) $('#trDate').value = today();

  const act = activiteById(terrainActId);
  $('#trUnite').textContent = act ? act.unite : '';
  const trP = $('#trPrix');
  if(trP && !trP.dataset.touched && act){
    trP.value = act.prix !== undefined && act.prix !== null ? act.prix : 0;
  }

  // chips de quantité rapide selon l'unité
  const chips = act && /ouverture/i.test(act.unite) ? [1,2,5,10] : [1,5,10,20];
  $('#trChips').innerHTML = chips.map(c => `<button type="button" class="chip" data-q="${c}">+${c}</button>`).join('');
  $$('#trChips .chip').forEach(b => b.addEventListener('click', () => {
    $('#trQte').value = (Number($('#trQte').value)||0) + Number(b.dataset.q);
    updateTerrainMontant();
  }));

  updateTerrainMontant();
  renderTerrainJour();

  const st = syncConf();
  const meta = syncMeta();
  $('#trStatus').textContent = syncReady()
    ? '☁️ Cloud connecté' + (meta.lastPull ? ' · synchro ' + new Date(meta.lastPull).toLocaleString('fr-FR') : '')
    : '📴 Hors ligne (données locales)';
}

function updateTerrainMontant(){
  const act = activiteById(terrainActId);
  const q = Number($('#trQte').value)||0;
  const trP = $('#trPrix');
  const p = (trP && trP.value !== '') ? Number(trP.value) : (act ? (Number(act.prix)||0) : 0);
  $('#trMontant').textContent = money(q * p);
}

function renderTerrainJour(){
  const d = $('#trDate').value || today();
  const rows = rowsPour('travaux').filter(t => t.date === d).sort((a,b) => (b._at||'') < (a._at||'') ? -1 : 1);
  const total = rows.reduce((s,t) => s + trvMontant(t), 0);
  $('#trJourRecap').innerHTML = `${rows.length} saisie(s) · <b class="pos">${money(total)}</b>`;
  $('#trJourList').innerHTML = rows.map(t => {
    const a = activiteById(t.activiteId);
    return `<div class="recent-item">
      <span class="r-ico">${a && /débardage|debardage|ouverture/i.test(a.libelle + a.unite) ? '🪵' : '🚛'}</span>
      <span class="r-main">${escapeHTML(a?a.libelle:'Travail')} — ${fmtNum(t.qte)} ${escapeHTML(a?a.unite:'unités')} · ${escapeHTML(enginNom(t.enginId))}${t.conducteur ? ' · ' + escapeHTML((employeById(t.conducteur)||{}).nom||'') : ''}</span>
      <span class="r-amt pos">${money(trvMontant(t))}</span>
      <button class="btn-icon del" data-priv="travaux:suppr" title="Supprimer" onclick="del('${t.id}','travaux')">🗑</button>
    </div>`;
  }).join('') || '<p class="muted">Aucune saisie aujourd\'hui.</p>';
}

function initTerrain(){
  const trP = $('#trPrix');
  if(trP){
    trP.addEventListener('input', () => {
      trP.dataset.touched = '1';
      updateTerrainMontant();
    });
  }

  $('#formTerrain').addEventListener('submit', e => {
    e.preventDefault();
    if(!requirePriv('terrain:edit')) return;
    const act = activiteById(terrainActId);
    const q = Number($('#trQte').value)||0;
    const trPrixElem = $('#trPrix');
    const prixChoisi = (trPrixElem && trPrixElem.value !== '') ? Number(trPrixElem.value) : (act ? Number(act.prix)||0 : 0);
    const data = {
      id: uid(),
      date: $('#trDate').value || today(),
      activiteId: terrainActId,
      enginId: $('#trEngin').value,
      qte: q,
      prixUnitaire: prixChoisi,
      conducteur: $('#trConducteur').value,
      client: $('#trClient').value.trim(),
      notes: 'saisie rapide'
    };
    if(!data.date || !data.enginId || !act){ toast('Choisissez engin et activité', true); return; }
    if(q <= 0){ toast('Quantité > 0', true); return; }
    data._uid = (currentUser()||{}).id;   // attribution à l'utilisateur qui saisit
    DB.travaux.push(data);
    saveDB();
    $('#trQte').value = 1;
    if(trPrixElem) trPrixElem.dataset.touched = '';
    renderTerrain(); renderMini();
    toast('Saisie enregistrée ✓');
    triggerCloudPush();
  });
  $('#trMinus').addEventListener('click', () => {
    $('#trQte').value = Math.max(0, (Number($('#trQte').value)||0) - 1);
    updateTerrainMontant();
  });
  $('#trPlus').addEventListener('click', () => {
    $('#trQte').value = (Number($('#trQte').value)||0) + 1;
    updateTerrainMontant();
  });
  $('#trQte').addEventListener('input', updateTerrainMontant);
  $('#trDate').addEventListener('change', renderTerrainJour);
  $('#trSync').addEventListener('click', async () => {
    if(!requirePriv('global:sync')) return;
    if(!syncReady()){ toast('Configurez Supabase dans Paramètres', true); return; }
    $('#trSync').disabled = true; $('#trStatus').textContent = '☁️ Synchronisation…';
    try{
      const r = await syncAll();
      renderTerrain();
      toast(`Synchro ✓ envoyé ${r.pushed.sent} · reçu ${r.pulled.added} · maj ${r.pulled.updated}`);
    }catch(err){
      $('#trStatus').textContent = '❌ ' + err.message;
      toast(err.message, true);
    }finally{ $('#trSync').disabled = false; }
  });
}

/* ============================================================
   FACTURES
   ============================================================ */
let facDraft = null;   // { numero, date, client, du, au, tva, note, lignes, totals, savedId }

function renderFactures(){
  const clients = Array.from(new Set(rowsPour('travaux').map(t => (t.client||'').trim()).filter(Boolean))).sort();
  $('#facClients').innerHTML = clients.map(c => `<option value="${escapeHTML(c)}">`).join('');
  if(!$('#facDate').value) $('#facDate').value = today();
  if(!$('#facDu').value){
    const now = new Date();
    const pad = x => String(x).padStart(2,'0');
    $('#facDu').value = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
    $('#facAu').value = today();
  }

  const q = ($('#facSearch').value||'').trim().toLowerCase();
  const list = rowsPour('factures').filter(f => !q || (f.client||'').toLowerCase().includes(q) || (f.numero||'').toLowerCase().includes(q))
    .sort((a,b) => a.date < b.date ? 1 : -1);
  $('#tableFactures tbody').innerHTML = list.map(f => `<tr>
    <td><b>${escapeHTML(f.numero)}</b></td>
    <td>${frDate(f.date)}</td>
    <td>${escapeHTML(f.client)}</td>
    <td class="num pos">${money((f.totals||{}).ttc)}</td>
    <td style="white-space:nowrap">
      <button class="btn-icon" title="Ouvrir" onclick="openFacture('${f.id}')">👁</button>
      <button class="btn-icon del" data-priv="factures:suppr" title="Supprimer" onclick="delFacture('${f.id}')">🗑</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="5" class="muted">Aucune facture.</td></tr>';

  if(!facDraft) renderFacturePreview();
}

function buildFactureDraft(){
  const client = $('#facClient').value.trim();
  if(!client){ toast('Choisissez un client', true); return null; }
  const du = $('#facDu').value || '1970-01-01';
  const au = $('#facAu').value || '2999-12-31';
  const lignes = factureLignes(client, du, au);
  if(!lignes.length){
    toast('Aucun travail de ' + client + ' sur la période', true);
    return null;
  }
  const tva = Number($('#facTva').value)||0;
  facDraft = {
    numero: nextFactureNumero(),
    date: $('#facDate').value || today(),
    client, du, au, tva,
    note: $('#facNote').value.trim(),
    lignes,
    totals: factureTotals(lignes, tva),
    savedId: null
  };
  return facDraft;
}

function factureHTML(f){
  const s = DB.settings;
  return `
  <div class="fac-head">
    <div class="fac-ent">
      <div class="fac-logo">🚜</div>
      <div>
        <div class="fac-nom">${escapeHTML(s.nom||'Mon Entreprise')}</div>
        <div class="fac-sub">Transferts &amp; Débardage</div>
      </div>
    </div>
    <div class="fac-meta">
      <div class="fac-num">${escapeHTML(f.numero)}</div>
      <div>Date : <b>${frDate(f.date)}</b></div>
      <div>Période : ${frDate(f.du)} → ${frDate(f.au)}</div>
    </div>
  </div>
  <div class="fac-client">
    <span class="fac-lbl">Facturé à</span>
    <div class="fac-client-nom">${escapeHTML(f.client)}</div>
  </div>
  <table class="fac-lignes">
    <thead><tr>
      <th>Désignation</th><th>Engin</th><th class="num">Période</th>
      <th class="num">Qté</th><th class="num">P.U.</th><th class="num">Montant</th>
    </tr></thead>
    <tbody>
      ${f.lignes.map(l => `<tr>
        <td>${escapeHTML(l.libelle)}</td>
        <td>${escapeHTML(enginNom(l.enginId))}</td>
        <td class="num fac-small">${l.du === l.au ? frDate(l.du) : frDate(l.du) + ' → ' + frDate(l.au)}</td>
        <td class="num">${fmtNum(l.qte)} ${escapeHTML(l.unite)}</td>
        <td class="num">${money(l.prix)}</td>
        <td class="num">${money(l.montant)}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot>
      <tr><td colspan="5" class="num">Total HT</td><td class="num">${money(f.totals.ht)}</td></tr>
      ${f.tva > 0 ? `<tr><td colspan="5" class="num">TVA ${fmtNum(f.tva,1)} %</td><td class="num">${money(f.totals.tva)}</td></tr>` : ''}
      <tr class="fac-total"><td colspan="5" class="num">Total TTC</td><td class="num">${money(f.totals.ttc)}</td></tr>
    </tfoot>
  </table>
  <div class="fac-lettre">Arrêtée la présente facture à la somme de <b>${montantEnLettres(f.totals.ttc)}</b>.</div>
  ${f.note ? `<div class="fac-note">${escapeHTML(f.note)}</div>` : ''}
  <div class="fac-sign">
    <div>Signature / cachet</div>
    <div class="fac-sign-box"></div>
  </div>`;
}

function renderFacturePreview(){
  const box = $('#facturePreview');
  if(!facDraft){
    box.innerHTML = '<p class="muted">Choisissez un client et une période, puis « Aperçu ».</p>';
    $('#facPreviewNum').textContent = 'aperçu';
    return;
  }
  $('#facPreviewNum').textContent = facDraft.numero + (facDraft.savedId ? ' · enregistrée' : ' · brouillon');
  box.innerHTML = factureHTML(facDraft);
}

function openFacture(id){
  const f = rowsPour('factures').find(x => x.id === id);
  if(!f) return;
  facDraft = Object.assign({}, f, { savedId: f.id });
  $('#facFormCard').classList.add('hidden');
  renderFacturePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function delFacture(id){
  if(!requirePriv('factures:suppr')) return;
  const cible = DB.factures.find(x => x.id === id);
  if(!estProprietaire('factures', cible)){ toast('Vous ne pouvez supprimer que vos propres factures', true); return; }
  if(!confirm('Supprimer cette facture ?')) return;
  DB.factures = DB.factures.filter(x => x.id !== id);
  if(facDraft && facDraft.savedId === id) facDraft = null;
  markDeleted('factures', id, (cible||{})._uid);
  saveDB(); renderAll(); toast('Facture supprimée ✓');
  triggerCloudPush();
}

function initFactures(){
  $('#facNew').addEventListener('click', () => {
    facDraft = null;
    $('#formFacture').reset();
    const now = new Date();
    const pad = x => String(x).padStart(2,'0');
    $('#facDate').value = today();
    $('#facDu').value = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
    $('#facAu').value = today();
    $('#facFormCard').classList.remove('hidden');
    renderFacturePreview();
    $('#facClient').focus();
  });
  $('#facCancel').addEventListener('click', () => {
    facDraft = null;
    $('#facFormCard').classList.add('hidden');
    renderFacturePreview();
  });
  $('#formFacture').addEventListener('submit', e => {
    e.preventDefault();
    if(!requirePriv('factures:edit')) return;
    if(buildFactureDraft()) renderFacturePreview();
  });
  $('#facSearch').addEventListener('input', renderFactures);

  $('#facSave').addEventListener('click', () => {
    if(!requirePriv('factures:edit')) return;
    if(!facDraft){ toast('Générez d\'abord un aperçu', true); return; }
    if(facDraft.savedId){ toast('Facture déjà enregistrée'); return; }
    const f = Object.assign({}, facDraft, { id: uid(), _at: new Date().toISOString() });
    delete f.savedId;
    f._uid = (currentUser()||{}).id;   // attribution à l'utilisateur qui saisit
    DB.factures.push(f);
    DB.settings.factureCounter = (Number(DB.settings.factureCounter)||0) + 1;
    facDraft.savedId = f.id;
    facDraft.numero = f.numero;
    saveDB(); renderAll();
    toast('Facture ' + f.numero + ' enregistrée ✓');
  });

  $('#facPrint').addEventListener('click', () => {
    if(!facDraft){ toast('Générez d\'abord un aperçu', true); return; }
    const el = $('#facturePreview');
    const prev = el.innerHTML;
    // zone d'impression isolée
    const w = window.open('', '_blank');
    if(!w){ toast('Autorisez les pop-up pour imprimer', true); return; }
    w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
      <title>${facDraft.numero} — ${escapeHTML(facDraft.client)}</title>
      <style>
        body{font-family:'Segoe UI',system-ui,sans-serif;color:#111;margin:28px;font-size:13.5px}
        .fac-head{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #1a2135;padding-bottom:14px}
        .fac-ent{display:flex;gap:12px;align-items:center}
        .fac-logo{font-size:34px}
        .fac-nom{font-size:19px;font-weight:700}
        .fac-sub{color:#666;font-size:12px}
        .fac-meta{text-align:right;font-size:13px;line-height:1.6}
        .fac-num{font-size:20px;font-weight:800;letter-spacing:.5px;color:#1a2135}
        .fac-client{margin:18px 0 10px}
        .fac-lbl{font-size:11px;text-transform:uppercase;color:#888;letter-spacing:1px}
        .fac-client-nom{font-size:16px;font-weight:700}
        .fac-lignes{width:100%;border-collapse:collapse;margin-top:8px}
        .fac-lignes th{background:#1a2135;color:#fff;text-align:left;padding:7px 9px;font-size:11.5px;text-transform:uppercase}
        .fac-lignes th.num,.fac-lignes td.num{text-align:right}
        .fac-lignes td{padding:7px 9px;border-bottom:1px solid #e2e6ee}
        .fac-lignes tfoot td{font-weight:700;border-top:2px solid #1a2135}
        .fac-lignes .fac-total td{font-size:15px;background:#eef2fb}
        .fac-small{font-size:11.5px;color:#666}
        .fac-lettre{margin-top:16px;padding:10px 12px;background:#f4f6fb;border-left:4px solid #1a2135;font-size:13px}
        .fac-note{margin-top:10px;color:#555;font-style:italic}
        .fac-sign{margin-top:44px;display:flex;justify-content:space-between;align-items:flex-end;font-size:12.5px;color:#444}
        .fac-sign-box{width:190px;height:76px;border:1px dashed #999;margin-left:auto}
        @page{size:A4;margin:16mm}
        @media print{body{margin:0}}
      </style></head><body>${factureHTML(facDraft)}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); }, 350);
  });
}

/* ============================================================
   CHARGES
   ============================================================ */
function syncChargeFields(){
  const cat = $('#chCategorie').value;
  $$('#formCharges .cat-carburant').forEach(el => el.classList.toggle('hidden', cat !== 'carburant'));
  $$('#formCharges .cat-maintenance').forEach(el => el.classList.toggle('hidden', cat !== 'maintenance'));
  $$('#formCharges .cat-salaire').forEach(el => el.classList.toggle('hidden', cat !== 'salaire'));
  $('#chLibelleWrap').classList.toggle('hidden', cat === 'carburant' || cat === 'salaire');

  const enginRequired = cat === 'carburant' || cat === 'maintenance';
  $('#chEngin').required = enginRequired;
}

function renderCharges(){
  $('#chTypeMaint').innerHTML = '<option value="">—</option>' + optionHTML(DB.preventions, 'id', 'libelle', $('#chTypeMaint').value);
  if(!$('#chTypeMaint').value && DB.preventions[0]) $('#chTypeMaint').value = DB.preventions[0].id;
  $('#chEmploye').innerHTML = '<option value="">—</option>' + optionHTML(DB.employes, 'id', 'nom', $('#chEmploye').value);
  $('#chEngin').innerHTML = '<option value="">— Aucun / global —</option>' + optionHTML(DB.engins, 'id', 'nom', $('#chEngin').value);
  $('#chFilterEngin').innerHTML = '<option value="">Tous les engins</option>' + optionHTML(DB.engins, 'id', 'nom', $('#chFilterEngin').value);
  if(!$('#chDate').value) $('#chDate').value = today();
  syncChargeFields();

  const month = $('#chFilterMonth').value;
  const catF = $('#chFilterCat').value;
  const engF = $('#chFilterEngin').value;
  let rows = rowsPour('charges').slice().sort((a,b) => a.date < b.date ? 1 : -1);
  if(month) rows = rows.filter(c => monthKey(c.date) === month);
  if(catF) rows = rows.filter(c => c.categorie === catF);
  if(engF) rows = rows.filter(c => c.enginId === engF);

  $('#tableCharges tbody').innerHTML = rows.map(c => `<tr>
    <td>${frDate(c.date)}</td>
    <td>${badge(c.categorie)}</td>
    <td>${escapeHTML(chargeDetail(c))}</td>
    <td>${c.enginId ? escapeHTML(enginNom(c.enginId)) : '<span class="muted">Global</span>'}</td>
    <td class="num neg">${money(c.montant)}</td>
    <td style="white-space:nowrap">
      <button class="btn-icon" data-priv="charges:edit" title="Modifier" onclick="editCharge('${c.id}')">✏️</button>
      <button class="btn-icon del" data-priv="charges:suppr" title="Supprimer" onclick="del('${c.id}','charges')">🗑</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune charge enregistrée.</td></tr>';

  const total = rows.reduce((s,c) => s + (Number(c.montant)||0), 0);
  const parCat = {};
  rows.forEach(c => { parCat[c.categorie] = (parCat[c.categorie]||0) + (Number(c.montant)||0); });
  $('#chargesFoot').innerHTML =
    `<span>Total : <b class="neg">${money(total)}</b></span>` +
    Object.keys(parCat).map(k => `<span>${CATEGORIES[k].label} : ${money(parCat[k])}</span>`).join('');

  applyPresetMaint();
}

function chargeDetail(c){
  if(c.categorie === 'carburant') return `${fmtNum(c.litres,1)} L × ${money(c.prixLitre)}${c.km ? ' · ' + fmtNum(c.km) + ' km' : ''}`;
  if(c.categorie === 'salaire'){
    const e = c.employeId ? employeById(c.employeId) : null;
    return `${e ? escapeHTML(e.nom) : escapeHTML(c.libelle||'Salaire')}${c.mois ? ' · ' + c.mois : ''}`;
  }
  if(c.categorie === 'maintenance') return `${escapeHTML(c.typeMaint||c.libelle||'Intervention')}${c.prestataire ? ' · ' + escapeHTML(c.prestataire) : ''}`;
  return escapeHTML(c.libelle || '—');
}

function editCharge(id){
  const c = rowsPour('charges').find(x => x.id === id);
  if(!c) return;
  renderCharges();
  $('#chId').value = c.id;
  $('#chDate').value = c.date;
  $('#chCategorie').value = c.categorie;
  $('#chEngin').value = c.enginId || '';
  $('#chLibelle').value = c.libelle || '';
  $('#chLitres').value = c.litres || '';
  $('#chPrixLitre').value = c.prixLitre || '';
  $('#chKm').value = c.km || '';
  if(c.typeMaint){
    const p = DB.preventions.find(p => p.libelle === c.typeMaint);
    $('#chTypeMaint').value = p ? p.id : '';
  }
  $('#chPresta').value = c.prestataire || '';
  $('#chEmploye').value = c.employeId || '';
  $('#chMois').value = c.mois || '';
  $('#chMontant').value = c.montant;
  $('#chNotes').value = c.notes || '';
  syncChargeFields();
  $('#chargesFormTitle').textContent = 'Modifier la charge';
  $('#chSubmit').textContent = '💾 Mettre à jour';
  $('#chCancel').classList.remove('hidden');
  window.scrollTo({ top:0, behavior:'smooth' });
}

function resetChargeForm(){
  $('#formCharges').reset();
  $('#chId').value = '';
  $('#chDate').value = today();
  $('#chargesFormTitle').textContent = 'Enregistrer une charge';
  $('#chSubmit').textContent = '➕ Enregistrer la charge';
  $('#chCancel').classList.add('hidden');
  renderCharges();
}

function initCharges(){
  $('#chCategorie').addEventListener('change', syncChargeFields);

  const autoMontant = () => {
    if($('#chId').value) return;
    const l = Number($('#chLitres').value), p = Number($('#chPrixLitre').value);
    if($('#chCategorie').value === 'carburant' && l > 0 && p > 0) $('#chMontant').value = Math.round(l * p * 100) / 100;
  };
  $('#chLitres').addEventListener('input', autoMontant);
  $('#chPrixLitre').addEventListener('input', autoMontant);

  $('#formCharges').addEventListener('submit', e => {
    e.preventDefault();
    if(!requirePriv('charges:edit')) return;
    const cat = $('#chCategorie').value;
    const id = $('#chId').value;
    const prev = id ? (rowsPour('charges').find(x => x.id === id) || {}) : {};

    const data = Object.assign({}, prev, {
      id: id || uid(),
      date: $('#chDate').value,
      categorie: cat,
      enginId: $('#chEngin').value || null,
      montant: Number($('#chMontant').value)||0,
      notes: $('#chNotes').value.trim()
    });

    if(cat === 'carburant'){
      data.litres = Number($('#chLitres').value)||0;
      data.prixLitre = Number($('#chPrixLitre').value)||0;
      data.km = $('#chKm').value !== '' ? Number($('#chKm').value) : null;
      if(!data.enginId){ toast('Le carburant doit être rattaché à un engin', true); return; }
      if(!data.litres){ toast('Indiquez les litres', true); return; }
      if(!data.montant) data.montant = Math.round(data.litres * data.prixLitre * 100) / 100;
    }else if(cat === 'maintenance'){
      const p = DB.preventions.find(x => x.id === $('#chTypeMaint').value);
      data.typeMaint = p ? p.libelle : ($('#chLibelle').value.trim() || 'Intervention');
      data.libelle = $('#chLibelle').value.trim();
      data.prestataire = $('#chPresta').value.trim();
      data.km = $('#chKm').value !== '' ? Number($('#chKm').value) : null;
      if(!data.enginId){ toast('La maintenance doit être rattachée à un engin', true); return; }
    }else if(cat === 'salaire'){
      data.employeId = $('#chEmploye').value || null;
      data.mois = $('#chMois').value || null;
      data.libelle = $('#chLibelle').value.trim() || 'Salaire';
    }else{
      data.libelle = $('#chLibelle').value.trim() || 'Autre charge';
    }

    if(!data.date || !data.montant){ toast('Date et montant obligatoires', true); return; }

    if(id){
      const i = DB.charges.findIndex(x => x.id === id);
      if(i >= 0) DB.charges[i] = data;
    }else{
      data._uid = (currentUser()||{}).id;   // attribution à l'utilisateur qui saisit
      DB.charges.push(data);
    }
    saveDB(); resetChargeForm(); renderAll();
    toast(id ? 'Charge mise à jour ✓' : 'Charge enregistrée ✓');
    triggerCloudPush();
  });

  $('#chCancel').addEventListener('click', resetChargeForm);
  $('#chFilterMonth').addEventListener('input', renderCharges);
  $('#chFilterCat').addEventListener('change', renderCharges);
  $('#chFilterEngin').addEventListener('change', renderCharges);
  $('#chExport').addEventListener('click', () => {
    if(!requirePriv('global:export')) return;
    const rows = rowsPour('charges').slice().sort((a,b) => a.date < b.date ? 1 : -1).map(c =>
      [c.date, CATEGORIES[c.categorie].label, chargeDetail(c).replace(/<[^>]+>/g,''), c.enginId?enginNom(c.enginId):'Global', c.montant, c.km||'', c.litres||'', c.notes||'']);
    exportCSV('charges.csv', ['Date','Catégorie','Détail','Engin','Montant','Km','Litres','Notes'], rows);
  });
}

/* ============================================================
   ENGINS
   ============================================================ */
let pendingEngin = null;
function renderEngins(){
  const range = ['1970-01-01','2999-12-31'];
  $('#enginGrid').innerHTML = DB.engins.map(e => {
    const k = computeKPIs(range, e.id);
    return `<div class="engin-card" onclick="openEngin('${e.id}')">
      <div class="e-head">
        <div>
          <div class="e-nom">${escapeHTML(e.nom)}</div>
          <div class="e-meta">${escapeHTML(e.type||'')} ${e.immat ? '· ' + escapeHTML(e.immat) : ''} · ${fmtNum(currentKm(e))} km</div>
        </div>
        <span class="badge ${k.benefice>=0?'b-vert':'b-rouge'}">${k.benefice>=0?'✓':'✗'} rentable</span>
      </div>
      <div class="e-kpis">
        <div class="e-kpi"><div class="v">${fmtNum(k.voyages)}</div><div class="l">Voyages</div></div>
        <div class="e-kpi"><div class="v">${fmtNum(k.ouvertures)}</div><div class="l">Ouvertures</div></div>
        <div class="e-kpi"><div class="v">${k.conso100!==null?fmtNum(k.conso100,1):'—'}</div><div class="l">L/100km</div></div>
      </div>
      <div class="e-kpis" style="grid-template-columns:1fr 1fr">
        <div class="e-kpi"><div class="v pos">${money(k.ca)}</div><div class="l">CA</div></div>
        <div class="e-kpi"><div class="v ${k.benefice>=0?'pos':'neg'}">${money(k.benefice)}</div><div class="l">Bénéfice</div></div>
      </div>
      <div class="e-actions">
        <button class="btn-icon" data-priv="engins:edit" title="Modifier" onclick="event.stopPropagation();editEngin('${e.id}')">✏️</button>
        <button class="btn-icon del" data-priv="engins:suppr" title="Supprimer" onclick="event.stopPropagation();del('${e.id}','engin')">🗑</button>
      </div>
    </div>`;
  }).join('') || '<div class="muted">Aucun engin. Cliquez sur « Nouvel engin » pour commencer.</div>';

  $('#enginDetail').innerHTML = '';
  if(pendingEngin){
    const id = pendingEngin;
    pendingEngin = null;
    openEngin(id);
  }
}

function openEngin(id){
  const e = enginById(id);
  if(!e) return;
  const range = ['1970-01-01','2999-12-31'];
  const k = computeKPIs(range, e.id);
  const trav = rowsPour('travaux').filter(t => t.enginId === e.id).sort((a,b) => a.date < b.date ? 1 : -1).slice(0,10);
  const char = rowsPour('charges').filter(c => c.enginId === e.id).sort((a,b) => a.date < b.date ? 1 : -1).slice(0,10);
  const consoRef = Number(e.consoRef)||null;
  const ecart = (k.conso100 !== null && consoRef) ? ((k.conso100 - consoRef) / consoRef) * 100 : null;

  $('#enginDetail').innerHTML = `
    <div class="card" style="border-left:4px solid var(--primary)">
      <div class="card-head">
        <h2>🔎 ${escapeHTML(e.nom)} ${e.immat ? '<span class="card-sub">'+escapeHTML(e.immat)+'</span>' : ''}</h2>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('enginDetail').innerHTML=''">✖ Fermer</button>
      </div>
      <div class="mini-kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        <div class="mini-kpi"><div class="m-l">CA total</div><div class="m-v pos">${money(k.ca)}</div></div>
        <div class="mini-kpi"><div class="m-l">Charges</div><div class="m-v neg">${money(k.depenses)}</div></div>
        <div class="mini-kpi"><div class="m-l">Bénéfice net</div><div class="m-v ${k.benefice>=0?'pos':'neg'}">${money(k.benefice)}</div></div>
        <div class="mini-kpi"><div class="m-l">Marge</div><div class="m-v">${pct(k.marge)}</div></div>
        <div class="mini-kpi"><div class="m-l">Km parcourus</div><div class="m-v">${k.km?fmtNum(k.km):'—'}</div></div>
        <div class="mini-kpi"><div class="m-l">Consommation</div><div class="m-v">${k.conso100!==null?fmtNum(k.conso100,1)+' L':'—'}</div></div>
        <div class="mini-kpi"><div class="m-l">Réf. engin</div><div class="m-v">${consoRef?fmtNum(consoRef,1)+' L':'—'}</div></div>
        <div class="mini-kpi"><div class="m-l">Écart conso.</div><div class="m-v ${ecart===null?'':(ecart<=0?'pos':'neg')}">${ecart===null?'—':(ecart>0?'+':'')+fmtNum(ecart,1)+' %'}</div></div>
        <div class="mini-kpi"><div class="m-l">Coût carburant/100km</div><div class="m-v">${(k.parCat.carburant&&k.km)?money(k.parCat.carburant/k.km*100):'—'}</div></div>
        <div class="mini-kpi"><div class="m-l">CA par ouverture</div><div class="m-v">${k.ouvertures?money(k.caOuvertures/k.ouvertures):'—'}</div></div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div>
          <h2>Derniers travaux</h2>
          <div class="recent">${trav.map(t => {
            const a = activiteById(t.activiteId);
            return `<div class="recent-item"><span class="r-date">${frDate(t.date)}</span>
              <span class="r-main">${escapeHTML(a?a.libelle:'')} · ${t.qte} ${escapeHTML(a?a.unite:'')}</span>
              <span class="r-amt pos">${money(trvMontant(t))}</span></div>`;
          }).join('') || '<div class="muted">Aucun</div>'}</div>
        </div>
        <div>
          <h2>Dernières charges</h2>
          <div class="recent">${char.map(c => `<div class="recent-item">
            <span class="r-date">${frDate(c.date)}</span>
            <span class="r-main">${badge(c.categorie)} ${escapeHTML(chargeDetail(c))}</span>
            <span class="r-amt neg">${money(c.montant)}</span></div>`).join('') || '<div class="muted">Aucune</div>'}</div>
        </div>
      </div>
    </div>`;
  $('#enginDetail').scrollIntoView({ behavior:'smooth', block:'start' });
}

function editEngin(id){
  const e = enginById(id);
  if(!e) return;
  $('#enginFormCard').classList.remove('hidden');
  $('#enginFormTitle').textContent = 'Modifier l\'engin';
  $('#engId').value = e.id;
  $('#engNom').value = e.nom;
  $('#engImmat').value = e.immat || '';
  $('#engType').value = e.type || '';
  $('#engConducteur').value = e.conducteur || '';
  $('#engDate').value = e.dateService || '';
  $('#engKmDepart').value = e.kmDepart || 0;
  $('#engConsoRef').value = e.consoRef || '';
  $('#engPrixAchat').value = e.prixAchat || '';
  window.scrollTo({ top:0, behavior:'smooth' });
}
function resetEnginForm(){
  $('#formEngin').reset();
  $('#engId').value = '';
  $('#enginFormCard').classList.add('hidden');
  $('#enginFormTitle').textContent = 'Nouvel engin';
}

function initEngins(){
  $('#btnNewEngin').addEventListener('click', () => {
    resetEnginForm();
    $('#enginFormCard').classList.remove('hidden');
    $('#engNom').focus();
    window.scrollTo({ top:0, behavior:'smooth' });
  });
  $('#engCancel').addEventListener('click', resetEnginForm);
  $('#formEngin').addEventListener('submit', e => {
    e.preventDefault();
    if(!requirePriv('engins:edit')) return;
    const id = $('#engId').value;
    const data = {
      id: id || uid(),
      nom: $('#engNom').value.trim(),
      immat: $('#engImmat').value.trim(),
      type: $('#engType').value.trim(),
      conducteur: $('#engConducteur').value || null,
      dateService: $('#engDate').value || null,
      kmDepart: Number($('#engKmDepart').value)||0,
      consoRef: Number($('#engConsoRef').value)||null,
      prixAchat: Number($('#engPrixAchat').value)||null
    };
    if(!data.nom){ toast('Nom obligatoire', true); return; }  if(id){
    const i = DB.engins.findIndex(x => x.id === id);
    if(i >= 0) DB.engins[i] = data;
  }else{
    DB.engins.push(data);
  }
    saveDB(); resetEnginForm(); renderAll();
    toast(id ? 'Engin mis à jour ✓' : 'Engin ajouté ✓');
  });
}

/* ============================================================
   MAINTENANCE
   ============================================================ */
function renderMaintenance(){
  const ech = echeancesMaint();

  const critiques = ech.filter(x => x.etat === 'critique');
  const attentions = ech.filter(x => x.etat === 'attention');
  let html = '';
  if(!critiques.length && !attentions.length){
    html = '<div class="alerte ok"><div class="a-txt"><b>✓ Tout est à jour</b>Aucune échéance dépassée ou imminente.</div></div>';
  }
  critiques.forEach(x => {
    html += `<div class="alerte critique">
      <div class="a-txt"><b>⚠ ${escapeHTML(x.engin.nom)} — ${escapeHTML(x.prev.libelle)}</b>
      ${x.jours !== null && x.jours <= 0 ? `Date dépassée de ${-x.jours} j · ` : ''}${x.kmRestant !== null && x.kmRestant <= 0 ? `${fmtNum(-x.kmRestant)} km de dépassement` : ''}${x.jours !== null && x.jours > 0 ? `Dans ${x.jours} j · ` : ''}${x.kmRestant !== null && x.kmRestant > 0 ? `reste ${fmtNum(x.kmRestant)} km` : ''}</div>
      <a class="btn btn-sm btn-primary" href="#/charges" data-preset-engin="${x.engin.id}" data-preset-prev="${x.prev.id}">➕ Intervention</a>
    </div>`;
  });
  attentions.forEach(x => {
    html += `<div class="alerte">
      <div class="a-txt"><b>🕐 ${escapeHTML(x.engin.nom)} — ${escapeHTML(x.prev.libelle)}</b>
      ${x.jours !== null ? `Prévu le ${frDate(x.nextDate)} (${x.jours} j) · ` : ''}${x.kmRestant !== null ? `ou à ${fmtNum(x.nextKm)} km (reste ${fmtNum(x.kmRestant)})` : ''}</div>
      <a class="btn btn-sm btn-ghost" href="#/charges" data-preset-engin="${x.engin.id}" data-preset-prev="${x.prev.id}">➕ Intervention</a>
    </div>`;
  });
  $('#alertesMaint').innerHTML = html;
  $('#alertesMaint').querySelectorAll('[data-preset-engin]').forEach(a => {
    a.addEventListener('click', () => presetMaint(a.dataset.presetEngin, a.dataset.presetPrev));
  });

  // préventions
  $('#tablePreventions tbody').innerHTML = DB.preventions.map(p => `<tr>
    <td>${escapeHTML(p.libelle)}</td>
    <td class="num">${p.km ? fmtNum(p.km) : '—'}</td>
    <td class="num">${p.mois || '—'}</td>
    <td style="white-space:nowrap">
      <button class="btn-icon" data-priv="maintenance:edit" onclick="editPrevention('${p.id}')">✏️</button>
      <button class="btn-icon del" data-priv="maintenance:suppr" onclick="del('${p.id}','prevention')">🗑</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="4" class="muted">Aucun intervalle défini.</td></tr>';

  // échéancier
  $('#tableEcheances tbody').innerHTML = ech.map(x => {
    const badgeE = x.etat === 'critique' ? '<span class="badge b-rouge">Dépassée</span>'
      : x.etat === 'attention' ? '<span class="badge b-orange">Bientôt</span>'
      : '<span class="badge b-vert">OK</span>';
    return `<tr>
      <td>${escapeHTML(x.engin.nom)}</td>
      <td>${escapeHTML(x.prev.libelle)}</td>
      <td>${x.last ? frDate(x.last.date) : '<span class="muted">jamais</span>'}</td>
      <td class="num">${x.last && x.last.km ? fmtNum(x.last.km) : '—'}</td>
      <td>${x.nextDate ? frDate(x.nextDate) : (x.prev.mois ? '<span class="muted">—</span>' : '—')}</td>
      <td class="num">${x.nextKm ? fmtNum(x.nextKm) : '—'}</td>
      <td>${badgeE}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">Ajoutez des engins et des intervalles.</td></tr>';

  // historique
  const hist = rowsPour('charges').filter(c => c.categorie === 'maintenance').sort((a,b) => a.date < b.date ? 1 : -1);
  $('#tableHistMaint tbody').innerHTML = hist.map(c => `<tr>
    <td>${frDate(c.date)}</td>
    <td>${c.enginId ? escapeHTML(enginNom(c.enginId)) : '—'}</td>
    <td>${escapeHTML(c.typeMaint || c.libelle || '—')}</td>
    <td>${escapeHTML(c.prestataire || '—')}</td>
    <td class="num">${c.km ? fmtNum(c.km) : '—'}</td>
    <td class="num">${money(c.montant)}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune intervention enregistrée.</td></tr>';
  const totalM = hist.reduce((s,c) => s + (Number(c.montant)||0), 0);
  $('#maintFoot').innerHTML = `<span>Coût total maintenance : <b>${money(totalM)}</b></span><span>${hist.length} intervention(s)</span>`;
}

function presetMaint(enginId, prevId){
  // appelé avant la navigation : on prépare le formulaire charges
  sessionStorage.setItem('presetMaint', JSON.stringify({ enginId, prevId }));
}
function applyPresetMaint(){
  const raw = sessionStorage.getItem('presetMaint');
  if(!raw) return;
  sessionStorage.removeItem('presetMaint');
  try{
    const p = JSON.parse(raw);
    $('#chCategorie').value = 'maintenance';
    $('#chEngin').value = p.enginId || '';
    if(p.prevId) $('#chTypeMaint').value = p.prevId;
    syncChargeFields();
    $('#chDate').focus();
    toast('Formulaire pré-rempli : complétez la maintenance');
  }catch(e){}
}

function editPrevention(id){
  const p = DB.preventions.find(x => x.id === id);
  if(!p) return;
  $('#formPrevention').classList.remove('hidden');
  $('#prevId').value = p.id;
  $('#prevLibelle').value = p.libelle;
  $('#prevKm').value = p.km || '';
  $('#prevMois').value = p.mois || '';
  window.scrollTo({ top:0, behavior:'smooth' });
}
function resetPreventionForm(){
  $('#formPrevention').reset();
  $('#prevId').value = '';
  $('#formPrevention').classList.add('hidden');
}

function initMaintenance(){
  $('#btnNewPrevention').addEventListener('click', () => {
    resetPreventionForm();
    $('#formPrevention').classList.remove('hidden');
    $('#prevLibelle').focus();
  });
  $('#prevCancel').addEventListener('click', resetPreventionForm);
  $('#formPrevention').addEventListener('submit', e => {
    e.preventDefault();
    if(!requirePriv('maintenance:edit')) return;
    const id = $('#prevId').value;
    const data = {
      id: id || uid(),
      libelle: $('#prevLibelle').value.trim(),
      km: Number($('#prevKm').value)||0,
      mois: Number($('#prevMois').value)||0
    };
    if(!data.libelle) return;
    if(id){
      const i = DB.preventions.findIndex(x => x.id === id);
      if(i >= 0) DB.preventions[i] = data;
    }else{
      DB.preventions.push(data);
    }
    saveDB(); resetPreventionForm(); renderAll();
    toast('Intervalle enregistré ✓');
  });
}

/* ============================================================
   RAPPORTS
   ============================================================ */
/* ============================================================
   COMPARATIF PAR CONDUCTEUR
   ============================================================ */
function condRange(){
  const m = $('#condMonth').value;
  return m ? [m + '-01', m + '-31'] : periodRange('all');
}
function renderConducteurs(){
  // sélecteur du taux (par opération)
  const sel = $('#condTaux');
  if(!sel.dataset.ready){
    sel.dataset.ready = '1';
    sel.addEventListener('change', e => {
      if(e.target.value === 'custom'){
        const v = prompt('Rémunération par opération (' + (DB.settings.devise||'') + ') :', DB.settings.salaireOperation || 500);
        const n = Number(v);
        if(v === null || !(n >= 0)){ renderConducteurs(); return; }
        DB.settings.salaireOperation = n; saveDB();
      } else {
        DB.settings.salaireOperation = Number(e.target.value); saveDB();
      }
      renderConducteurs();
    });
  }
  const tauxCur = String(DB.settings.salaireOperation || 500);
  const presets = ['500','750','1000'];
  sel.innerHTML = (presets.includes(tauxCur) ? presets : [tauxCur].concat(presets))
    .map(t => `<option value="${t}" ${t===tauxCur?'selected':''}>${fmtNum(t)} / opération</option>`).join('') +
    (presets.includes(tauxCur) ? '<option value="custom">Personnalisé…</option>' : '');

  const engSel = $('#condEngin');
  engSel.innerHTML = '<option value="">Tous les engins</option>' +
    optionHTML(DB.engins, 'id', 'nom', engSel.value);

  const range = condRange();
  const rows = computeConducteurs(range, engSel.value || null);

  const roleLabel = r => r.role === 'conducteur' ? 'Conducteur' : r.role === 'apprenti' ? 'Apprenti' : 'Autre';
  $('#tableConducteurs tbody').innerHTML = rows.map(r => `<tr>
    <td><b>${escapeHTML(r.nom)}</b></td>
    <td>${roleLabel(r)}</td>
    <td class="num">${r.nb}</td>
    <td class="num">${fmtNum(r.transferts)}</td>
    <td class="num">${fmtNum(r.ouvertures)}</td>
    <td class="num pos">${money(r.ca)}</td>
    <td class="num neg">${money(r.salaire)}</td>
    <td class="num ${r.reste>=0?'pos':'neg'}">${money(r.reste)}</td>
  </tr>`).join('') || '<tr><td colspan="8" class="muted">Aucun conducteur sur cette période.</td></tr>';

  const tot = rows.reduce((s,r) => ({ ca:s.ca+r.ca, sal:s.sal+r.salaire, rest:s.rest+r.reste }),
    { ca:0, sal:0, rest:0 });
  $('#tableConducteurs tfoot').innerHTML = rows.length ? `<tr>
    <th colspan="5">Total ${rows.length} conducteur(s)</th>
    <th class="num pos">${money(tot.ca)}</th>
    <th class="num neg">${money(tot.sal)}</th>
    <th class="num ${tot.rest>=0?'pos':'neg'}">${money(tot.rest)}</th>
  </tr>` : '';

  $('#repExportConducteurs').onclick = () => {
    exportCSV('conducteurs.csv',
      ['Conducteur','Rôle','Travaux','Transferts','Ouvertures','CA généré','Salaire','Reste'],
      rows.map(r => [r.nom, roleLabel(r), r.nb, r.transferts, r.ouvertures, r.ca, r.salaire, r.reste]));
  };
}

function initConducteurs(){
  $('#condMonth').value = new Date().toISOString().slice(0,7);
  $('#condMonth').addEventListener('change', renderConducteurs);
  $('#condEngin').addEventListener('change', renderConducteurs);
}

function renderRapports(){
  // --- mensuel ---
  const all = rowsPour('travaux').concat(rowsPour('charges')).map(x => monthKey(x.date)).filter(Boolean);
  const months = all.length
    ? Array.from(new Set(all)).sort().reverse()
    : [];
  const sel = $('#repMonth').value;
  const rowsM = months.map(m => {
    const r = [m + '-01', m + '-31'];
    const k = computeKPIs(r);
    return { m, k };
  });
  $('#tableMensuel tbody').innerHTML = rowsM.map(({m,k}) => `<tr ${sel && m===sel ? 'style="background:rgba(79,140,255,.1)"' : ''}>
    <td>${monthLabel(m)}</td>
    <td class="num pos">${money(k.ca)}</td>
    <td class="num neg">${money(k.depenses)}</td>
    <td class="num ${k.benefice>=0?'pos':'neg'}">${money(k.benefice)}</td>
    <td class="num">${pct(k.marge)}</td>
    <td class="num">${k.litres ? fmtNum(k.litres,1) : '—'}</td>
    <td class="num">${k.conso100 !== null ? fmtNum(k.conso100,1) : '—'}</td>
    <td class="num">${k.voyages}</td>
    <td class="num">${k.ouvertures}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="muted">Aucune donnée.</td></tr>';

  // --- bilan engins ---
  const range = ['1970-01-01','2999-12-31'];
  $('#tableBilanEngins tbody').innerHTML = DB.engins.map(e => {
    const k = computeKPIs(range, e.id);
    const ref = Number(e.consoRef)||null;
    const ecart = (k.conso100 !== null && ref) ? ((k.conso100 - ref)/ref)*100 : null;
    return `<tr>
      <td><b>${escapeHTML(e.nom)}</b></td>
      <td class="num">${k.voyages}</td>
      <td class="num">${k.ouvertures}</td>
      <td class="num pos">${money(k.ca)}</td>
      <td class="num">${money(k.parCat.carburant)}</td>
      <td class="num">${money(k.parCat.maintenance)}</td>
      <td class="num">${money(k.parCat.salaire + k.parCat.autre)}</td>
      <td class="num neg">${money(k.depenses)}</td>
      <td class="num ${k.benefice>=0?'pos':'neg'}">${money(k.benefice)}</td>
      <td class="num">${pct(k.marge)}</td>
      <td class="num">${k.km ? fmtNum(k.km) : '—'}</td>
      <td class="num">${k.conso100 !== null ? fmtNum(k.conso100,1) : '—'}</td>
      <td class="num ${ecart===null?'':(ecart<=0?'pos':'neg')}">${ecart === null ? '—' : (ecart>0?'+':'')+fmtNum(ecart,1)+' %'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="13" class="muted">Aucun engin.</td></tr>';

  // --- salaires ---
  $('#tableSalaires tbody').innerHTML = DB.employes.map(emp => {
    const pays = rowsPour('charges').filter(c => c.categorie === 'salaire' && c.employeId === emp.id);
    const total = pays.reduce((s,c) => s + (Number(c.montant)||0), 0);
    return `<tr>
      <td>${escapeHTML(emp.nom)}</td>
      <td>${emp.role === 'conducteur' ? 'Conducteur' : emp.role === 'apprenti' ? 'Apprenti' : 'Autre'}</td>
      <td class="num">${pays.length}</td>
      <td class="num">${money(total)}</td>
      <td class="num">${pays.length ? money(total/pays.length) : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">Aucun employé.</td></tr>';

  // --- comparatif conducteurs ---
  renderConducteurs();

  $('#repExportMensuel').onclick = () => {
    exportCSV('rapport_mensuel.csv',
      ['Mois','CA','Charges','Benefice','Marge %','Carburant L','L/100km','Voyages','Ouvertures'],
      rowsM.map(({m,k}) => [m, k.ca, k.depenses, k.benefice, k.marge===null?'':k.marge.toFixed(1), k.litres, k.conso100===null?'':k.conso100.toFixed(1), k.voyages, k.ouvertures]));
  };
  $('#repExportEngins').onclick = () => {
    exportCSV('bilan_engins.csv',
      ['Engin','Voyages','Ouvertures','CA','Carburant','Maintenance','Salaires+Autres','Total charges','Benefice','Marge %','Km','L/100km'],
      DB.engins.map(e => {
        const k = computeKPIs(range, e.id);
        return [e.nom, k.voyages, k.ouvertures, k.ca, k.parCat.carburant, k.parCat.maintenance,
                k.parCat.salaire + k.parCat.autre, k.depenses, k.benefice,
                k.marge===null?'':k.marge.toFixed(1), k.km, k.conso100===null?'':k.conso100.toFixed(1)];
      }));
  };
}

/* ============================================================
   PARAMÈTRES
   ============================================================ */
function renderSbStatus(){
  const el = $('#sbStatus');
  if(!el) return;
  if(!syncReady()){ el.textContent = 'Non connecté'; return; }
  const m = syncMeta();
  const fmt = iso => iso ? new Date(iso).toLocaleString('fr-FR') : '—';
  const rtLabel = isRealtimeActive()
    ? '🟢 Temps réel WebSocket actif'
    : (realtimeStatus() === 'connecting' ? '🟡 WebSocket en cours de connexion…'
      : '🔴 Temps réel inactif (polling)');
  el.innerHTML = `Connecté · ${rtLabel}<br><small>Dernier envoi : ${fmt(m.lastPush)} · Dernier retrait : ${fmt(m.lastPull)}</small>`;
}

function renderParametres(){
  $('#setNom').value = DB.settings.nom || '';
  $('#setDevise').value = DB.settings.devise || '';
  $('#setPrixTransfert').value = DB.settings.prixTransfert;
  $('#setPrixDebardage').value = DB.settings.prixBardage;
  $('#setObjectif').value = DB.settings.objectifMensuel || '';
  $('#setSalaireOp').value = DB.settings.salaireOperation || 500;
  $('#sbUrl').value = DB.settings.sbUrl || '';
  $('#sbKey').value = DB.settings.sbKey || '';
  $('#sbAuto').checked = !!DB.settings.sbAuto;
  renderSbStatus();

  $('#tableActivites tbody').innerHTML = DB.activites.map(a => `<tr>
    <td>${escapeHTML(a.libelle)}</td>
    <td>${escapeHTML(a.unite)}</td>
    <td class="num">${money(a.prix)}</td>
    <td style="white-space:nowrap">
      <button class="btn-icon" data-priv="parametres:edit" onclick="editActivite('${a.id}')">✏️</button>
      <button class="btn-icon del" data-priv="parametres:suppr" onclick="del('${a.id}','activite')">🗑</button>
    </td>
  </tr>`).join('');

  $('#tableEmployes tbody').innerHTML = DB.employes.map(emp => {
    const total = rowsPour('charges').filter(c => c.categorie === 'salaire' && c.employeId === emp.id)
      .reduce((s,c) => s + (Number(c.montant)||0), 0);
    return `<tr>
      <td>${escapeHTML(emp.nom)}</td>
      <td>${emp.role === 'conducteur' ? 'Conducteur' : emp.role === 'apprenti' ? 'Apprenti' : 'Autre'}</td>
      <td class="num">${money(total)}</td>
      <td style="white-space:nowrap">
        <button class="btn-icon" data-priv="parametres:edit" onclick="editEmploye('${emp.id}')">✏️</button>
        <button class="btn-icon del" data-priv="parametres:suppr" onclick="del('${emp.id}','employe')">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">Aucun employé.</td></tr>';

  $('#engConducteur').innerHTML = '<option value="">—</option>' + optionHTML(DB.employes, 'id', 'nom', $('#engConducteur').value);
}

function editActivite(id){
  const a = activiteById(id);
  if(!a) return;
  $('#actId').value = a.id;
  $('#actLibelle').value = a.libelle;
  $('#actUnite').value = a.unite;
  $('#actPrix').value = a.prix;
  $('#formActivite').querySelector('button[type=submit]').textContent = '💾 Mettre à jour';
  $('#actCancel').classList.remove('hidden');
}
function editEmploye(id){
  const e = employeById(id);
  if(!e) return;
  $('#empId').value = e.id;
  $('#empNom').value = e.nom;
  $('#empRole').value = e.role;
  $('#formEmploye').querySelector('button[type=submit]').textContent = '💾 Mettre à jour';
  $('#empCancel').classList.remove('hidden');
}

function initParametres(){
  $('#formSettings').addEventListener('submit', e => {
    e.preventDefault();
    if(!requirePriv('parametres:edit')) return;
    DB.settings.nom = $('#setNom').value.trim() || 'Mon Entreprise';
    DB.settings.devise = $('#setDevise').value.trim();
    DB.settings.prixTransfert = Number($('#setPrixTransfert').value)||0;
    DB.settings.prixBardage = Number($('#setPrixDebardage').value)||0;
    DB.settings.objectifMensuel = Number($('#setObjectif').value)||0;
    DB.settings.salaireOperation = Number($('#setSalaireOp').value)||500;
    // répercul sur l'activité "Transfert" / "Débardage" si présentes
    const t = DB.activites.find(a => a.libelle.toLowerCase().includes('transfert'));
    const d = DB.activites.find(a => a.libelle.toLowerCase().includes('débardage') || a.libelle.toLowerCase().includes('debardage'));
    if(t) t.prix = DB.settings.prixTransfert;
    if(d) d.prix = DB.settings.prixBardage;
    saveDB(); renderAll();
    toast('Paramètres enregistrés ✓');
  });

  $('#formActivite').addEventListener('submit', e => {
    e.preventDefault();
    if(!requirePriv('parametres:edit')) return;
    const id = $('#actId').value;
    const data = {
      id: id || uid(),
      libelle: $('#actLibelle').value.trim(),
      unite: $('#actUnite').value.trim(),
      prix: Number($('#actPrix').value)||0
    };
    if(!data.libelle || !data.unite) return;
    if(id){
      const i = DB.activites.findIndex(x => x.id === id);
      if(i >= 0) DB.activites[i] = data;
    }else{
      DB.activites.push(data);
    }
    saveDB(); resetActiviteForm(); renderAll();
    toast('Activité enregistrée ✓');
  });
  $('#actCancel').addEventListener('click', resetActiviteForm);

  $('#formEmploye').addEventListener('submit', e => {
    e.preventDefault();
    if(!requirePriv('parametres:edit')) return;
    const id = $('#empId').value;
    const data = { id: id || uid(), nom: $('#empNom').value.trim(), role: $('#empRole').value };
    if(!data.nom) return;
    if(id){
      const i = DB.employes.findIndex(x => x.id === id);
      if(i >= 0) DB.employes[i] = data;
    }else{
      DB.employes.push(data);
    }
    saveDB(); resetEmployeForm(); renderAll();
    toast('Employé enregistré ✓');
  });
  $('#empCancel').addEventListener('click', resetEmployeForm);

  // --- Supabase ---
  $('#sbSave').addEventListener('click', () => {
    if(!requirePriv('global:sync')) return;
    DB.settings.sbUrl = $('#sbUrl').value.trim();
    DB.settings.sbKey = $('#sbKey').value.trim();
    DB.settings.sbAuto = $('#sbAuto').checked;
    saveDB(); renderSbStatus();
    // Redémarre le WebSocket avec la nouvelle configuration
    stopRealtimeSync();
    if(syncReady() && currentUser()) startRealtimeSync();
    toast('Connexion enregistrée ✓');
  });
  $('#sbAuto').addEventListener('change', () => {
    DB.settings.sbAuto = $('#sbAuto').checked; saveDB();
  });
  const runSb = async (label, fn) => {
    if(!syncReady()){ toast('Renseignez URL et clé anon d\'abord', true); return; }
    $('#sbStatus').textContent = label + '…';
    try{
      const r = await fn();
      renderSbStatus();
      toast(label + ' ✓ ' + JSON.stringify(r).slice(0,80));
    }catch(err){
      $('#sbStatus').textContent = '❌ ' + err.message;
      toast(err.message, true);
    }
  };
  $('#sbPush').addEventListener('click', () => { if(requirePriv('global:sync')) runSb('Envoi', syncPush); });
  $('#sbPull').addEventListener('click', () => { if(requirePriv('global:sync')) runSb('Récupération', syncPull); });
  const btnTest = $('#sbTest');
  if(btnTest) btnTest.addEventListener('click', async () => {
    if(!requirePriv('global:sync')) return;
    // teste les valeurs affichées (et les enregistre au passage)
    DB.settings.sbUrl = $('#sbUrl').value.trim();
    DB.settings.sbKey = $('#sbKey').value.trim();
    saveDB();
    if(!syncReady()){ toast('Renseignez l\'URL et la clé, puis réessayez', true); return; }
    btnTest.disabled = true;
    const libelle = btnTest.textContent;
    btnTest.textContent = '⏳ Test en cours…';
    $('#sbStatus').textContent = 'Test de connexion…';
    try{
      await syncTest();
      $('#sbStatus').textContent = '✅ Test réussi — Supabase répond (clé acceptée)';
      toast('✅ Supabase répond : connexion OK');
    }catch(err){
      $('#sbStatus').textContent = '❌ ' + err.message;
      toast(err.message, true);
    }finally{
      btnTest.disabled = false;
      btnTest.textContent = libelle;
    }
  });

  $('#btnExportJson').addEventListener('click', () => {
    if(!requirePriv('global:export')) return;
    const blob = new Blob([exportJSON()], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sauvegarde_gestion_engins.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#importFile').addEventListener('change', e => {
    if(!requirePriv('global:export')){ e.target.value = ''; return; }
    const f = e.target.files[0];
    if(!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        importJSON(reader.result);
        renderAll();
        toast('Sauvegarde importée ✓');
      }catch(err){ toast('Import impossible : ' + err.message, true); }
    };
    reader.readAsText(f);
    e.target.value = '';
  });
  $('#btnReset').addEventListener('click', () => {
    if(!requirePriv('parametres:edit')) return;
    if(!confirm('Tout effacer définitivement ? (les comptes utilisateurs sont conservés)')) return;
    const comptes = utilisateurs().slice();
    DB = defaultState();
    DB.utilisateurs = comptes;
    saveDB(); renderAll(); toast('Données effacées');
  });
}
function resetActiviteForm(){
  $('#formActivite').reset();
  $('#actId').value = '';
  $('#formActivite').querySelector('button[type=submit]').textContent = '➕ Ajouter l\'activité';
  $('#actCancel').classList.add('hidden');
}
function resetEmployeForm(){
  $('#formEmploye').reset();
  $('#empId').value = '';
  $('#formEmploye').querySelector('button[type=submit]').textContent = '➕ Ajouter';
  $('#empCancel').classList.add('hidden');
}

/* ============================================================
   INIT
   ============================================================ */
function initPeriodBar(){
  const sel = $('#periodSelect');
  const apply = () => {
    const custom = sel.value === 'custom';
    $('#periodFrom').classList.toggle('hidden', !custom);
    $('#periodTo').classList.toggle('hidden', !custom);
    $('#periodSep').classList.toggle('hidden', !custom);
    renderDashboard(); renderMini();
  };
  sel.addEventListener('change', apply);
  $('#periodFrom').addEventListener('change', apply);
  $('#periodTo').addEventListener('change', apply);
  const now = new Date();
  const pad = x => String(x).padStart(2,'0');
  $('#periodFrom').value = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
  $('#periodTo').value = today();

  const btnDash = $('#btnDashSync');
  if(btnDash){
    btnDash.addEventListener('click', () => doSilentSync(true));
    // Met à jour le libellé du bouton selon l'état Realtime
    setInterval(() => {
      if(!btnDash || btnDash.textContent.startsWith('⏳')) return;
      btnDash.textContent = isRealtimeActive() ? '🟢 Temps réel actif' : '🔄 Synchroniser';
    }, 3000);
  }
}

/* ============================================================
   SYNCHRONISATION CLOUD EN ARRIÈRE-PLAN
   ============================================================ */
let _syncInterval = null;
let _isSyncing = false;

async function doSilentSync(showFeedback = false){
  if(!syncReady() || _isSyncing) return;
  _isSyncing = true;
  const btn = $('#btnDashSync');
  if(btn) btn.textContent = '⏳ Synchro…';
  try{
    const r = await syncAll();
    const nbRecus = (r.pulled.added || 0) + (r.pulled.updated || 0);
    const nbEnvoyes = (r.pushed.sent || 0);
    // Re-rend systématiquement le tableau de bord pour afficher les données fraîches,
    // même si le compteur de diff est 0 (timestamps identiques mais contenus potentiellement mis à jour)
    renderAll();
    if(nbRecus > 0 || nbEnvoyes > 0){
      toast(`☁️ Données à jour (+${nbRecus} reçue(s), ↑${nbEnvoyes} envoyée(s))`);
    } else if(showFeedback){
      toast('☁️ Données déjà à jour');
    }
  }catch(err){
    if(showFeedback) toast('Échec synchro : ' + err.message, true);
  }finally{
    _isSyncing = false;
    if(btn) btn.textContent = '🔄 Synchroniser';
  }
}

function startSyncLoop(){
  if(_syncInterval) clearInterval(_syncInterval);

  // Lance le WebSocket Realtime en priorité (propagation instantanée)
  if(syncReady() && currentUser()) startRealtimeSync();

  // Fallback polling :
  //   - Si Realtime actif : toutes les 5 min (rattrapage si un événement WS est manqué)
  //   - Si Realtime inactif (pas de CDN ou config absente) : toutes les 25s comme avant
  const POLL_RT  = 5 * 60 * 1000;   // 5 minutes
  const POLL_STD = 25 * 1000;        // 25 secondes

  _syncInterval = setInterval(() => {
    if(!currentUser() || !syncReady()) return;
    const interval = isRealtimeActive() ? POLL_RT : POLL_STD;
    // On utilise le timestamp du dernier passage pour respecter l'intervalle voulu
    const meta = syncMeta();
    const since = meta._lastPoll || 0;
    if(Date.now() - since < interval) return;
    setSyncMeta(Object.assign(syncMeta(), { _lastPoll: Date.now() }));
    doSilentSync(false);
  }, 5000);   // vérifie toutes les 5s si c'est le bon moment de déclencher
}

let _initFait = false;
function init(){
  if(_initFait) return;          // jamais initialisé deux fois (double liaison des handlers)
  _initFait = true;
  initPeriodBar();
  initAuth();
  initTravaux();
  initTerrain();
  initCharges();
  initFactures();
  initEngins();
  initMaintenance();
  initConducteurs();
  initParametres();
  initUtilisateurs();
  startSyncLoop();

  $('#btnBackupQuick').addEventListener('click', () => {
    if(!requirePriv('global:export')) return;
    const blob = new Blob([exportJSON()], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sauvegarde_gestion_engins.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  window.addEventListener('resize', () => { if(currentView()==='dashboard') renderDashboard(); });

  route();
  renderMini();
}

document.addEventListener('DOMContentLoaded', init);

/* ============================================================
   UTILISATEURS — comptes & définition des privilèges
   ============================================================ */
let usrSelection = null;   // compte en cours d'édition (null = création)
let formRole = 'perso';    // rôle affiché dans le formulaire
let formPrivs = [];        // privilèges affichés dans la matrice

function formUserTarget(){ return usrSelection ? userById(usrSelection) : null; }
function syncFormPrivs(role){
  formRole = ROLES[role] ? role : 'perso';
  if(formRole !== 'perso') formPrivs = ROLES[formRole].privs().slice();
}
function updateRoleDesc(){
  const r = ROLES[$('#usrRole') ? $('#usrRole').value : formRole];
  $('#usrRoleDesc').textContent = r ? r.label + ' — ' + r.desc : '';
}

function renderUtilisateurs(){
  const moi = currentUser();
  const adminMoi = !!(moi && moi.role === 'admin');
  const gerable = can('utilisateurs:edit');

  const selRole = $('#usrRole');
  if(selRole){
    selRole.innerHTML = Object.keys(ROLES).map(k => {
      const interdit = !adminMoi && (k === 'admin' || k === 'gestion');
      return `<option value="${k}" ${interdit ? 'disabled' : ''}>${escapeHTML(ROLES[k].label)}${interdit ? ' (admin seul)' : ''}</option>`;
    }).join('');
    selRole.value = formRole;
  }
  const selEmp = $('#usrEmploye');
  if(selEmp) selEmp.innerHTML = '<option value="">—</option>' + optionHTML(DB.employes, 'id', 'nom', selEmp.value);
  updateRoleDesc();

  $('#tableUsers tbody').innerHTML = utilisateurs().map(x => {
    const gerable_ci = peutGererCompte(x, moi);
    const connex = derniereConnexionLocal(x.id) || x.derniereConnexion || '';
    return `
    <tr data-user="${x.id}" class="user-row ${x.id === usrSelection ? 'row-sel' : ''}">
      <td><b>${escapeHTML(x.nom)}</b>${moi && x.id === moi.id ? ' <span class="badge b-vert">moi</span>' : ''}</td>
      <td>${escapeHTML(x.login)}</td>
      <td><span class="badge badge-role">${escapeHTML((ROLES[x.role] || { label:x.role }).label)}</span></td>
      <td>${x.actif ? '<span class="badge b-vert">Actif</span>' : '<span class="badge b-rouge">Désactivé</span>'}</td>
      <td class="muted">${connex ? new Date(connex).toLocaleString('fr-FR') : '—'}</td>
      <td style="white-space:nowrap" ${gerable_ci ? 'data-priv="utilisateurs:edit"' : ''}>
        ${gerable_ci ? `
        <button class="btn-icon" title="Modifier" onclick="editUser('${x.id}')">✏️</button>
        <button class="btn-icon" title="Nouveau mot de passe" onclick="resetMdpUser('${x.id}')">🔑</button>
        <button class="btn-icon" title="${x.actif ? 'Désactiver le compte' : 'Réactiver le compte'}" onclick="toggleUser('${x.id}')">${x.actif ? '🚫' : '✅'}</button>
        <button class="btn-icon del" title="Supprimer" onclick="delUser('${x.id}')">🗑</button>` : '<span title="Seul un administrateur peut modifier ce compte">🔒</span>'}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">Aucun compte : créez le premier utilisateur.</td></tr>';

  renderPrivMatrix();
  applyPrivVisibility();
}

function renderPrivMatrix(){
  const cible = formUserTarget();
  const gerable = can('utilisateurs:edit');
  const cibleAdmin = !!(cible && cible.role === 'admin');
  const bloquant = !gerable || !cible;
  const accordables = privsAccordables();

  $('#privMode').textContent = cible
    ? cible.nom + ' · ' + (ROLES[cible.role] || { label:cible.role }).label
    : 'Nouveau compte · ' + (ROLES[formRole] || { label:'—' }).label;

  $('#privHint').textContent = !cible
    ? 'Cochez les privilèges à accorder à ce compte, puis enregistrez.'
    : cibleAdmin ? 'Un administrateur possède tous les privilèges, y compris la gestion des comptes.'
    : bloquant ? 'Consultation : vous n\'avez pas le droit de modifier les privilèges.'
    : 'Cochez les droits accordés. Sans « Voir », le module reste masqué pour ce compte.';

  $('#tablePrivs tbody').innerHTML = PRIV_MODULES.map(m => {
    const vu = cibleAdmin || formPrivs.includes(m.key + ':vue');
    const cases = PRIV_ACTIONS.map(a => {
      const cle = m.key + ':' + a.key;
      const on = cibleAdmin || formPrivs.includes(cle);
      const dis = bloquant || cibleAdmin || !accordables.includes(cle);
      return `<td class="ctr"><input type="checkbox" data-cle="${cle}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}></td>`;
    }).join('');
    return `<tr class="${vu ? '' : 'priv-off'}"><td class="priv-label">${escapeHTML(m.label)}</td>${cases}</tr>`;
  }).join('');

  $('#privGlobal').innerHTML = PRIV_GLOBAL.map(g => {
    const cle = 'global:' + g.key;
    const on = cibleAdmin || formPrivs.includes(cle);
    const dis = bloquant || cibleAdmin || !accordables.includes(cle);
    return `<label class="${on ? '' : 'muted'}"><input type="checkbox" data-cle="${cle}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}> ${escapeHTML(g.label)}</label>`;
  }).join('');
}

function onPrivChange(e){
  const cb = e.target;
  if(!cb || cb.type !== 'checkbox' || !cb.dataset.cle) return;
  const set = new Set(formPrivs);
  if(cb.checked) set.add(cb.dataset.cle); else set.delete(cb.dataset.cle);
  if(/:vue$/.test(cb.dataset.cle) && !cb.checked){
    const mod = cb.dataset.cle.split(':')[0];
    PRIV_ACTIONS.forEach(a => set.delete(mod + ':' + a.key));
  }
  formPrivs = Array.from(set);
  formRole = 'perso';
  const sel = $('#usrRole');
  if(sel) sel.value = 'perso';
  updateRoleDesc();
  renderPrivMatrix();
}

function newUserForm(){
  if(!requirePriv('utilisateurs:edit')) return;
  $('#formUser').reset();
  $('#usrId').value = '';
  $('#usrActif').checked = true;
  $('#usrMdp').required = true;
  $('#usrMdp2').required = true;
  $('#usrMdp').placeholder = '4 caractères minimum';
  $('#usrMdp2').placeholder = 'Retapez le mot de passe';
  $('#userFormTitle').textContent = 'Nouvel utilisateur';
  $('#usrCancel').classList.add('hidden');
  usrSelection = null;
  syncFormPrivs('saisie');
  $('#userFormCard').classList.remove('hidden');
  renderUtilisateurs();
  $('#usrNom').focus();
}

function editUser(id){
  if(!requirePriv('utilisateurs:edit')) return;
  const u = userById(id);
  if(!u) return;
  if(!peutGererCompte(u)) return toast('Compte protégé : seul un administrateur peut le modifier', true);
  usrSelection = id;
  $('#usrId').value = u.id;
  $('#usrNom').value = u.nom;
  $('#usrLogin').value = u.login;
  $('#usrEmploye').value = u.employeId || '';
  $('#usrActif').checked = !!u.actif;
  $('#usrMdp').value = ''; $('#usrMdp2').value = '';
  const mdpRequis = !u.hash;
  $('#usrMdp').required = mdpRequis;
  $('#usrMdp2').required = mdpRequis;
  $('#usrMdp').placeholder = mdpRequis ? '4 caractères minimum' : 'Laisser vide = inchangé';
  $('#usrMdp2').placeholder = mdpRequis ? 'Retapez le mot de passe' : 'Laisser vide = inchangé';
  $('#userFormTitle').textContent = 'Modifier : ' + u.nom;
  $('#usrCancel').classList.remove('hidden');
  formRole = u.role;
  formPrivs = userPrivs(u).slice();
  $('#userFormCard').classList.remove('hidden');
  renderUtilisateurs();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetUserForm(){
  $('#formUser').reset();
  $('#usrId').value = '';
  $('#usrMdp').required = true;
  $('#usrMdp2').required = true;
  $('#userFormTitle').textContent = 'Nouvel utilisateur';
  $('#usrCancel').classList.add('hidden');
  $('#userFormCard').classList.add('hidden');
  usrSelection = null;
  syncFormPrivs('saisie');
  renderUtilisateurs();
}

async function saveUser(e){
  e.preventDefault();
  if(!requirePriv('utilisateurs:edit')) return;
  const id = $('#usrId').value;
  const nom = $('#usrNom').value.trim();
  const login = $('#usrLogin').value.trim();
  const mdp = $('#usrMdp').value;
  const mdp2 = $('#usrMdp2').value;
  const actif = $('#usrActif').checked;
  const employeId = $('#usrEmploye').value || '';
  const cible = id ? userById(id) : null;
  const moi = currentUser();

  if(!nom || !login) return toast('Renseignez nom et identifiant', true);
  if(!loginDispo(login, id)) return toast('Identifiant déjà utilisé', true);
  if(mdp || mdp2){
    if(mdp.length < 4) return toast('Mot de passe : 4 caractères minimum', true);
    if(mdp !== mdp2) return toast('Les deux mots de passe ne correspondent pas', true);
  }else if(!cible || !cible.hash){
    return toast('Choisissez un mot de passe', true);
  }
  if(formRole === 'admin' || formRole === 'gestion'){
    if(!moi || moi.role !== 'admin')
      return toast('Seul un administrateur peut créer un compte administrateur ou gestionnaire', true);
  }
  if(cible && moi && cible.id === moi.id && formRole !== 'admin')
    return toast('Vous ne pouvez pas retirer votre propre rôle administrateur', true);
  if(cible && cible.role === 'admin' && cible.actif && adminActifs().length === 1 && (formRole !== 'admin' || !actif))
    return toast('Impossible : c\'est le seul compte administrateur actif', true);

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try{
    const u = await enregistrerUtilisateur({
      id, nom, login, role: formRole, privileges: formPrivs, actif, employeId, mdp
    });
    usrSelection = u.id;
    toast(id ? 'Compte mis à jour ✓' : 'Compte créé ✓');
    resetUserForm();
    renderMini();
  }catch(err){
    toast('Erreur : ' + err.message, true);
  }finally{
    btn.disabled = false;
  }
}

function toggleUser(id){
  if(!requirePriv('utilisateurs:edit')) return;
  const u = userById(id);
  if(!u) return;
  if(!peutGererCompte(u)) return toast('Compte protégé : seul un administrateur peut le modifier', true);
  const moi = currentUser();
  if(moi && u.id === moi.id) return toast('Vous ne pouvez pas désactiver votre propre compte', true);
  if(u.actif && u.role === 'admin' && adminActifs().length === 1)
    return toast('Impossible : c\'est le seul compte administrateur actif', true);
  u.actif = !u.actif;
  saveDB();
  renderUtilisateurs();
  toast(u.actif ? 'Compte réactivé ✓' : 'Compte désactivé ✓');
}

function delUser(id){
  if(!requirePriv('utilisateurs:edit')) return;
  const u = userById(id);
  if(!u) return;
  if(!peutGererCompte(u)) return toast('Compte protégé : seul un administrateur peut le supprimer', true);
  const moi = currentUser();
  if(moi && u.id === moi.id) return toast('Vous ne pouvez pas supprimer votre propre compte', true);
  if(u.role === 'admin' && u.actif && adminActifs().length === 1)
    return toast('Impossible : c\'est le seul compte administrateur actif', true);
  if(!confirm('Supprimer le compte de ' + u.nom + ' ?')) return;
  try{
    supprimerUtilisateur(id);
  }catch(err){
    return toast(err.message, true);
  }
  if(usrSelection === id) resetUserForm();
  else renderUtilisateurs();
  toast('Compte supprimé ✓');
}

function resetMdpUser(id){
  if(!requirePriv('utilisateurs:edit')) return;
  const u = userById(id);
  if(!u) return;
  if(!peutGererCompte(u)) return toast('Compte protégé : seul un administrateur peut le modifier', true);
  const mdp = prompt('Nouveau mot de passe pour ' + u.nom + ' (4 caractères minimum) :');
  if(mdp === null) return;
  if(mdp.length < 4) return toast('Mot de passe : 4 caractères minimum', true);
  setMdp(u, mdp).then(() => {
    saveDB();
    toast('Mot de passe modifié ✓');
    renderUtilisateurs();
  }).catch(err => toast('Erreur : ' + err.message, true));
}

function initUtilisateurs(){
  $('#btnNewUser').addEventListener('click', newUserForm);
  $('#usrCancel').addEventListener('click', resetUserForm);
  $('#formUser').addEventListener('submit', saveUser);
  $('#usrRole').addEventListener('change', () => {
    syncFormPrivs($('#usrRole').value);
    updateRoleDesc();
    renderPrivMatrix();
  });
  $('#tablePrivs').addEventListener('change', onPrivChange);
  $('#privGlobal').addEventListener('change', onPrivChange);
  $('#tableUsers').addEventListener('click', e => {
    if(e.target.closest('button')) return;
    const tr = e.target.closest('tr[data-user]');
    if(tr) editUser(tr.dataset.user);
  });
}
