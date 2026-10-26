/* ============================================================
   Tests de la synchronisation corrigée (js/sync.js + js/store.js)
   Vérifie :
     1. Le pull ne supprime PLUS les saisies locales absentes du cloud
        (bug de purge destructrice — cause des saisies manquantes).
     2. Un tombeau cloud ({deleted:true}) supprime la copie locale.
     3. Le push propage les suppressions (tombeaux) avant les upserts.
     4. sbFetchAll pagine intégralement (Range / content-range).
     5. (Lecture seule) pull réel contre le cloud Supabase du projet.
   Usage : node tests/test-sync.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DB_KEY = 'gestion_engins_db_v1';

function freshEnv(seedDB, fetchMock){
  const storage = new Map();
  const sstorage = new Map();
  if(seedDB) storage.set(DB_KEY, JSON.stringify(seedDB));
  const ctx = {
    console, JSON, Date, Math, isNaN, Number, String, Array, Object, Set, Error, Promise,
    localStorage: {
      getItem: k => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    sessionStorage: {
      getItem: k => sstorage.has(k) ? sstorage.get(k) : null,
      setItem: (k, v) => sstorage.set(k, String(v)),
      removeItem: k => sstorage.delete(k)
    },
    fetch: fetchMock || (async () => { throw new Error('fetch non mocké'); })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'store.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'sync.js'), 'utf8'), ctx);
  vm.runInContext('this.__db = () => DB;', ctx);
  return { ctx, storage, getDB: () => JSON.parse(storage.get(DB_KEY)) };
}

/* Réponse HTTP minimale pour le mock fetch */
function jsonResponse(body, contentRange){
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const hdrs = {
    'content-type': 'application/json'
  };
  if(contentRange) hdrs['content-range'] = contentRange;
  return {
    ok: true, status: 200,
    headers: { get: n => hdrs[String(n).toLowerCase()] },
    json: async () => JSON.parse(text),
    text: async () => text
  };
}

let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else{ fail++; console.error('  ✗ ÉCHEC : ' + name); }
}

/* ============ Test 1 : le pull ne purge plus les saisies locales ============
   Cloud réel du projet : 4 travaux. Device admin : 10 travaux locaux
   déjà synchronisés + les 4 du cloud. Avant le correctif : 10/10 supprimés. */
function testPullNePurgePlus(){
  console.log('\n[1] Pull : les saisies locales absentes du cloud survivent');
  const seed = {
    settings: { nom: 'Test', sbUrl: 'https://test.supabase.co', sbKey: 'k' },
    activites: [], employes: [], utilisateurs: [],
    engins: [], travaux: [], charges: [], factures: [], preventions: [],
    __deleted: []
  };
  const env = freshEnv(seed, async () => jsonResponse([
    { collection: 'travaux', id: 'id-zbfxp68-mv8oyo8m', payload: { id: 'id-zbfxp68-mv8oyo8m', _at: '2026-10-14T22:38:40.438Z' }, updated_at: '2026-10-14T22:38:40.438+00:00' },
    { collection: 'travaux', id: 'id-gk69gfb-mv8p0u9r', payload: { id: 'id-gk69gfb-mv8p0u9r', _at: '2026-10-14T22:40:21.567Z' }, updated_at: '2026-10-14T22:40:21.567+00:00' },
    { collection: 'travaux', id: 'id-lbjlehu-mvazc7ze', payload: { id: 'id-lbjlehu-mvazc7ze', _at: '2026-10-16T13:04:41.066Z' }, updated_at: '2026-10-16T13:04:41.066+00:00' },
    { collection: 'travaux', id: 'id-qq0cnjd-mvazf352', payload: { id: 'id-qq0cnjd-mvazf352', _at: '2026-10-16T13:06:54.758Z' }, updated_at: '2026-10-16T13:06:54.758+00:00' }
  ], '0-3/4'));
  const db = env.ctx.__db();
  for(let i = 1; i <= 10; i++){
    db.travaux.push({ id: 'id-loc-' + i, date: '2026-10-' + (i < 10 ? '0' + i : i), _at: '2026-10-12T0' + (i % 10) + ':00:00.000Z' });
  }
  // + les 4 travaux déjà tirés du cloud dans une synchro précédente
  ['id-zbfxp68-mv8oyo8m', 'id-gk69gfb-mv8p0u9r'].forEach(id => {
    db.travaux.push({ id, date: '2026-10-14', _at: '2026-10-14T22:38:40.438Z' });
  });

  env.ctx.syncPull().then(r => {
    const ids = env.getDB().travaux.map(t => t.id);
    ok(ids.filter(x => x.startsWith('id-loc-')).length === 10, '10 travaux locaux conservés');
    ok(ids.includes('id-lbjlehu-mvazc7ze'), 'travaux du cloud intégrés (id-lbjlehu)');
    ok(ids.includes('id-qq0cnjd-mvazf352'), 'travaux du cloud intégrés (id-qq0cnjd)');
    ok(env.getDB().travaux.length === 14, '14 travaux au total (10 locaux + 4 cloud)');
  });
}

