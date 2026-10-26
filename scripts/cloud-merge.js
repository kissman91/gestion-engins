/* ============================================================
   cloud-merge.js — Fusionne une sauvegarde d'appareil dans le cloud
   -----------------------------------------------------------------
   Récupère les données saisies en local sur UN autre appareil :
   chaque appareil peut exporter « 💾 Sauvegarde » (fichier
   sauvegarde_gestion_engins.json) ; ce script pousse le contenu
   dans la table Supabase (upsert), et le tableau de bord de
   l'admin les récupère ensuite via « 🔄 Synchroniser ».

   Usage :
     node scripts/cloud-merge.js chemin/sauvegarde.json [--uid=u-xxx] [--dry-run]

     --uid=u-xxx  attribue les saisies (travaux/charges/factures)
                  de la sauvegarde à ce compte utilisateur (champ _uid).
                  Par défaut : conservées telles quelles.
     --dry-run    affiche seulement le nombre de lignes à envoyer,
                  sans rien écrire dans le cloud.

   Identifiants Supabase lus depuis superbase.txt (ligne 2 : URL,
   ligne 3 : clé) ou via les variables SB_URL / SB_KEY.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const SYNC_COLLECTIONS = ['engins','employes','activites','travaux','charges','preventions','factures','utilisateurs'];
const ENTRY_COLLECTIONS = ['travaux','charges','factures'];
const DEMO_TRAVAUX = c => (c === 'SCIEFA' || c === 'Zone Nord');
const DEMO_CHARGE = c => (String(c.id||'').includes('-mv4wi58') || c.prestataire === 'Garage central');

function conf(){
  if(process.env.SB_URL && process.env.SB_KEY){
    return { url: process.env.SB_URL.replace(/\/+$/,'').replace(/\/rest\/v1$/i,''), key: process.env.SB_KEY };
  }
  const lines = fs.readFileSync(path.join(__dirname, '..', 'superbase.txt'), 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return {
    url: (lines[1] || '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, ''),
    key: lines[2] || ''
  };
}

async function main(){
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const uidArg = (args.find(a => a.startsWith('--uid=')) || '').split('=')[1];
  const dryRun = args.includes('--dry-run');
  if(!file) throw new Error('Fichier de sauvegarde manquant (ex. node scripts/cloud-merge.js sauvegarde.json)');

  const c = conf();
  if(!c.url || !c.key) throw new Error('Configuration Supabase introuvable (superbase.txt ou SB_URL/SB_KEY).');

  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  if(!db || typeof db !== 'object') throw new Error('Fichier invalide (attendu : exportJSON de l\'application).');

  const rows = [];
  SYNC_COLLECTIONS.forEach(coll => {
    (db[coll] || []).forEach(r => {
      if(!r || !r.id) return;
      // jamais de compte administrateur sur le cloud
      if(coll === 'utilisateurs' && r.role === 'admin') return;
      // jamais de données de démo
      if(coll === 'travaux' && DEMO_TRAVAUX(r.client)) return;
      if(coll === 'charges' && DEMO_CHARGE(r)) return;
      if(uidArg && ENTRY_COLLECTIONS.includes(coll) && !r.deleted) r._uid = uidArg;
      const at = r._at || new Date().toISOString();
      rows.push({ collection: coll, id: r.id, payload: r, updated_at: at });
    });
  });

  const byColl = {};
  rows.forEach(r => { byColl[r.collection] = (byColl[r.collection]||0) + 1; });

  console.log('Fichier : ' + path.basename(file));
  console.log('Lignes à envoyer : ' + rows.length);
  Object.keys(byColl).sort().forEach(k => console.log('  ' + k.padEnd(12) + byColl[k]));
  if(uidArg) console.log('Attribution _uid : ' + uidArg + ' (saisies seulement)');
  if(!rows.length){ console.log('Rien à envoyer.'); return; }

  if(dryRun){
    console.log('[dry-run] Aucune écriture effectuée.');
    return;
  }

  const hdrs = {
    'apikey': c.key,
    'Authorization': 'Bearer ' + c.key,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates'
  };
  let sent = 0;
  for(let i = 0; i < rows.length; i += 500){
    const batch = rows.slice(i, i + 500);
    const res = await fetch(c.url + '/rest/v1/data?on_conflict=collection,id', {
      method: 'POST', headers: hdrs, body: JSON.stringify(batch)
    });
    if(!res.ok) throw new Error('Erreur Supabase ' + res.status + ' : ' + (await res.text()).slice(0, 300));
    sent += batch.length;
    console.log('  envoyé ' + sent + '/' + rows.length);
  }
  console.log('Fusion terminée : ' + sent + ' lignes dans le cloud.');
  console.log('Actualisez ensuite le tableau de bord : bouton « 🔄 Synchroniser ».');
}

main().then(() => process.exit(0)).catch(e => { console.error('ERREUR : ' + e.message); process.exit(1); });
