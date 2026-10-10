/* ============ store.js — données, persistance, indicateurs ============ */

const DB_KEY = 'gestion_engins_db_v1';

const CATEGORIES = {
  carburant:  { label: 'Carburant',  badge: 'b-carburant' },
  maintenance:{ label: 'Maintenance',badge: 'b-maintenance' },
  salaire:    { label: 'Salaire',    badge: 'b-salaire' },
  autre:      { label: 'Autre',      badge: 'b-autre' }
};

/* ---------- État par défaut ---------- */
function defaultState(){
  return {
    settings: {
      nom: 'Mon Entreprise',
      devise: 'FCFA',
      prixTransfert: 5500,
      prixBardage: 4450,
      objectifMensuel: 0,
      salaireOperation: 500,       // rémunération par opération conducteur
      factureCounter: 0,
      sbUrl: '',                   // Supabase (restent locaux, jamais synchronisés)
      sbKey: '',
      sbAuto: false
    },
    activites: [
      { id: 'a1', libelle: 'Transfert de pétioles', unite: 'voyage', prix: 5500 },
      { id: 'a2', libelle: 'Débardage', unite: 'ouverture', prix: 4450 }
    ],
    employes: [],
    engins: [],
    travaux: [],
    charges: [],
    factures: [],
    preventions: [
      { id: 'p1', libelle: 'Vidange moteur', km: 5000, mois: 6 },
      { id: 'p2', libelle: 'Révision générale', km: 10000, mois: 12 }
    ]
  };
}

/* Collections synchronisées avec le cloud (identifiants exclus) */
const SYNC_COLLECTIONS = ['engins','employes','activites','travaux','charges','preventions','factures'];

let DB = loadDB();

function loadDB(){
  try{
    const raw = localStorage.getItem(DB_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      const def = defaultState();
      return Object.assign(def, parsed, { settings: Object.assign(def.settings, parsed.settings||{}) });
    }
  }catch(e){ console.warn('Chargement impossible', e); }
  return defaultState();
}

/* Horodatage des lignes modifiées (_at) : nécessaire à la synchro cloud */
let _snap = snapshotRows();
function snapshotRows(){
  const out = {};
  SYNC_COLLECTIONS.forEach(c => {
    out[c] = {};
    (DB[c] || []).forEach(r => { out[c][r.id] = JSON.stringify(r); });
  });
  out.__settings = JSON.stringify(DB.settings);
  return out;
}
function stampChanges(){
  const now = new Date().toISOString();
  SYNC_COLLECTIONS.forEach(c => {
    const prev = _snap[c] || {};
    const cur = {};
    (DB[c] || []).forEach(r => {
      const j = JSON.stringify(r);
      if(prev[r.id] !== j){ r._at = now; cur[r.id] = JSON.stringify(r); }
      else cur[r.id] = j;
    });
    _snap[c] = cur;
  });
  if(_snap.__settings !== JSON.stringify(DB.settings)){
    DB.settings._at = now;
    _snap.__settings = JSON.stringify(DB.settings);
  }
}

function saveDB(){
  stampChanges();
  try{ localStorage.setItem(DB_KEY, JSON.stringify(DB)); }
  catch(e){ console.warn('Sauvegarde impossible', e); }
}

function uid(){ return 'id-' + Math.random().toString(36).slice(2,9) + '-' + Date.now().toString(36); }

