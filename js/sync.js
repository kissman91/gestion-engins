/* ============ sync.js — Synchronisation Supabase (PostgREST + Realtime) ============
   Modèle : une table `data` (collection, id, payload jsonb, updated_at).
   Push : envoie les lignes modifiées (_at > dernier push connu).
   Pull : récupère les lignes plus récentes que notre dernier pull.
   Résolution de conflit : dernier écrivain gagne (updated_at).
   Realtime : WebSocket Supabase JS v2 pour propagation instantanée entre appareils.
   Les identifiants Supabase (sbUrl/sbKey) restent locaux, jamais poussés.
*/

const SYNC_META_KEY = 'gestion_engins_sync_meta_v1';

function syncConf(){
  return {
    url: (DB.settings.sbUrl || '').trim()
      .replace(/\/+$/, '')              // slashes de fin
      .replace(/\/rest\/v1$/i, ''),     // accepte aussi l'URL « …/rest/v1 » collée telle quelle
    key: (DB.settings.sbKey || '').trim()
  };
}
function syncReady(){
  const c = syncConf();
  return !!(c.url && c.key);
}
function syncMeta(){
  try{ return JSON.parse(localStorage.getItem(SYNC_META_KEY)) || {}; }
  catch(e){ return {}; }
}
function setSyncMeta(m){
  try{ localStorage.setItem(SYNC_META_KEY, JSON.stringify(m)); }catch(e){}
}