/* ============ Test 2 : un tombeau cloud supprime la copie locale ============ */
function testTombeauCloud(){
  console.log('\n[2] Pull : un tombeau cloud ({deleted:true}) supprime la copie locale');
  const seed = {
    settings: { nom: 'Test', sbUrl: 'https://test.supabase.co', sbKey: 'k' },
    activites: [], employes: [], utilisateurs: [],
    engins: [], travaux: [ { id: 't-sup', date: '2026-10-10', _at: '2026-10-10T10:00:00.000Z' } ],
    charges: [], factures: [], preventions: [], __deleted: []
  };
  const env = freshEnv(seed, async () => jsonResponse([
    { collection: 'travaux', id: 't-sup', payload: { id: 't-sup', deleted: true, _deletedAt: '2026-10-16T00:00:00.000Z' }, updated_at: '2026-10-16T00:00:00.000+00:00' }
  ], '0-0/1'));
  env.ctx.syncPull().then(r => {
    const db = env.getDB();
    ok(!db.travaux.some(t => t.id === 't-sup'), 'travail supprimé localement');
    ok(db.__deleted.some(d => d.collection === 'travaux' && d.id === 't-sup'), 'tombstone local enregistré (jamais re-poussé)');
  });
}

/* ============ Test 3 : le push propage les suppressions puis upsert ============ */
function testPushTombeaux(){
  console.log('\n[3] Push : tombeaux envoyés avant les lignes modifiées');
  const calls = [];
  const fetchMock = async (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return jsonResponse([{ ok: true }], '0-0/1');
  };
  const seed = {
    settings: { nom: 'Test', sbUrl: 'https://test.supabase.co', sbKey: 'k' },
    activites: [], employes: [], utilisateurs: [],
    engins: [], travaux: [ { id: 't-new', date: '2026-10-16', _at: '2026-10-16T14:00:00.000Z' } ],
    charges: [], factures: [], preventions: [],
    __deleted: [ { collection: 'travaux', id: 't-del' }, { collection: 'charges', id: 'c-del' } ]
  };
  const env = freshEnv(seed, fetchMock);
  env.ctx.syncPull = async () => ({ added: 0, updated: 0, removed: 0 }); // désactivé pour ce test
  env.ctx.syncPush().then(r => {
    ok(calls.length === 2, '2 requêtes POST (' + calls.length + ')');
    const first = calls[0].body;
    ok(Array.isArray(first) && first.length === 2, '1re requête : les 2 tombeaux');
    ok(first.every(x => x.payload && x.payload.deleted === true), 'tombeaux marqués deleted:true');
    const second = calls[1].body;
    ok(Array.isArray(second) && second.length === 1 && second[0].id === 't-new', '2e requête : la ligne modifiée');
    ok(env.getDB().__deleted.length === 0, '__deleted vidé après envoi réussi');
    ok(r.deleted === 2 && r.sent === 1, 'compteurs corrects (deleted=2, sent=1)');
  });
}