/* ---------- Utilitaires ---------- */
function toISO(d){
  if(typeof d === 'string') return d.slice(0,10);
  const z = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return z.toISOString().slice(0,10);
}
function today(){ return toISO(new Date()); }
function monthKey(iso){ return (iso||'').slice(0,7); }
function fmtNum(n, dec){
  if(n === null || n === undefined || isNaN(n)) return '—';
  const d = dec === undefined ? 0 : dec;
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits:d, maximumFractionDigits:d });
}
function money(n, devise){
  if(n === null || n === undefined || isNaN(n)) return '—';
  const cur = devise || (DB.settings.devise || '');
  const sign = n < 0 ? '-' : '';
  return sign + fmtNum(Math.abs(n)) + (cur ? ' ' + cur : '');
}
function pct(n){
  if(n === null || n === undefined || !isFinite(n)) return '—';
  return fmtNum(n,1) + ' %';
}
function enginById(id){ return DB.engins.find(e => e.id === id) || null; }
function enginNom(id){ const e = enginById(id); return e ? e.nom : '—'; }
function employeById(id){ return DB.employes.find(e => e.id === id) || null; }
function activiteById(id){ return DB.activites.find(a => a.id === id) || null; }

/* Montant d'un travail */
function trvMontant(t){
  if(t.montant !== undefined && t.montant !== null && !isNaN(t.montant)) return Number(t.montant);
  return (Number(t.qte)||0) * (Number(t.prixUnitaire)||0);
}

/* ---------- Dates de période ---------- */
function periodRange(key, from, to){
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const pad = x => String(x).padStart(2,'0');
  switch(key){
    case 'month':
      return [ `${y}-${pad(m+1)}-01`, toISO(new Date(y, m+1, 0)) ];
    case 'lastmonth': {
      const s = new Date(y, m-1, 1), e = new Date(y, m, 0);
      return [ toISO(s), toISO(e) ];
    }
    case '3months': {
      const s = new Date(y, m-2, 1), e = new Date(y, m+1, 0);
      return [ toISO(s), toISO(e) ];
    }
    case 'year':
      return [ `${y}-01-01`, `${y}-12-31` ];
    case 'custom':
      return [ from || '1970-01-01', to || '2999-12-31' ];
    default:
      return [ '1970-01-01', '2999-12-31' ];
  }
}

function inRange(iso, range){
  if(!iso) return false;
  return iso >= range[0] && iso <= range[1];
}

function filterTravaux(range, enginId){
  return DB.travaux.filter(t =>
    inRange(t.date, range) && (!enginId || t.enginId === enginId));
}
function filterCharges(range, enginId){
  return DB.charges.filter(c =>
    inRange(c.date, range) && (!enginId || c.enginId === enginId));
}