function sbHeaders(extra){
  const c = syncConf();
  return Object.assign({
    'apikey': c.key,
    'Authorization': 'Bearer ' + c.key,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function sbFetch(path, opts){
  const c = syncConf();
  if(!syncReady()) throw new Error('Connexion Supabase non configurée (Paramètres).');
  const o = Object.assign({}, opts || {});
  o.headers = sbHeaders(o.headers || {});
  const res = await fetch(c.url + path, o);
  await _checkRes(res);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : null;
}

/* Convertit une réponse HTTP en erreur lisible (ou ne fait rien si la requête a réussi) */
async function _checkRes(res){
  if(res.ok) return;
  let msg = '';
  try{ msg = (await res.text()).slice(0, 300); }catch(e){}
  if(res.status === 401){
    msg += ' → clé refusée : collez la clé « publishable » (ou anon) du bon projet, sans espace ni retour à la ligne, et vérifiez qu\'elle n\'a pas été regénérée depuis.';
  }
  if(res.status === 404 && msg.indexOf('PGRST125') >= 0){
    msg += ' → l\'URL doit être celle du projet (https://xxxx.supabase.co) ; l\'application ajoute elle-même « /rest/v1 ». Vérifiez aussi d\'avoir bien exécuté supabase.sql dans ce projet.';
  }
  throw new Error('Erreur Supabase ' + res.status + (msg ? ' : ' + msg : ''));
}

/* GET paginé intégral : récupère TOUTES les lignes (pas de troncature à 5000),
   sinon la fusion confondrait des lignes absentes de la page avec des suppressions. */
async function sbFetchAll(path){
  const c = syncConf();
  if(!syncReady()) throw new Error('Connexion Supabase non configurée (Paramètres).');
  const PAGE = 1000;
  let out = [];
  let offset = 0;
  for(;;){
    const res = await fetch(c.url + path, {
      method: 'GET',
      headers: sbHeaders({ Range: offset + '-' + (offset + PAGE - 1) })
    });
    await _checkRes(res);
    const ct = res.headers.get('content-type') || '';
    if(!ct.includes('json')) break;
    const page = await res.json();
    out = out.concat(page);
    const cr = res.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)$/);
    const total = m ? Number(m[1]) : 0;
    const got = page.length;
    if(got === 0 || got < PAGE || (total > 0 && offset + got >= total)) break;
    offset += got;
  }
  return out;
}

/* ---------- Push : envoyer les lignes modifiées ---------- */
async function syncPush(force = false){
  const meta = syncMeta();

  /* 1. Propager les suppressions : on écrase la ligne du cloud par un tombeau
     { deleted:true } — les autres appareils le verront au pull et supprimeront
     leur copie locale (un vrai DELETE serait recréé par un appareil qui l'a encore). */
  const deletes = DB.__deleted || [];
  let deletedSent = 0;
  const _moi = currentUser ? (currentUser()||{}).id : null;
  const tombRows = deletes.map(d => ({
    collection: d.collection,
    id: d.id,
    payload: { id: d.id, deleted: true, _uid: d._uid || _moi || undefined, _deletedAt: new Date().toISOString() },
    updated_at: new Date().toISOString()
  }));
  if(tombRows.length){
    for(let i = 0; i < tombRows.length; i += 500){
      const batch = tombRows.slice(i, i + 500);
      await sbFetch('/rest/v1/data?on_conflict=collection,id', {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(batch)
      });
    }
    DB.__deleted = [];
    deletedSent = deletes.length;
    saveDB();
  }

  /* 2. Upsert des lignes modifiées (jamais une ligne tombstonée) */
  const since = force ? '1970-01-01T00:00:00Z' : (meta.pushedAt || '1970-01-01T00:00:00Z');
  const tombKey = {}; deletes.forEach(d => { tombKey[d.collection + '|' + d.id] = true; });
  const rows = [];
  SYNC_COLLECTIONS.forEach(coll => {
    (DB[coll] || []).forEach(r => {
      if(tombKey[coll + '|' + r.id]) return;   // supprimée localement : jamais renvoyée
      // le compte administrateur reste local à cet appareil : jamais envoyé au cloud
      if(coll === 'utilisateurs' && r.role === 'admin') return;
      // Mode production : ne jamais envoyer de données de test/démo vers le cloud
      if(coll === 'travaux' && (r.client === 'SCIEFA' || r.client === 'Zone Nord')) return;
      if(coll === 'charges' && (String(r.id||'').includes('-mv4wi58') || r.prestataire === 'Garage central')) return;
      const at = r._at || new Date().toISOString();
      if(!r._at) r._at = at;
      if(force || at > since || !meta.pushedAt){
        rows.push({ collection: coll, id: r.id, payload: r, updated_at: at });
      }
    });
  });

  if(rows.length){
    // upsert par lots de 500
    for(let i = 0; i < rows.length; i += 500){
      const batch = rows.slice(i, i + 500);
      await sbFetch('/rest/v1/data?on_conflict=collection,id', {
        method: 'POST',
        headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(batch)
      });
    }
  }

  const now = new Date().toISOString();
  meta.pushedAt = now;
  meta.lastPush = now;
  meta.lastPushCount = rows.length;
  setSyncMeta(meta);
  return { sent: rows.length, deleted: deletedSent };
}

/* ---------- Pull : récupérer l'état complet du cloud ---------- */
async function syncPull(){
  const meta = syncMeta();
  // Fetch INTÉGRAL et paginé : indispensable pour ne pas croire à tort
  // que des lignes manquantes sont des suppressions.
  const BASE = '/rest/v1/data?select=collection,id,payload,updated_at&order=updated_at.asc';
  const u = currentUser ? currentUser() : null;
  let rows;
  if(u && estRestreintDonnees(u)){
    // Conducteur : collections de référence complètes + uniquement SES saisies (_uid)
    const ref = await sbFetchAll(BASE + '&collection=in.(' + REF_COLLECTIONS.join(',') + ')');
    const mine = await sbFetchAll(BASE + '&collection=in.(' + ENTRY_COLLECTIONS.join(',') + ')&payload->>_uid=eq.' + encodeURIComponent(u.id));
    rows = ref.concat(mine);
  }else{
    // Admin / gestionnaire / consultation : toutes les saisies
    rows = await sbFetchAll(BASE);
  }

  let added = 0, updated = 0, removed = 0;
  const deletedBefore = (DB.__deleted || []).length;
  const tombKey = {};
  (DB.__deleted || []).forEach(d => { tombKey[d.collection + '|' + d.id] = true; });

  // 1. Intégration des éléments du cloud (fusion par ligne, dernier écrivain gagne)
  const ts = v => { const t = Date.parse(v || ''); return isNaN(t) ? 0 : t; };
  (rows || []).forEach(row => {
    if(!SYNC_COLLECTIONS.includes(row.collection)) return;
    const p = row.payload;
    if(!p || !p.id) return;
    const tkey = row.collection + '|' + p.id;
    // on n'accepte jamais de compte administrateur depuis le cloud
    if(row.collection === 'utilisateurs' && p.role === 'admin') return;
    // on rejette toute donnée de test mock résiduelle
    if(row.collection === 'travaux' && (p.client === 'SCIEFA' || p.client === 'Zone Nord')) return;
    if(row.collection === 'charges' && (String(p.id||'').includes('-mv4wi58') || p.prestataire === 'Garage central')) return;

    // Tombeau cloud : cette ligne a été supprimée → on supprime notre copie locale
    if(p.deleted){
      const arr = DB[row.collection];
      if(Array.isArray(arr)){
        const i = arr.findIndex(x => x.id === p.id);
        if(i >= 0){ arr.splice(i, 1); removed++; }
      }
      markDeleted(row.collection, p.id, p._uid);
      return;
    }

    const arr = DB[row.collection];
    if(!Array.isArray(arr)) return;
    // ligne supprimée localement (en attente de propagation) : ne pas la ramener
    if(tombKey[tkey]) return;
    const i = arr.findIndex(x => x.id === p.id);
    if(i < 0){ arr.push(p); added++; }
    else{
      const localAt = arr[i]._at || '';
      if(ts(row.updated_at) >= ts(localAt)){ arr[i] = p; updated++; }
    }
  });

  // 2. Retirer d'éventuelles copies locales de lignes supprimées (tombstones locaux)
  (DB.__deleted || []).forEach(d => {
    const arr = DB[d.collection];
    if(!Array.isArray(arr)) return;
    const before = arr.length;
    DB[d.collection] = arr.filter(x => x.id !== d.id);
    if(DB[d.collection].length !== before) removed++;
  });

  if(added || updated || removed || (DB.__deleted || []).length !== deletedBefore){
    _snap = snapshotRows();
    saveDB();
  }

  const now = new Date().toISOString();
  meta.pulledAt = now;
  meta.lastPull = now;
  meta.lastPullCount = (rows || []).length;
  setSyncMeta(meta);
  return { added, updated, removed };
}

/* ---------- Push + pull ---------- */
async function syncAll(force = false){
  const pushed = await syncPush(force);
  const pulled = await syncPull();
  return { pushed, pulled };
}

/* ---------- Test de connexion ---------- */
async function syncTest(){
  await sbFetch('/rest/v1/data?select=id&limit=1');
  return true;
}

/* ============================================================
   REALTIME — WebSocket Supabase JS v2
   Propagation instantanée : dès qu'un autre appareil écrit,
   on reçoit l'événement et on tire les nouvelles données.
   ============================================================ */

let _sbClient      = null;   // instance supabase.createClient()
let _rtChannel     = null;   // canal d'écoute postgres_changes
let _rtConfKey     = '';     // url+key utilisés lors de la dernière init (pour détecter un changement)
let _rtStatus      = 'off';  // 'off' | 'connecting' | 'connected' | 'error'
let _rtRetryTimer  = null;   // timer de reconnexion automatique

/* Clé qui identifie la configuration Supabase courante */
function _confKey(){
  const c = syncConf();
  return c.url + '|' + c.key;
}

/* Crée (ou réutilise) le client Supabase JS */
function _ensureClient(){
  if(!syncReady()) return null;
  const ck = _confKey();
  if(_sbClient && _rtConfKey === ck) return _sbClient;
  // config changée → on recrée
  _destroyRealtime();
  if(typeof supabase === 'undefined'){
    console.warn('[Realtime] Supabase JS non disponible (CDN non chargé ?)');
    return null;
  }
  const c = syncConf();
  _sbClient   = supabase.createClient(c.url, c.key, {
    realtime : { params: { eventsPerSecond: 10 } },
    auth     : { persistSession: false }
  });
  _rtConfKey  = ck;
  return _sbClient;
}

/* Lance l'abonnement Realtime aux changements de la table `data` */
function startRealtimeSync(){
  if(!syncReady()) return false;
  const client = _ensureClient();
  if(!client) return false;
  if(_rtChannel) return true;    // déjà abonné

  _rtStatus  = 'connecting';
  _rtChannel = client
    .channel('gestion-engins-data')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'data' },
      _onRealtimeEvent
    )
    .subscribe(_onRealtimeStatus);

  return true;
}

