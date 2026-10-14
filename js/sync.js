/* ============ sync.js — Synchronisation Supabase (PostgREST) ============
   Modèle : une table `data` (collection, id, payload jsonb, updated_at).
   Push : envoie les lignes modifiées (_at > dernier push connu).
   Pull : récupère les lignes plus récentes que notre dernier pull.
   Résolution de conflit : dernier écrivain gagne (updated_at).
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
  // la clé apikey part avec TOUTES les requêtes (GET compris), les en-têtes
  // supplémentaires de l'appelant sont fusionnés par-dessus
  const o = Object.assign({}, opts || {});
  o.headers = sbHeaders(o.headers || {});
  const res = await fetch(c.url + path, o);
  if(!res.ok){
    let msg = '';
    try{ msg = (await res.text()).slice(0, 300); }catch(e){}
    if(res.status === 401){
      msg += ' → clé refusée : collez la clé « publishable » (ou anon) du bon projet, sans espace ni retour à la ligne, et vérifiez qu’elle n’a pas été regénérée depuis.';
    }
    if(res.status === 404 && msg.indexOf('PGRST125') >= 0){
      msg += ' → l’URL doit être celle du projet (https://xxxx.supabase.co) ; l’application ajoute elle-même « /rest/v1 ». Vérifiez aussi d’avoir bien exécuté supabase.sql dans ce projet.';
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
  // Récupère l'ensemble des données ordonnées pour éviter toute perte liée au décalage d'horloge
  const rows = await sbFetch(
    '/rest/v1/data?select=collection,id,payload,updated_at&order=updated_at.asc&limit=5000'
  );

  let added = 0, updated = 0;
  (rows || []).forEach(row => {
    if(!SYNC_COLLECTIONS.includes(row.collection)) return;
    const p = row.payload;
    if(!p || !p.id) return;
    // on n'accepte jamais de compte administrateur depuis le cloud
    if(row.collection === 'utilisateurs' && p.role === 'admin') return;
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
    // figer l'état tiré AVANT saveDB : sinon stampChanges marquerait toutes
    // les lignes reçues comme modifiées localement et le prochain push
    // les renverrait en écrasant les éditions concurrentes d'un autre appareil.
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
