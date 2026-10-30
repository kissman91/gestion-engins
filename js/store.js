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
      sbUrl: 'https://vfziobbleugwmldohogl.supabase.co',
      sbKey: 'sb_publishable_Ty2XmyqUWTUEvTBe0a40cQ_QAbvyYiW',
      sbAuto: true
    },
    activites: [
      { id: 'a1', libelle: 'Transfert de pétioles', unite: 'voyage', prix: 5500 },
      { id: 'a2', libelle: 'Débardage', unite: 'ouverture', prix: 4450 }
    ],
    employes: [],
    utilisateurs: [],   // comptes locaux + privilèges (jamais synchronisés)
    engins: [],
    travaux: [],
    charges: [],
    factures: [],
    preventions: [
      { id: 'p1', libelle: 'Vidange moteur', km: 5000, mois: 6 },
      { id: 'p2', libelle: 'Révision générale', km: 10000, mois: 12 }
    ],
    __deleted: []   // tombstones : { collection, id } — suppressions à propager au cloud (jamais synchronisés comme données)
  };
}

/* Collections synchronisées avec le cloud (identifiants exclus) */
const SYNC_COLLECTIONS = ['engins','employes','activites','travaux','charges','preventions','factures','utilisateurs'];

/* Collections de référence : partagées entre tous les comptes (jamais filtrées par propriétaire) */
const REF_COLLECTIONS = ['engins','employes','activites','preventions','utilisateurs'];

/* Collections de saisie : appartiennent à l'utilisateur qui les a créées (champ _uid) */
const ENTRY_COLLECTIONS = ['travaux','charges','factures'];

/* Nettoyage des données de test/démo (mode production) */
function purgeMockData(db){
  if(!db) return;
  if(Array.isArray(db.travaux)){
    db.travaux = db.travaux.filter(t => t && t.client !== 'SCIEFA' && t.client !== 'Zone Nord');
  }
  if(Array.isArray(db.charges)){
    db.charges = db.charges.filter(c => c && !String(c.id||'').includes('-mv4wi58') && c.prestataire !== 'Garage central' && !(c.libelle||'').includes('Moussa D.'));
  }
}

let DB = loadDB();