/* ============ Test 4 : pagination intégrale (Range / content-range) ============ */
function testPagination(){
  console.log("\n[4] sbFetchAll pagine jusqu'à la dernière ligne");
  const pages = [];
  let calls = 0;
  const fetchMock = async (url, opts) => {
    calls++;
    const range = opts.headers.Range; // ex. "0-999"
    const start = Number(range.split('-')[0]);
    const items = [];
    for(let i = start; i < Math.min(start + 1000, 2500); i++) items.push({ id: 'r' + i });
    pages.push(items.length);
    return jsonResponse(items, start + '-' + (start + items.length - 1) + '/2500');
  };
  const seed = {
    settings: { nom: 'Test', sbUrl: 'https://test.supabase.co', sbKey: 'k' },
    activites: [], employes: [], utilisateurs: [],
    engins: [], travaux: [], charges: [], factures: [], preventions: [], __deleted: []
  };
  const env = freshEnv(seed, fetchMock);
  env.ctx.sbFetchAll('/rest/v1/data?select=id').then(rows => {
    ok(rows.length === 2500, '2500 lignes récupérées (au lieu de 5000 max. tronquées → ici intact)');
    ok(calls === 3, '3 pages fetchées (' + calls + ')');
  });
}

/* ============ Test 5 (lecture seule) : pull réel contre le cloud du projet ============ */
function testPullReel(){
  console.log('\n[5] Pull réel Supabase (lecture seule) : les données locales survivent');
  let conf = {};
  try{
    const lines = fs.readFileSync(path.join(ROOT, 'superbase.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
    conf.url = (lines[1] || '').trim().replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');
    conf.key = (lines[2] || '').trim();
  }catch(e){}
  if(!conf.url || !conf.key){
    console.log('  ⚠ superbase.txt absent : test réel ignoré');
    return Promise.resolve();
  }
  const seed = {
    settings: { nom: 'Test', sbUrl: conf.url, sbKey: conf.key },
    activites: [], employes: [], utilisateurs: [],
    engins: [], travaux: [], charges: [], factures: [], preventions: [],
    __deleted: []
  };
  for(let i = 1; i <= 5; i++){
    seed.travaux.push({ id: 'reel-loc-' + i, date: '2026-10-0' + i, _at: '2026-10-0' + i + 'T08:00:00.000Z' });
  }
  const env = freshEnv(seed, fetch);   // fetch natif Node : requête GET réelle, lecture seule
  return env.ctx.syncPull().then(r => {
    const db = env.getDB();
    const locaux = db.travaux.filter(t => t.id.startsWith('reel-loc-')).length;
    ok(locaux === 5, '5 travaux locaux conservés après le pull réel');
    ok(db.travaux.length >= 5, 'cloud intégré (total=' + db.travaux.length + ')');
  }).catch(e => {
    fail++;
    console.error('  ✗ Pull réel impossible : ' + e.message);
  });
}

/* ============ Test 6 : visibilité par propriétaire (_uid) ============
   Admin/gestionnaire voient tout ; conducteur (saisie) ne voit que ses lignes. */
function testVisibiliteProprietaire(){
  console.log('\n[6] Visibilité des saisies par propriétaire (_uid)');
  const adminId = 'u-admin', jonasId = 'u-jonas';
  const seed = {
    settings: { nom: 'Test', sbUrl: 'https://test.supabase.co', sbKey: 'k' },
    activites: [{ id: 'a1', libelle: 'Transfert', unite: 'voyage', prix: 5500 }],
    employes: [], engins: [{ id: 'e1', nom: 'Engin 1' }],
    utilisateurs: [
      { id: adminId, nom: 'Admin', login: 'admin', role: 'admin', actif: true },
      { id: jonasId, nom: 'Jonas', login: 'jonas', role: 'saisie', actif: true }
    ],
    travaux: [
      { id: 't-admin', date: '2026-10-01', _uid: adminId, _at: '2026-10-01T00:00:00.000Z' },
      { id: 't-jonas', date: '2026-10-02', _uid: jonasId, _at: '2026-10-02T00:00:00.000Z' },
      { id: 't-ancien', date: '2026-10-03', _at: '2026-10-03T00:00:00.000Z' }   // héritage sans propriétaire
    ],
    charges: [], factures: [], preventions: [], __deleted: []
  };
  const env = freshEnv(seed, async () => jsonResponse([], '0--1/0'));

  env.ctx.sessionWrite(adminId, false);
  let v = env.ctx.rowsPour('travaux').map(t => t.id);
  ok(v.length === 3, 'admin voit toutes les saisies (' + v.length + '/3)');

  env.ctx.sessionClear();
  env.ctx.sessionWrite(jonasId, false);
  v = env.ctx.rowsPour('travaux').map(t => t.id);
  ok(v.length === 1 && v[0] === 't-jonas', 'conducteur ne voit que SES saisies (' + v.join(',') + ')');
  ok(env.ctx.rowsPour('engins').length === 1, 'conducteur voit quand même les références (engins)');
  ok(!env.ctx.estProprietaire('travaux', { id: 't-admin', _uid: adminId }), 'conducteur ne peut pas modifier la saisie d\'autrui');
  ok(env.ctx.estProprietaire('travaux', { id: 't-jonas', _uid: jonasId }), 'conducteur peut modifier sa propre saisie');
}

/* ============ Test 7 : le pull d'un conducteur est filtré par _uid ============ */
function testPullFiltreConducteur(){
  console.log('\n[7] Pull conducteur : URL filtrée par _uid, références complètes');
  const jonasId = 'u-jonas', adminId = 'u-admin';
  const urls = [];
  const fetchMock = async (url) => {
    urls.push(url);
    if(url.includes('payload->>_uid')){
      // le cloud ne renvoie QUE les saisies de Jonas
      return jsonResponse([
        { collection: 'travaux', id: 't-jonas', payload: { id: 't-jonas', _uid: jonasId }, updated_at: '2026-10-02T00:00:00Z' },
        { collection: 'charges', id: 'c-jonas', payload: { id: 'c-jonas', _uid: jonasId }, updated_at: '2026-10-02T01:00:00Z' }
      ], '0-1/2');
    }
    return jsonResponse([
      { collection: 'engins', id: 'e1', payload: { id: 'e1' }, updated_at: '2026-10-01T00:00:00Z' },
      { collection: 'activites', id: 'a1', payload: { id: 'a1' }, updated_at: '2026-10-01T00:00:00Z' }
    ], '0-1/2');
  };
  const seed = {
    settings: { nom: 'Test', sbUrl: 'https://test.supabase.co', sbKey: 'k' },
    activites: [], employes: [], utilisateurs: [
      { id: adminId, nom: 'Admin', login: 'admin', role: 'admin', actif: true },
      { id: jonasId, nom: 'Jonas', login: 'jonas', role: 'saisie', actif: true }
    ],
    engins: [], travaux: [], charges: [], factures: [], preventions: [], __deleted: []
  };
  const env = freshEnv(seed, fetchMock);
  env.ctx.sessionWrite(jonasId, false);
  return env.ctx.syncPull().then(() => {
    const db = env.getDB();
    const filtres = urls.filter(u => u.includes('payload->>_uid=eq.' + encodeURIComponent(jonasId))).length;
    ok(filtres >= 1, 'requête de pull filtrée par _uid envoyée (' + filtres + ')');
    ok(!db.travaux.some(t => t.id === 't-admin'), 'la saisie de l\'admin n\'est PAS téléchargée par le conducteur');
    ok(db.travaux.some(t => t.id === 't-jonas'), 'la saisie de Jonas est téléchargée');
    ok(db.charges.some(c => c.id === 'c-jonas'), 'la charge de Jonas est téléchargée');
    ok(db.engins.length === 1, 'références (engins) téléchargées');
  });
}

testPullNePurgePlus();
testTombeauCloud();
testPushTombeaux();
testPagination();
testVisibiliteProprietaire();
testPullFiltreConducteur();
setTimeout(() => testPullReel().then(() => {
  console.log('\nRésultat : ' + pass + ' ok, ' + fail + ' échec(s)');
  process.exit(fail ? 1 : 0);
}), 50);