/* ---------- Consommation : km & litres ---------- */
/* km parcourus sur une période = dernier compteur connu avant/après la période */
function readingsFor(enginId){
  return DB.charges
    .filter(c => c.enginId === enginId && c.km !== undefined && c.km !== null && c.km !== '')
    .map(c => ({ date: c.date, km: Number(c.km) }))
    .sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

function kmParcours(range, enginId){
  let total = 0;
  const engins = enginId ? DB.engins.filter(e => e.id === enginId) : DB.engins;
  engins.forEach(e => {
    const readings = readingsFor(e.id);
    if(!readings.length) return;
    // dernier compteur avant (ou à) le début de période
    const before = readings.filter(r => r.date <= range[1]);
    if(!before.length) return;
    const dernier = before[before.length - 1].km;
    // premier relevé de la période ou compteur de départ
    const dansPeriode = readings.filter(r => inRange(r.date, range));
    let premier;
    if(dansPeriode.length){
      premier = dansPeriode[0].km;
      // si on a un relevé avant la période, on prend celui-là (plus précis)
      const avant = readings.filter(r => r.date < range[0]);
      if(avant.length) premier = avant[avant.length - 1].km;
      else if(Number(e.kmDepart) > 0) premier = Math.min(premier, Number(e.kmDepart));
    }else{
      // aucun relevé dans la période : km = 0 (rien de consommé entre deux bornes connues)
      const avant = readings.filter(r => r.date < range[0]);
      if(!avant.length) return;
      premier = avant[avant.length - 1].km;
    }
    const delta = dernier - premier;
    if(delta > 0) total += delta;
  });
  return total;
}

function kmTotalDepuis(enginId){
  const e = enginById(enginId);
  if(!e) return 0;
  const kms = DB.charges
    .filter(c => c.enginId === enginId && c.km !== undefined && c.km !== null && c.km !== '')
    .map(c => Number(c.km));
  if(!kms.length) return 0;
  const depart = Number(e.kmDepart)||0;
  const max = Math.max(...kms), min = Math.min(...kms);
  return Math.max(0, max - Math.max(depart, min));
}

/* ---------- Indicateurs principaux ---------- */
function computeKPIs(range, enginId){
  const trav = filterTravaux(range, enginId);
  const char = filterCharges(range, enginId);

  const ca = trav.reduce((s,t) => s + trvMontant(t), 0);
  const depenses = char.reduce((s,c) => s + (Number(c.montant)||0), 0);
  const benefice = ca - depenses;
  const marge = ca > 0 ? (benefice / ca) * 100 : null;

  const parCat = { carburant:0, maintenance:0, salaire:0, autre:0 };
  char.forEach(c => { parCat[c.categorie] = (parCat[c.categorie]||0) + (Number(c.montant)||0); });

  const litres = char.filter(c => c.categorie === 'carburant')
    .reduce((s,c) => s + (Number(c.litres)||0), 0);

  const km = kmParcours(range, enginId);
  const conso100 = km > 0 ? (litres / km) * 100 : null;
  const coutKm = km > 0 ? depenses / km : null;

  // Par activité
  const parActivite = {};
  let voyages = 0, ouvertures = 0;
  trav.forEach(t => {
    const a = activiteById(t.activiteId);
    const key = a ? a.libelle : 'Autre';
    const lib = key.toLowerCase();
    if(!parActivite[key]) parActivite[key] = { qte:0, ca:0, unite: a ? a.unite : '' };
    parActivite[key].qte += Number(t.qte)||0;
    parActivite[key].ca += trvMontant(t);
    if(lib.includes('transfert') || lib.includes('voyage')) voyages += Number(t.qte)||0;
    else if(lib.includes('débardage') || lib.includes('debardage') || lib.includes('ouverture')) ouvertures += Number(t.qte)||0;
  });

  return {
    ca, depenses, benefice, marge, parCat, litres, km, conso100, coutKm,
    nbTravaux: trav.length, nbCharges: char.length,
    voyages, ouvertures,
    parActivite
  };
}

/* ---------- Maintenance : échéances ---------- */
function echeancesMaint(){
  const out = [];
  DB.engins.forEach(e => {
    DB.preventions.forEach(p => {
      if(!p.km && !p.mois) return;
      // dernière intervention du même type (libellé proche)
      const intervs = DB.charges
        .filter(c => c.categorie === 'maintenance' && c.enginId === e.id && c.typeMaint === p.libelle)
        .sort((a,b) => (a.date < b.date ? 1 : -1));
      const last = intervs[0] || null;
      const kmActuel = currentKm(e);
      let nextDate = null, nextKm = null, etat = 'ok', jours = null, kmRestant = null;

      if(p.mois){
        if(last){
          const d = new Date(last.date);
          d.setMonth(d.getMonth() + Number(p.mois));
          nextDate = toISO(d);
          jours = Math.round((new Date(nextDate) - new Date()) / 86400000);
        }else{
          nextDate = null; jours = null;
        }
      }
      if(p.km){
        const refKm = last && last.km ? Number(last.km) : Number(e.kmDepart)||0;
        nextKm = refKm + Number(p.km);
        kmRestant = nextKm - kmActuel;
      }

      const dateUrgente = nextDate !== null && jours !== null && jours <= 0;
      const kmUrgent = kmRestant !== null && kmRestant <= 0;
      const dateProche = nextDate !== null && jours !== null && jours <= 30;
      const kmProche = kmRestant !== null && kmRestant <= 500;

      if((nextDate === null && nextKm === null)) etat = 'ok';
      else if(dateUrgente || kmUrgent) etat = 'critique';
      else if(dateProche || kmProche) etat = 'attention';
      else etat = 'ok';

      out.push({
        engin: e, prev: p, last, nextDate, nextKm, etat, jours, kmRestant, kmActuel
      });
    });
  });
  return out;
}

function currentKm(e){
  const kms = DB.charges
    .filter(c => c.enginId === e.id && c.km !== undefined && c.km !== null && c.km !== '')
    .map(c => Number(c.km));
  if(!kms.length) return Number(e.kmDepart)||0;
  return Math.max(...kms, Number(e.kmDepart)||0);
}

/* ---------- Sauvegarde / import ---------- */
function exportJSON(){
  return JSON.stringify(DB, null, 2);
}
function importJSON(text){
  const parsed = JSON.parse(text);
  if(!parsed || typeof parsed !== 'object' || !parsed.settings) throw new Error('Fichier invalide');
  const def = defaultState();
  DB = Object.assign(def, parsed, { settings: Object.assign(def.settings, parsed.settings||{}) });
  saveDB();
}

/* ---------- Données de démonstration ---------- */
function seedDemo(){
  const def = defaultState();
  def.engins = [
    { id:'e1', nom:'Pelle hydraulique PC-200', immat:'AB-123-CD', type:'Pelle', conducteur:'emp1', kmDepart:45000, consoRef:32, dateService:'2023-02-10', prixAchat:28000000 },
    { id:'e2', nom:'Chargeuse frontal L-90', immat:'EF-456-GH', type:'Chargeuse', conducteur:'emp2', kmDepart:12000, consoRef:25, dateService:'2024-01-15', prixAchat:19500000 },
    { id:'e3', nom:'Camion benne 10T', immat:'IJ-789-KL', type:'Camion', conducteur:'emp3', kmDepart:88000, consoRef:38, dateService:'2022-06-01', prixAchat:15000000 }
  ];
  def.employes = [
    { id:'emp1', nom:'Moussa D.', role:'conducteur' },
    { id:'emp2', nom:'Ibrahim K.', role:'conducteur' },
    { id:'emp3', nom:'Sory B.', role:'conducteur' },
    { id:'emp4', nom:'Amadou S.', role:'apprenti' },
    { id:'emp5', nom:'Karim T.', role:'apprenti' }
  ];
  def.settings.nom = 'ETS Débardage & Transferts';
  def.settings.objectifMensuel = 2000000;

  const now = new Date();
  const pad = x => String(x).padStart(2,'0');
  let k1 = 45000, k2 = 12000, k3 = 88000;

  for(let back = 5; back >= 0; back--){
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const y = d.getFullYear(), m = d.getMonth();
    const daysInMonth = new Date(y, m+1, 0).getDate();
    const maxDay = back === 0 ? Math.min(now.getDate(), daysInMonth) : daysInMonth;

    for(let day = 1; day <= maxDay; day += 1){
      const date = `${y}-${pad(m+1)}-${pad(day)}`;
      const engin = def.engins[Math.floor(Math.random()*def.engins.length)];
      if(Math.random() < 0.9){
        const q = 5 + Math.floor(Math.random()*14);
        def.travaux.push({ id:uid(), date, activiteId:'a1', enginId:engin.id, qte:q, prixUnitaire:5500,
          conducteur: engin.conducteur, client:'SCIEFA' });
      }
      if(Math.random() < 0.75){
        const q = 2 + Math.floor(Math.random()*7);
        def.travaux.push({ id:uid(), date, activiteId:'a2', enginId:engin.id, qte:q, prixUnitaire:4450,
          conducteur: engin.conducteur, client:'Zone Nord' });
      }
    }

    // Carburant chaque semaine
    for(let day = 4; day <= maxDay; day += 7){
      const date = `${y}-${pad(m+1)}-${pad(day)}`;
      const litres = 120 + Math.floor(Math.random()*160);
      const prixL = 750;
      const eIdx = (day/7 | 0) % 3;
      const e = def.engins[eIdx];
      if(eIdx===0){ k1 += 800 + Math.floor(Math.random()*400); def.charges.push({ id:uid(), date, categorie:'carburant', enginId:e.id, litres, prixLitre:prixL, montant:litres*prixL, km:k1 }); }
      else if(eIdx===1){ k2 += 400 + Math.floor(Math.random()*300); def.charges.push({ id:uid(), date, categorie:'carburant', enginId:e.id, litres, prixLitre:prixL, montant:litres*prixL, km:k2 }); }
      else { k3 += 1200 + Math.floor(Math.random()*600); def.charges.push({ id:uid(), date, categorie:'carburant', enginId:e.id, litres, prixLitre:prixL, montant:litres*prixL, km:k3 }); }
    }

    // Maintenance 1x / mois
    {
      const date = `${y}-${pad(m+1)}-${pad(Math.min(15, maxDay))}`;
      const types = ['Vidange moteur','Révision générale','Réparation'];
      const t = types[m % types.length];
      def.charges.push({ id:uid(), date, categorie:'maintenance', enginId:def.engins[m%3].id,
        typeMaint:t === 'Révision générale' ? 'Révision générale' : 'Vidange moteur',
        libelle:t, prestataire:'Garage central', montant: 45000 + Math.floor(Math.random()*8)*10000,
        km: [k1,k2,k3][m%3] });
    }

    // Salaires fin de mois
    {
      const date = `${y}-${pad(m+1)}-${pad(maxDay)}`;
      def.employes.forEach(emp => {
        const montant = emp.role === 'conducteur' ? 185000 : 75000;
        def.charges.push({ id:uid(), date, categorie:'salaire', employeId:emp.id,
          mois:`${y}-${pad(m+1)}`, montant, libelle:`Salaire ${emp.nom}` });
      });
    }
  }

  DB = def;
  saveDB();
}

/* ============================================================
   COMPARATIF PAR CONDUCTEUR
   CA généré + salaire = (nb transferts + nb ouvertures) × taux
   ============================================================ */
function computeConducteurs(range, enginId){
  const taux = Number(DB.settings.salaireOperation) || 500;
  const trav = filterTravaux(range, enginId);
  const ids = new Set();
  DB.employes.forEach(e => ids.add(e.id));
  trav.forEach(t => { if(t.conducteur) ids.add(t.conducteur); });
  DB.engins.forEach(e => { if(e.conducteur) ids.add(e.conducteur); });

  return Array.from(ids).map(id => {
    const emp = employeById(id);
    const nom = emp ? emp.nom : (enginById(id) ? '—' : id);
    const siens = trav.filter(t => t.conducteur === id);
    let transferts = 0, ouvertures = 0, autre = 0, ca = 0, nb = 0;
    siens.forEach(t => {
      const a = activiteById(t.activiteId);
      const lib = (a ? a.libelle : '').toLowerCase();
      const q = Number(t.qte) || 0;
      if(lib.includes('transfert') || lib.includes('voyage')) transferts += q;
      else if(lib.includes('débardage') || lib.includes('debardage') || lib.includes('ouverture')) ouvertures += q;
      else autre += q;
      ca += trvMontant(t);
      nb++;
    });
    const salaire = (transferts + ouvertures) * taux;
    return {
      id, nom: emp ? emp.nom : (nom || '—'), role: emp ? emp.role : 'autre',
      nb, transferts, ouvertures, autre, ca, salaire, taux,
      reste: ca - salaire
    };
  }).filter(r => r.nb > 0)
    .sort((a,b) => b.ca - a.ca);
}

/* ============================================================
   MONTANT EN TOUTES LETTRES (français)
   ============================================================ */
const _U = ['zéro','un','deux','trois','quatre','cinq','six','sept','huit','neuf','dix','onze','douze','treize','quatorze','quinze','seize','dix-sept','dix-huit','dix-neuf'];
const _D = ['','','vingt','trente','quarante','cinquante','soixante'];
function _sousCent(n){
  if(n < 20) return _U[n];
  const t = Math.floor(n/10), u = n%10;
  if(t <= 6){
    if(u === 0) return _D[t];
    if(u === 1) return _D[t] + ' et un';
    return _D[t] + '-' + _U[u];
  }
  if(t === 7){ return u === 1 ? 'soixante et onze' : 'soixante-' + _U[10+u]; }
  // 80-99 : quatre-vingt…
  if(t === 8){ return u === 0 ? 'quatre-vingts' : 'quatre-vingt' + (u === 1 ? '-un' : '-' + _U[u]); }
  // 90-99 : quatre-vingt-dix… (71 soixante-et-onze + 80 quatre-vingts gérés ci-dessus)
  return 'quatre-vingt' + (u === 0 ? '-dix' : '-' + _U[10 + u]);
}
function _sousMille(n){
  const c = Math.floor(n/100), r = n%100;
  if(c === 0) return r ? _sousCent(r) : '';
  let s = c === 1 ? 'cent' : _U[c] + ' cent';
  if(c > 1 && r === 0) s += 's';
  if(r) s += ' ' + _sousCent(r);
  return s;
}
function nbEnLettres(n){
  n = Math.floor(Math.abs(n));
  if(n === 0) return 'zéro';
  if(n > 999999999) return String(n);
  const millions = Math.floor(n/1000000);
  const milliers = Math.floor((n%1000000)/1000);
  const reste = n%1000;
  let s = '';
  if(millions) s += (millions === 1 ? 'un million' : _sousMille(millions) + ' millions');
  if(milliers) s += (s ? ' ' : '') + (milliers === 1 ? 'mille' : _sousMille(milliers) + ' mille');
  if(reste) s += (s ? ' ' : '') + _sousMille(reste);
  return s;
}
function montantEnLettres(montant){
  const dev = (DB.settings.devise || '').toUpperCase();
  let unite = '';
  if(dev === 'FCFA' || dev === 'XOF' || dev === 'XAF') unite = ' francs CFA';
  else if(dev === 'EUR' || dev === '€') unite = ' euros';
  else if(dev) unite = ' ' + dev;
  const n = Math.round(Math.abs(Number(montant)||0));
  let s = nbEnLettres(n) + unite;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ============================================================
   FACTURES
   ============================================================ */
function nextFactureNumero(){
  const an = new Date().getFullYear();
  const seq = (Number(DB.settings.factureCounter) || 0) + 1;
  return `FA-${an}-${String(seq).padStart(3,'0')}`;
}

/* Lignes de facture = travaux du client sur la période, regroupés par activité+engin+PU */
function factureLignes(client, du, au){
  const trav = DB.travaux
    .filter(t => (t.client || '').trim().toLowerCase() === (client || '').trim().toLowerCase())
    .filter(t => inRange(t.date, [du, au]))
    .sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const groups = [];
  const idx = {};
  trav.forEach(t => {
    const key = t.activiteId + '|' + (t.enginId||'') + '|' + (t.prixUnitaire||0);
    if(idx[key] === undefined){
      idx[key] = groups.length;
      groups.push({
        activiteId: t.activiteId, enginId: t.enginId, prix: Number(t.prixUnitaire)||0,
        libelle: (activiteById(t.activiteId)||{}).libelle || 'Travail',
        unite: (activiteById(t.activiteId)||{}).unite || 'unité',
        qte: 0, montant: 0, dates: []
      });
    }
    const g = groups[idx[key]];
    g.qte += Number(t.qte)||0;
    g.dates.push(t.date);
  });
  groups.forEach(g => {
    g.montant = g.qte * g.prix;
    g.du = g.dates[0]; g.au = g.dates[g.dates.length-1];
    delete g.dates;
  });
  return groups;
}

function factureTotals(lignes, tvaPct){
  const ht = lignes.reduce((s,l) => s + l.montant, 0);
  const tva = ht * (Number(tvaPct)||0) / 100;
  return { ht, tva, ttc: ht + tva };
}