function loadDB(){
  try{
    const raw = localStorage.getItem(DB_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      const def = defaultState();
      const s = Object.assign(def.settings, (parsed && parsed.settings) ? parsed.settings : {});
      if(!s.sbUrl) s.sbUrl = def.settings.sbUrl;
      if(!s.sbKey) s.sbKey = def.settings.sbKey;
      s.sbAuto = true;
      const loaded = Object.assign(def, parsed, { settings: s });
      purgeMockData(loaded);
      return loaded;
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

/* Marque une suppression locale pour qu'elle soit propagée au cloud (tombstone).
   Idempotent : n'ajoute jamais deux fois la même suppression.
   `uid` = propriétaire de la ligne supprimée (permet à son compte de voir la suppression). */
function markDeleted(collection, id, uid){
  DB.__deleted = DB.__deleted || [];
  if(!DB.__deleted.some(d => d.collection === collection && d.id === id)){
    DB.__deleted.push({ collection, id, _uid: uid });
  }
}

/* ---------- Utilitaires ---------- */
function toISO(d){
  if(typeof d === 'string') return d.slice(0,10);
  if(!(d instanceof Date) || isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function today(){ return toISO(new Date()); }
function monthKey(iso){ return (iso||'').slice(0,7); }
function fmtNum(n, dec){
  if(n === null || n === undefined || isNaN(n)) return '—';
  const num = Number(n);
  const d = dec !== undefined ? dec : (num % 1 !== 0 ? 2 : 0);
  return num.toLocaleString('fr-FR', { minimumFractionDigits: dec !== undefined ? d : 0, maximumFractionDigits: d });
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
  if(!t) return 0;
  if(t.montant !== undefined && t.montant !== null && t.montant !== '' && !isNaN(t.montant) && Number(t.montant) > 0){
    return Number(t.montant);
  }
  const q = Number(t.qte) || 0;
  const p = Number(t.prixUnitaire) || 0;
  return Math.round(q * p * 100) / 100;
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
  return rowsPour('travaux').filter(t =>
    inRange(t.date, range) && (!enginId || t.enginId === enginId));
}
function filterCharges(range, enginId){
  return rowsPour('charges').filter(c =>
    inRange(c.date, range) && (!enginId || c.enginId === enginId));
}

/* ---------- Consommation : km & litres ---------- */
/* km parcourus sur une période = dernier compteur connu avant/après la période */
function readingsFor(enginId){
  return rowsPour('charges')
    .filter(c => c.enginId === enginId && c.km !== undefined && c.km !== null && c.km !== '' && !isNaN(c.km))
    .map(c => ({ date: c.date, km: Number(c.km) }))
    .sort((a,b) => a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.km - b.km);
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
  const kms = rowsPour('charges')
    .filter(c => c.enginId === enginId && c.km !== undefined && c.km !== null && c.km !== '' && !isNaN(c.km))
    .map(c => Number(c.km));
  if(!kms.length) return 0;
  const depart = Number(e.kmDepart) > 0 ? Number(e.kmDepart) : Math.min(...kms);
  const max = Math.max(...kms);
  return Math.max(0, max - depart);
}

/* ---------- Rémunération conducteur (rattachée à l'engin) ---------- */
/* Découpe un travail en opérations payantes par type d'activité (voyage / ouverture) */
function opsTravail(t){
  const a = activiteById(t.activiteId);
  const lib = (a ? a.libelle : '').toLowerCase();
  const target = (lib + ' ' + (a && a.unite ? a.unite : '')).toLowerCase();
  const q = Number(t.qte) || 0;
  if(target.includes('transfert') || target.includes('voyage')) return { transferts: q, ouvertures: 0 };
  if(target.includes('débardage') || target.includes('debardage') || target.includes('ouverture')) return { transferts: 0, ouvertures: q };
  return { transferts: 0, ouvertures: 0 };
}

/* Salaire conducteur = activité réalisée avec l'engin × taux par opération.
   Coût direct de la machine : aucune charge « salaire » saisie n'est requise. */
function coutConducteur(range, enginId){
  const taux = Number(DB.settings.salaireOperation) || 500;
  let ops = 0;
  filterTravaux(range, enginId).forEach(t => {
    const o = opsTravail(t);
    ops += o.transferts + o.ouvertures;
  });
  return Math.round(ops * taux * 100) / 100;
}

/* ---------- Indicateurs principaux ---------- */
function computeKPIs(range, enginId){
  const trav = filterTravaux(range, enginId);
  const char = filterCharges(range, enginId);

  const ca = trav.reduce((s,t) => s + trvMontant(t), 0);
  const coutCond = coutConducteur(range, enginId);
  const depenses = char.reduce((s,c) => s + (Number(c.montant)||0), 0) + coutCond;
  const benefice = ca - depenses;
  const marge = ca > 0 ? (benefice / ca) * 100 : null;

  const parCat = { carburant:0, maintenance:0, salaire:0, autre:0 };
  char.forEach(c => { parCat[c.categorie] = (parCat[c.categorie]||0) + (Number(c.montant)||0); });
  // salaire conducteur = activité × taux ; les charges « salaire » saisies (primes, etc.) s'ajoutent
  parCat.salaire += coutCond;

  const litres = char.filter(c => c.categorie === 'carburant')
    .reduce((s,c) => s + (Number(c.litres)||0), 0);

  const km = kmParcours(range, enginId);
  const conso100 = km > 0 ? (litres / km) * 100 : null;
  const coutKm = km > 0 ? depenses / km : null;

  // Par activité
  const parActivite = {};
  let voyages = 0, ouvertures = 0, caVoyages = 0, caOuvertures = 0;
  trav.forEach(t => {
    const a = activiteById(t.activiteId);
    const key = a ? a.libelle : 'Autre';
    const lib = key.toLowerCase();
    const target = (lib + ' ' + (a && a.unite ? a.unite : '')).toLowerCase();
    const m = trvMontant(t);
    const q = Number(t.qte) || 0;
    if(!parActivite[key]) parActivite[key] = { qte:0, ca:0, unite: a ? a.unite : '' };
    parActivite[key].qte += q;
    parActivite[key].ca += m;
    if(target.includes('transfert') || target.includes('voyage')){
      voyages += q;
      caVoyages += m;
    } else if(target.includes('débardage') || target.includes('debardage') || target.includes('ouverture')){
      ouvertures += q;
      caOuvertures += m;
    }
  });

  return {
    ca, depenses, benefice, marge, parCat, litres, km, conso100, coutKm,
    nbTravaux: trav.length, nbCharges: char.length,
    voyages, ouvertures, caVoyages, caOuvertures,
    coutConducteur: coutCond,
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
      const intervs = rowsPour('charges')
        .filter(c => c.categorie === 'maintenance' && c.enginId === e.id && c.typeMaint === p.libelle)
        .sort((a,b) => (a.date < b.date ? 1 : -1));
      const last = intervs[0] || null;
      const kmActuel = currentKm(e);
      let nextDate = null, nextKm = null, etat = 'ok', jours = null, kmRestant = null;

      if(p.mois){
        const refDate = last ? last.date : (e.dateService || null);
        if(refDate){
          const d = new Date(refDate + 'T00:00:00');
          d.setMonth(d.getMonth() + Number(p.mois));
          nextDate = toISO(d);
          const nowMidnight = new Date();
          nowMidnight.setHours(0,0,0,0);
          jours = Math.round((new Date(nextDate + 'T00:00:00') - nowMidnight) / 86400000);
        }else{
          nextDate = null; jours = null;
        }
      }
      if(p.km){
        const refKm = last && last.km !== null && last.km !== undefined && !isNaN(last.km)
          ? Number(last.km)
          : (Number(e.kmDepart)||0);
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
  const kms = rowsPour('charges')
    .filter(c => c.enginId === e.id && c.km !== undefined && c.km !== null && c.km !== '' && !isNaN(c.km))
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
  const comptesActuels = (DB.utilisateurs || []).slice();
  DB = Object.assign(def, parsed, { settings: Object.assign(def.settings, parsed.settings||{}) });
  // une sauvegarde plus ancienne (sans comptes) ne doit pas verrouiller l'application
  if(!DB.utilisateurs || !DB.utilisateurs.length) DB.utilisateurs = comptesActuels;
  saveDB();
}

/* ---------- Données de démonstration (désactivées en production) ---------- */
function seedDemo(){
  console.warn('Mode production actif : la génération de données de démonstration est désactivée.');
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
      const o = opsTravail(t);
      transferts += o.transferts;
      ouvertures += o.ouvertures;
      autre += (Number(t.qte)||0) - o.transferts - o.ouvertures;
      ca += trvMontant(t);
      nb++;
    });
    const salaire = Math.round((transferts + ouvertures) * taux * 100) / 100;
    ca = Math.round(ca * 100) / 100;
    return {
      id, nom: emp ? emp.nom : (nom || '—'), role: emp ? emp.role : 'autre',
      nb, transferts, ouvertures, autre, ca, salaire, taux,
      reste: Math.round((ca - salaire) * 100) / 100
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
  const milliards = Math.floor(n/1000000000);
  const millions = Math.floor((n%1000000000)/1000000);
  const milliers = Math.floor((n%1000000)/1000);
  const reste = n%1000;
  let s = '';
  if(milliards) s += (milliards === 1 ? 'un milliard' : _sousMille(milliards) + ' milliards');
  if(millions) s += (s ? ' ' : '') + (millions === 1 ? 'un million' : _sousMille(millions) + ' millions');
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
  const trav = rowsPour('travaux')
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
    g.montant = Math.round((g.qte * g.prix) * 100) / 100;
    g.du = g.dates[0]; g.au = g.dates[g.dates.length-1];
    delete g.dates;
  });
  return groups;
}

function factureTotals(lignes, tvaPct){
  const ht = Math.round((lignes||[]).reduce((s,l) => s + (Number(l.montant)||0), 0) * 100) / 100;
  const pct = Number(tvaPct)||0;
  const tva = Math.round((ht * pct / 100) * 100) / 100;
  const ttc = Math.round((ht + tva) * 100) / 100;
  return { ht, tva, ttc };
}

/* ============================================================
   UTILISATEURS & PRIVILÈGES
   Comptes locaux (ce navigateur) : identifiant + mot de passe haché,
   rôle prédéfini ou liste de privilèges personnalisée.
   ============================================================ */

/* Modules = vues de l'application ; actions = vue / edit / suppr */
const PRIV_MODULES = [
  { key:'dashboard',   label:'Tableau de bord' },
  { key:'travaux',     label:'Travaux réalisés' },
  { key:'terrain',     label:'Saisie rapide (terrain)' },
  { key:'charges',     label:'Charges' },
  { key:'factures',    label:'Factures' },
  { key:'engins',      label:'Engins' },
  { key:'maintenance', label:'Maintenance' },
  { key:'rapports',    label:'Rapports' },
  { key:'parametres',  label:'Paramètres' },
  { key:'utilisateurs',label:'Utilisateurs & privilèges' }
];
const PRIV_ACTIONS = [
  { key:'vue',   label:'Voir' },
  { key:'edit',  label:'Créer / modifier' },
  { key:'suppr', label:'Supprimer' }
];
const PRIV_GLOBAL = [
  { key:'export', label:'Exporter les données (CSV / sauvegarde)' },
  { key:'sync',   label:'Synchronisation cloud (Supabase)' }
];

function allPrivs(){
  const out = [];
  PRIV_MODULES.forEach(m => PRIV_ACTIONS.forEach(a => out.push(m.key + ':' + a.key)));
  PRIV_GLOBAL.forEach(g => out.push('global:' + g.key));
  return out;
}
function privs(...mods){            // privs('travaux:vue','charges:edit') → liste
  return mods;
}

/* Rôles prédéfinis : chacun donne une liste de privilèges de départ */
const ROLES = {
  admin: {
    label: 'Administrateur',
    desc: 'Tous les droits, y compris la création des comptes et des privilèges.',
    privs: () => allPrivs()
  },
  gestion: {
    label: 'Gestionnaire',
    desc: 'Saisit les travaux et les charges, gère toutes les données et crée les comptes (conducteurs, consultation). Pas de comptes admin ni gestionnaire.',
    privs: () => privs(
      'dashboard:vue','travaux:vue','travaux:edit','travaux:suppr',
      'terrain:vue','terrain:edit','terrain:suppr',
      'charges:vue','charges:edit','charges:suppr',
      'factures:vue','factures:edit','factures:suppr',
      'engins:vue','engins:edit','engins:suppr',
      'maintenance:vue','maintenance:edit','maintenance:suppr',
      'rapports:vue','parametres:vue','parametres:edit',
      'utilisateurs:vue','utilisateurs:edit',
      'global:export','global:sync')
  },
  saisie: {
    label: 'Conducteur (saisie terrain)',
    desc: 'Saisit les travaux depuis le chantier, corrige ses saisies. Ni finances, ni paramètres. Ne voit que ses propres saisies.',
    restrictedData: true,
    privs: () => privs(
      'travaux:vue','travaux:edit','travaux:suppr',
      'terrain:vue','terrain:edit','terrain:suppr',
      'engins:vue','maintenance:vue','dashboard:vue',
      'global:sync')
  },
  lecture: {
    label: 'Consultation seule',
    desc: 'Voit les tableaux de bord, travaux, charges et rapports, sans rien modifier.',
    privs: () => privs(
      'dashboard:vue','travaux:vue','charges:vue','factures:vue',
      'engins:vue','maintenance:vue','rapports:vue',
      'global:export')
  },
  perso: {
    label: 'Personnalisé',
    desc: 'Liste de privilèges définie manuellement ci-dessous.',
    privs: () => []
  }
};

/* ---------- Comptes ---------- */
function utilisateurs(){ if(!DB.utilisateurs) DB.utilisateurs = []; return DB.utilisateurs; }
function userById(id){ return utilisateurs().find(u => u.id === id) || null; }
function userByLogin(login){
  const l = String(login||'').trim().toLowerCase();
  return utilisateurs().find(u => (u.login||'').toLowerCase() === l) || null;
}
function loginDispo(login, excludeId){
  const l = String(login||'').trim().toLowerCase();
  if(!l) return false;
  return !utilisateurs().some(u => u.id !== excludeId && (u.login||'').toLowerCase() === l);
}
function adminActifs(){ return utilisateurs().filter(u => u.actif && u.role === 'admin'); }

/* Comptes « protégés » : seul un administrateur les crée ou les modifie */
function estProtege(u){ return !!u && (u.role === 'admin' || u.role === 'gestion'); }
function peutGererCompte(cible, moi){
  if(!cible) return false;
  const m = moi || currentUser();
  if(!m) return false;
  if(m.role === 'admin') return true;
  return m.role === 'gestion' && !estProtege(cible);
}

/* Mot de passe : SHA-256 salé (contexte https), repli simple hors contexte sécurisé */
function newSalt(){
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
async function hashMdp(mdp, sel){
  const s = String(sel||'') + '|' + String(mdp||'');
  if(typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined'){
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return 'sha256$' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }
  // repli (page ouverte en http) : hachage rapide, moins résistant
  let h1 = 5381, h2 = 52711;
  for(let i = 0; i < s.length; i++){
    h1 = ((h1 * 33) ^ s.charCodeAt(i)) >>> 0;
    h2 = ((h2 * 37) + s.charCodeAt(i)) >>> 0;
  }
  return 'fnv$' + h1.toString(16).padStart(8,'0') + h2.toString(16).padStart(8,'0');
}
async function setMdp(user, mdp){
  user.sel = newSalt();
  user.hash = await hashMdp(mdp, user.sel);
}
async function checkMdp(user, mdp){
  if(!user || !user.hash) return false;
  return (await hashMdp(mdp, user.sel || '')) === user.hash;
}

/* ---------- Session ---------- */
const SESSION_TAB = 'gestion_engins_session';   // onglet courant
const SESSION_LONG = 'gestion_engins_session_perso';  // « rester connecté »
let _sessionUser = null;

function sessionStore(remember){ return remember ? localStorage : sessionStorage; }
function sessionRead(){
  try{
    const raw = sessionStorage.getItem(SESSION_TAB) || localStorage.getItem(SESSION_LONG);
    if(!raw) return null;
    const s = JSON.parse(raw);
    return s && s.userId ? s : null;
  }catch(e){ return null; }
}
function sessionWrite(userId, remember){
  try{
    sessionStorage.removeItem(SESSION_TAB);
    localStorage.removeItem(SESSION_LONG);
    const raw = JSON.stringify({ userId, remember: !!remember, at: new Date().toISOString() });
    sessionStore(remember).setItem(remember ? SESSION_LONG : SESSION_TAB, raw);
  }catch(e){}
}
function sessionClear(){
  try{
    sessionStorage.removeItem(SESSION_TAB);
    localStorage.removeItem(SESSION_LONG);
  }catch(e){}
  _sessionUser = null;
}
function currentUser(){
  if(_sessionUser){
    const live = userById(_sessionUser.id);
    if(live && live.actif) return live;
    sessionClear();
    return null;
  }
  const s = sessionRead();
  if(!s) return null;
  const u = userById(s.userId);
  if(!u || !u.actif){ sessionClear(); return null; }
  _sessionUser = u;
  return u;
}

/* ---------- Droits ---------- */
function userPrivs(u){
  if(!u) return [];
  if(u.role === 'admin') return allPrivs();
  if(u.role && u.role !== 'perso' && ROLES[u.role]) return ROLES[u.role].privs();
  return Array.isArray(u.privileges) ? u.privileges : [];
}
function can(cle){
  const u = currentUser();
  if(!u) return false;
  return userPrivs(u).includes(cle);
}
function canMod(mod, action){ return can(mod + ':' + action); }

/* ---------- Visibilité des données par propriétaire ---------- */

/* Comptes dont les saisies sont restreintes : ils ne voient que leurs propres lignes (_uid).
   Les autres (admin, gestionnaire, consultation) consolident toutes les saisies. */
function estRestreintDonnees(u){
  u = u || currentUser();
  return !!(u && ROLES[u.role] && ROLES[u.role].restrictedData);
}

/* Un utilisateur restreint peut-il voir / modifier / supprimer cette ligne ? */
function estProprietaire(coll, row){
  const u = currentUser();
  if(!u) return true;
  if(!estRestreintDonnees(u)) return true;
  if(REF_COLLECTIONS.includes(coll)) return true;   // données de référence partagées
  return !!(row && row._uid && row._uid === u.id);
}

/* Lecture d'une collection scellée à l'utilisateur connecté :
   - admin / gestionnaire / consultation : toutes les lignes ;
   - conducteur (saisie) : uniquement ses lignes (champ _uid) sur les collections de saisie ;
   - collections de référence : toujours complètes. */
function rowsPour(coll){
  const rows = DB[coll] || [];
  const u = currentUser();
  if(!u || !estRestreintDonnees(u)) return rows;
  if(REF_COLLECTIONS.includes(coll)) return rows;
  return rows.filter(r => r && r._uid === u.id);
}
function privsAccordables(){          // on n'accorde que ce qu'on possède soi-même
  const u = currentUser();
  if(!u) return [];
  if(u.role === 'admin') return allPrivs();
  // un non-admin ne peut pas déléguer la gestion des comptes
  return userPrivs(u).filter(c => c.indexOf('utilisateurs:') !== 0);
}

/* ---------- Connexion ---------- */
let _essais = { n:0, until:0 };
async function login(identifiant, mdp, remember){
  const maintenant = Date.now();
  if(maintenant < _essais.until){
    throw new Error('Trop de tentatives — réessayez dans ' + Math.ceil((_essais.until - maintenant)/1000) + ' s');
  }
  const u = userByLogin(identifiant);
  const ok = u && u.actif && await checkMdp(u, mdp);
  if(!ok){
    _essais.n++;
    if(_essais.n >= 5){ _essais.until = maintenant + 60000; _essais.n = 0; }
    throw new Error('Identifiant ou mot de passe incorrect');
  }
  _essais = { n:0, until:0 };
  noterConnexion(u);
  ouvrirSession(u, remember);
  return u;
}

/* Dernière connexion : notée sur cet appareil uniquement (jamais synchronisée) */
const LOGIN_MARK = 'gestion_engins_login_';
function noterConnexion(u){
  try{ localStorage.setItem(LOGIN_MARK + u.id, new Date().toISOString()); }catch(e){}
}
function derniereConnexionLocal(id){
  try{ return localStorage.getItem(LOGIN_MARK + id) || ''; }catch(e){ return ''; }
}
function ouvrirSession(u, remember){
  _sessionUser = u;
  sessionWrite(u.id, remember);
}
function logout(){ sessionClear(); }

function privsDeRole(role){
  return ROLES[role] ? ROLES[role].privs() : [];
}

/* Création ou modification d'un compte (mot de passe laissé vide = inchangé) */
async function enregistrerUtilisateur(data){
  const nom = String(data.nom||'').trim();
  const login = String(data.login||'').trim();
  const mdp = String(data.mdp||'');
  if(!nom) throw new Error('Nom manquant');
  if(!login) throw new Error('Identifiant manquant');
  if(!loginDispo(login, data.id || null)) throw new Error('Identifiant déjà utilisé');
  if(!ROLES[data.role]) throw new Error('Rôle inconnu');

  const existant = data.id ? userById(data.id) : null;
  const moi = currentUser();
  if(!utilisateurs().length){
    // premier appareil : création libre du tout premier compte
  }else if(!moi){
    throw new Error('Connexion requise');
  }else{
    if(existant && !peutGererCompte(existant, moi))
      throw new Error('Compte protégé : seul un administrateur peut le modifier');
    if(!existant && moi.role !== 'admin' && estProtege({ role:data.role }))
      throw new Error('Seul un administrateur peut créer un compte administrateur ou gestionnaire');
  }

  let u = existant;
  if(!u){
    if(mdp.length < 4) throw new Error('Mot de passe : 4 caractères minimum');
    u = { id: uid(), nom, login, role: data.role, privileges: [],
          actif: data.actif !== false, employeId: data.employeId || '',
          creeLe: new Date().toISOString() };
    await setMdp(u, mdp);
    utilisateurs().push(u);
  }else{
    u.nom = nom; u.login = login;
    u.actif = data.actif !== false;
    u.employeId = data.employeId || '';
    if(mdp){
      if(mdp.length < 4) throw new Error('Mot de passe : 4 caractères minimum');
      await setMdp(u, mdp);
    }
  }
  u.role = data.role;
  u.privileges = u.role === 'admin' ? allPrivs()
    : (Array.isArray(data.privileges) ? data.privileges.slice() : privsDeRole(u.role));
  saveDB();
  return u;
}

function supprimerUtilisateur(id){
  const u = userById(id);
  if(!u) return;
  const moi = currentUser();
  if(moi && moi.id === id) throw new Error('Vous ne pouvez pas supprimer votre propre compte');
  if(u.role === 'admin' && u.actif && adminActifs().length === 1)
    throw new Error('Impossible : c\'est le seul compte administrateur actif');
  if(!peutGererCompte(u, moi))
    throw new Error('Compte protégé : seul un administrateur peut le supprimer');
  DB.utilisateurs = utilisateurs().filter(x => x.id !== id);
  saveDB();
}


