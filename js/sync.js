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
  if(!res.ok){
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
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : null;
}

/* ---------- Push : envoyer les lignes modifiées ---------- */
async function syncPush(force = false){
  const meta = syncMeta();
  const since = force ? '1970-01-01T00:00:00Z' : (meta.pushedAt || '1970-01-01T00:00:00Z');
  const rows = [];
  SYNC_COLLECTIONS.forEach(coll => {
    (DB[coll] || []).forEach(r => {
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

  if(!rows.length) return { sent: 0 };

  // upsert par lots de 500
  for(let i = 0; i < rows.length; i += 500){
    const batch = rows.slice(i, i + 500);
    await sbFetch('/rest/v1/data?on_conflict=collection,id', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify(batch)
    });
  }

  const now = new Date().toISOString();
  meta.pushedAt = now;
  meta.lastPush = now;
  meta.lastPushCount = rows.length;
  setSyncMeta(meta);
  return { sent: rows.length };
}

/* ---------- Pull : récupérer l'état complet du cloud ---------- */
async function syncPull(){
  const meta = syncMeta();
  const rows = await sbFetch(
    '/rest/v1/data?select=collection,id,payload,updated_at&order=updated_at.asc&limit=5000'
  );

  let added = 0, updated = 0;

  // 1. Purge locale des données mock ou supprimées du cloud
  SYNC_COLLECTIONS.forEach(coll => {
    if(coll === 'utilisateurs') return; // comptes admin locaux
    const cloudIds = new Set((rows || []).filter(r => r.collection === coll && r.payload && r.payload.id).map(r => r.payload.id));
    if(Array.isArray(DB[coll])){
      const beforeLen = DB[coll].length;
      DB[coll] = DB[coll].filter(item => {
        // Toujours retirer les données de démo
        if(coll === 'travaux' && (item.client === 'SCIEFA' || item.client === 'Zone Nord')) return false;
        if(coll === 'charges' && (String(item.id||'').includes('-mv4wi58') || item.prestataire === 'Garage central')) return false;
        // Si le cloud a des éléments pour cette collection, retirer les lignes locales synchronisées qui ont disparu du cloud
        if(cloudIds.size > 0 && item._at && !cloudIds.has(item.id)) return false;
        return true;
      });
      if(DB[coll].length !== beforeLen) updated++;
    }
  });

  // 2. Intégration des éléments du cloud
  (rows || []).forEach(row => {
    if(!SYNC_COLLECTIONS.includes(row.collection)) return;
    const p = row.payload;
    if(!p || !p.id) return;
    // on n'accepte jamais de compte administrateur depuis le cloud
    if(row.collection === 'utilisateurs' && p.role === 'admin') return;
    // on rejette toute donnée de test mock résiduelle
    if(row.collection === 'travaux' && (p.client === 'SCIEFA' || p.client === 'Zone Nord')) return;
    if(row.collection === 'charges' && (String(p.id||'').includes('-mv4wi58') || p.prestataire === 'Garage central')) return;

    const arr = DB[row.collection];
    if(!Array.isArray(arr)) return;
    const i = arr.findIndex(x => x.id === p.id);
    if(i < 0){ arr.push(p); added++; }
    else{
      const localAt = arr[i]._at || '';
      if((row.updated_at || '') >= localAt){ arr[i] = p; updated++; }
    }
  });

  if(added || updated){
    _snap = snapshotRows();
    saveDB();
  }

  const now = new Date().toISOString();
  meta.pulledAt = now;
  meta.lastPull = now;
  meta.lastPullCount = (rows || []).length;
  setSyncMeta(meta);
  return { added, updated };
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
