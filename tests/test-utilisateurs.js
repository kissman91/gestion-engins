/* Tests du système de gestion des utilisateurs (js/store.js + js/sync.js)
   Exécution : node tests/test-utilisateurs.js
   (aucune dépendance : stubs localStorage/sessionStorage/fetch + WebCrypto de Node) */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const { TextEncoder } = require('util');

function memoire(){
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear()
  };
}

const ctx = vm.createContext({
  console,
  crypto: webcrypto,
  TextEncoder,
  localStorage: memoire(),
  sessionStorage: memoire(),
  fetch: async () => { throw new Error('fetch non stubbé pour ce test'); }
});
['js/store.js', 'js/sync.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
});

let echecs = 0;
function ok(cond, label){
  if(cond) console.log('  ✓ ' + label);
  else { echecs++; console.log('  ✗ ' + label); }
}
const run = code => vm.runInContext(code, ctx);
async function refuse(code, attendu, label){
  try{
    await run(code);
    ok(false, label + ' → aucune erreur levée');
  }catch(e){
    ok(String(e.message).includes(attendu), label + ' → « ' + String(e.message) + ' »');
  }
}

(async () => {
  console.log('\n— État initial —');
  ok(run('DB.utilisateurs.length') === 0, 'nouvel état : aucun compte');

  console.log('\n— Création du compte administrateur (poste du boss) —');
  const admin = await run("enregistrerUtilisateur({ nom:'Kossi A.', login:'admin', role:'admin', mdp:'secret123' })");
  ok(!!admin.id && admin.role === 'admin', 'administrateur créé sans session (premier appareil)');
  ok(run('adminActifs().length') === 1, 'un administrateur actif');
  ok(run("userPrivs(userByLogin('admin')).length === allPrivs().length"), 'admin = tous les privilèges');
  ok(!run("JSON.stringify(DB.utilisateurs.map(u => u.hash + '|' + u.sel)).includes('secret')"), 'mot de passe jamais stocké en clair');
  ok(run("userByLogin('admin').hash.startsWith('sha256$')"), 'hash SHA-256 salé');

  console.log('\n— L’administrateur crée les autres comptes —');
  await run("login('admin', 'secret123', false)");
  await run("enregistrerUtilisateur({ nom:'Gérant', login:'gerant', role:'gestion', mdp:'gestion123' })");
  await run("enregistrerUtilisateur({ nom:'Moussa D.', login:'moussa', role:'saisie', mdp:'terrain456' })");
  await run("enregistrerUtilisateur({ nom:'Fatou B.', login:'fatou', role:'lecture', mdp:'lecture789' })");
  ok(run('utilisateurs().length') === 4, 'quatre comptes enregistrés');
  ok(run("userByLogin('gerant').privileges.includes('utilisateurs:edit')"), 'gestionnaire : droit de gérer les comptes');
  await run("enregistrerUtilisateur({ nom:'Kossi B.', login:'admin2', role:'admin', mdp:'second123' })");
  ok(run('adminActifs().length') === 2, 'second administrateur créé (pour tester la protection)');

  console.log('\n— Le gestionnaire crée des comptes, mais pas n’importe lesquels —');
  run('logout()');
  await run("login('gerant', 'gestion123', false)");
  await run("enregistrerUtilisateur({ nom:'Paul S.', login:'paul', role:'saisie', mdp:'paul1234' })");
  ok(run('utilisateurs().length') === 6, 'gestionnaire : peut créer un conducteur');
  await refuse("enregistrerUtilisateur({ nom:'X', login:'x1', role:'gestion', mdp:'xxxx1234' })",
    'administrateur', 'gestionnaire : création d’un gestionnaire');
  await refuse("enregistrerUtilisateur({ nom:'Y', login:'y1', role:'admin', mdp:'yyyy1234' })",
    'administrateur', 'gestionnaire : création d’un administrateur');
  await refuse(`enregistrerUtilisateur({ id:'${run("userByLogin('admin').id")}', nom:'Hack', login:'admin', role:'lecture', mdp:'hack1234' })`,
    'protégé', 'gestionnaire : modification du compte admin');
  await refuse(`supprimerUtilisateur('${run("userByLogin('admin2').id")}')`,
    'protégé', 'gestionnaire : suppression d’un autre compte admin');

  console.log('\n— Rôles & privilèges appliqués —');
  run('logout()');
  await run("login('moussa', 'terrain456', false)");
  ok(run("can('terrain:vue') && can('terrain:edit') && can('travaux:suppr')"), 'conducteur : saisie autorisée');
  ok(run("!can('charges:vue') && !can('rapports:vue') && !can('utilisateurs:vue')"), 'conducteur : finances et comptes interdits');
  ok(run("can('global:sync') && !can('global:export')"), 'conducteur : synchro oui, export non');
  ok(run("!can('utilisateurs:edit')"), 'conducteur : aucun droit sur les comptes');
  run('logout()');
  await run("login('fatou', 'lecture789', false)");
  ok(run("can('dashboard:vue') && can('rapports:vue')"), 'lecture seule : consultation OK');
  ok(run("!can('charges:edit') && !can('travaux:suppr') && !can('parametres:edit')"), 'lecture seule : aucune écriture');
  ok(!run("privsAccordables().some(c => c.startsWith('utilisateurs:'))"), 'un non-admin ne peut pas déléguer la gestion des comptes');
  run('logout()');

  console.log('\n— Sécurité de la connexion —');
  ok(!(await run("login('moussa', 'mauvais', false).then(() => true).catch(() => false)")), 'mauvais mot de passe refusé');
  ok(!(await run("login('inconnu', 'terrain456', false).then(() => true).catch(() => false)")), 'identifiant inconnu refusé');
  await run("login('admin', 'secret123', false)");
  await run("enregistrerUtilisateur({ nom:'Bloqué', login:'bloque', role:'lecture', mdp:'abcd1234', actif:false })");
  run('logout()');
  ok(!(await run("login('bloque', 'abcd1234', false).then(() => true).catch(() => false)")), 'compte désactivé refusé');

  console.log('\n— Session —');
  await run("login('fatou', 'lecture789', true)");
  ok(run("!!localStorage.getItem('gestion_engins_session_perso')"), '« rester connecté » stocké côté navigateur');
  ok(run("!!derniereConnexionLocal(userByLogin('fatou').id)"), 'dernière connexion notée localement');
  run('logout()');
  ok(run("localStorage.getItem('gestion_engins_session_perso') === null"), 'déconnexion efface la session');

  console.log('\n— Comptes partagés par le cloud (admin exclus) —');
  await run("login('admin', 'secret123', false)");
  run("DB.settings.sbUrl = 'https://dummy.supabase.co'; DB.settings.sbKey = 'cle-anon'; saveDB();");
  const pushes = [];
  ctx.fetch = async (url, opts) => {
    if(opts && opts.body) pushes.push(JSON.parse(opts.body));
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => [], text: async () => '' };
  };
  await run('syncPush()');
  const payloads = (pushes[0] || []).filter(r => r.collection === 'utilisateurs').map(r => r.payload);
  ok(payloads.some(p => p.login === 'gerant'), 'cloud : le gestionnaire est envoyé');
  ok(payloads.some(p => p.login === 'moussa'), 'cloud : le conducteur est envoyé');
  ok(!payloads.some(p => p.role === 'admin'), 'cloud : le compte admin ne quitte jamais l’appareil');
  ok(!payloads.some(p => p.mdp), 'cloud : aucun mot de passe en clair dans le flux');

  ctx.fetch = async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    text: async () => '',
    json: async () => ([
      { collection: 'utilisateurs', id: 'u-cloud-1',
        payload: { id: 'u-cloud-1', nom: 'Samba K.', login: 'samba', role: 'saisie', actif: true, privileges: [], hash: 'h', sel: 's' },
        updated_at: '2030-01-01T00:00:00.000Z' },
      { collection: 'utilisateurs', id: 'u-cloud-9',
        payload: { id: 'u-cloud-9', nom: 'Admin volé', login: 'evil', role: 'admin', actif: true, privileges: [], hash: 'h', sel: 's' },
        updated_at: '2030-01-01T00:00:00.000Z' }
    ])
  });
  await run('syncPull()');
  ok(run("!!userByLogin('samba')"), 'cloud : conducteur récupéré sur un autre appareil');
  ok(run("userByLogin('evil') === null"), 'cloud : aucun compte admin accepté à la réception');
  ok(run("!!userByLogin('admin')"), 'compte admin local intact');

  console.log('\n— En-têtes envoyés à chaque requête (régression) —');
  run('setSyncMeta({})');
  const vus = [];
  ctx.fetch = async (url, opts) => {
    vus.push({ url, opts });
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => [], text: async () => '' };
  };
  await run('syncTest()');
  await run('syncPull()');
  await run('syncPush()');
  ok(vus.length === 3, 'trois requêtes émises (test, pull, push)');
  ok(vus.every(v => v.opts && v.opts.headers && v.opts.headers.apikey === 'cle-anon'), 'chaque requête porte la clé apikey (GET compris)');
  ok(vus.every(v => v.opts.headers.Authorization === 'Bearer cle-anon'), 'chaque requête porte le jeton bearer');
  ok(vus[2].opts.headers.Prefer !== undefined, 'le push conserve son en-tête Prefer');

  console.log('\n— Le conducteur récupéré peut se connecter —');
  run('logout()');
  ctx.fetch = async () => { throw new Error('hors ligne'); };
  ok(await run("login('samba', 'paul1234', false).then(() => false).catch(() => true)"), 'compte récupéré du cloud : mot de passe inconnu → refus');

  console.log('\n— Sauvegardes & démonstration —');
  await run("login('admin', 'secret123', false)");
  const sauvegarde = run('exportJSON()');
  const avant = run('utilisateurs().length');
  run('DB.travaux = [];');
  run('importJSON(' + JSON.stringify(sauvegarde) + ')');
  ok(run('utilisateurs().length') === avant, 'import : les comptes survivent à la sauvegarde');
  const vieille = JSON.stringify({ settings: { nom: 'Ancien fichier' }, engins: [] });
  run('importJSON(' + JSON.stringify(vieille) + ')');
  ok(run('utilisateurs().length') === avant && run("DB.settings.nom") === 'Ancien fichier', 'ancienne sauvegarde (sans comptes) : pas de verrouillage');
  run('seedDemo()');
  ok(run('utilisateurs().length') === avant && run('DB.engins.length') > 0, 'données de démonstration : comptes conservés');

  console.log('\n— Suppression —');
  const idAdmin2 = run("userByLogin('admin2').id");
  run('supprimerUtilisateur(' + JSON.stringify(idAdmin2) + ')');
  ok(run("userByLogin('admin2') === null"), 'admin : suppression d’un second administrateur');
  const idGest = run("userByLogin('gerant').id");
  run('supprimerUtilisateur(' + JSON.stringify(idGest) + ')');
  ok(run("userByLogin('gerant') === null"), 'admin : suppression d’un gestionnaire');
  const idPaul = run("userByLogin('paul').id");
  run('logout()');
  await run("login('paul', 'paul1234', false)");
  await refuse('supprimerUtilisateur(' + JSON.stringify(idPaul) + ')', 'propre', 'suppression de son propre compte impossible');
  ok(run('utilisateurs().length') === 6, 'comptes restants : admin + 3 saisie + 2 lecture (dont 1 désactivée)');

  console.log('\n— Normalisation de l’URL du projet —');
  run("DB.settings.sbUrl = 'https://demo.supabase.co/rest/v1/'; saveDB();");
  ok(run('syncConf().url') === 'https://demo.supabase.co', 'URL « …/rest/v1/ » ramenée à la racine du projet');
  run("DB.settings.sbUrl = 'https://demo.supabase.co'; saveDB();");
  ok(run('syncConf().url') === 'https://demo.supabase.co', 'URL simple inchangée');
  run("DB.settings.sbUrl = 'https://demo.supabase.co/rest/v1'; saveDB();");
  ok(run('syncConf().url') === 'https://demo.supabase.co', 'URL « …/rest/v1 » sans slash final ramenée à la racine');

  console.log(echecs === 0 ? '\n✅ Tous les tests passent\n' : '\n❌ ' + echecs + ' échec(s)\n');
  process.exit(echecs === 0 ? 0 : 1);
})().catch(e => { console.error('❌ Erreur de test :', e); process.exit(1); });