/* Arrête et libère le canal Realtime */
function stopRealtimeSync(){
  _destroyRealtime();
}

/* Indique si le WebSocket est actuellement connecté */
function isRealtimeActive(){
  return _rtStatus === 'connected';
}

/* Retourne le statut lisible ('off' | 'connecting' | 'connected' | 'error') */
function realtimeStatus(){
  return _rtStatus;
}

/* ---- Callbacks internes ---- */

function _onRealtimeEvent(payload){
  // Un autre appareil vient d'écrire → on tire les données fraîches
  if(typeof currentUser === 'function' && !currentUser()) return;
  syncPull()
    .then(() => { if(typeof renderAll === 'function') renderAll(); })
    .catch(err => console.warn('[Realtime] Pull après événement échoué :', err.message));
}

function _onRealtimeStatus(status, err){
  const prev = _rtStatus;
  if(status === 'SUBSCRIBED'){
    _rtStatus = 'connected';
    if(_rtRetryTimer){ clearTimeout(_rtRetryTimer); _rtRetryTimer = null; }
    if(prev !== 'connected') console.info('[Realtime] WebSocket connecté ✓');
  } else if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){
    _rtStatus = 'error';
    console.warn('[Realtime] Statut :', status, err || '');
    // Reconnexion automatique dans 15s
    if(!_rtRetryTimer){
      _rtRetryTimer = setTimeout(() => {
        _rtRetryTimer = null;
        if(syncReady()){
          _destroyChannel();   // ne détruit pas le client, juste le canal
          startRealtimeSync();
        }
      }, 15000);
    }
  }
}

function _destroyChannel(){
  if(_rtChannel && _sbClient){
    try{ _sbClient.removeChannel(_rtChannel); }catch(e){}
    _rtChannel = null;
  }
  _rtStatus = 'off';
}

function _destroyRealtime(){
  if(_rtRetryTimer){ clearTimeout(_rtRetryTimer); _rtRetryTimer = null; }
  _destroyChannel();
  if(_sbClient){
    try{ _sbClient.realtime.disconnect(); }catch(e){}
    _sbClient  = null;
    _rtConfKey = '';
  }
}
