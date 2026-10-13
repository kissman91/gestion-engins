/* Tests du système de gestion des utilisateurs (js/store.js)
   Exécution : node tests/test-utilisateurs.js
   (aucune dépendance : stubs localStorage/sessionStorage + WebCrypto de Node) */

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
  sessionStorage: memoire()
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), ctx, { filename: 'store.js' });

let echecs = 0;
function ok(cond, label){
  if(cond) console.log('  ✓ ' + label);
  else { echecs++; console.log('  ✗ ' + label); }
}

(async () => {
  const run = code => vm.runInContext(code, ctx);

  console.log('\n— État initial —');
  ok(run('DB.utilisateurs.length') === 0, 'nouvel état : aucun compte');
  ok(run("typeof can === 'function' && typeof login === 'function'"), 'API présente');

  console.log('\n— Création des comptes —');
  const admin = await run("enregistrerUtilisateur({ nom:'Kossi A.', login:'admin', role:'admin', mdp:'secret123' })");
  ok(!!admin.id && admin.role === 'admin', 'administrateur créé');
  ok(run('adminActifs().length') === 1, 'un administrateur actif');
  ok(run("userPrivs(userByLogin('admin')).length === allPrivs().length"), 'admin = tous les privilèges');

  await run("enregistrerUtilisateur({ nom:'Moussa D.', login:'moussa', role:'saisie', mdp:'terrain456' })");
  await run("enregistrerUtilisateur({ nom:'Fatou B.', login:'fatou', role:'lecture', mdp:'lecture789' })");
  ok(run('utilisateurs().length') === 3, 'trois comptes enregistrés');
  ok(!run("loginDispo('ADMIN')"), 'identifiant unique (insensible à la casse)');

  const mdpClair = run("JSON.stringify(DB.utilisateurs.map(u => u.hash + '|' + u.sel)).includes('secret')");
  ok(!mdpClair, 'mot de passe jamais stocké en clair');
  ok(run("userByLogin('moussa').hash.startsWith('sha256$')"), 'hash SHA-256 salé');

  console.log('\n— Rôles & privilèges —');
  ok(run("can('terrain:edit') === false"), 'avant connexion : aucun droit');
  await run("login('admin', 'secret123', false)");
  ok(run("can('utilisateurs:edit') && can('parametres:edit') && can('global:export')"), 'admin : tout est autorisé');
  ok(run("currentUser().login") === 'admin', 'session ouverte');

  run('logout()');
  ok(run('currentUser() === null'), 'déconnexion : session fermée');
  await run("login('moussa', 'terrain456', false)");
  ok(run("can('terrain:vue') && can('terrain:edit') && can('travaux:suppr')"), 'conducteur : saisie autorisée');
  ok(run("!can('charges:vue') && !can('rapports:vue') && !can('utilisateurs:vue')"), 'conducteur : finances et comptes interdits');
  ok(run("can('global:sync') && !can('global:export')"), 'conducteur : synchro oui, export non');
  run('logout()');
  await run("login('fatou', 'lecture789', false)");
  ok(run("can('dashboard:vue') && can('rapports:vue')"), 'lecture seule : consultation OK');
  ok(run("!can('charges:edit') && !can('travaux:suppr') && !can('parametres:edit')"), 'lecture seule : aucune écriture');
  run('logout()');

  console.log('\n— Sécurité de la connexion —');
  ok(!(await run("login('moussa', 'mauvais', false).then(() => true).catch(() => false)")), 'mauvais mot de passe refusé');
  ok(!(await run("login('inconnu', 'terrain456', false).then(() => true).catch(() => false)")), 'identifiant inconnu refusé');
  await run("enregistrerUtilisateur({ nom:'Bloqué', login:'bloque', role:'lecture', mdp:'abcd1234', actif:false })");
  ok(!(await run("login('bloque', 'abcd1234', false).then(() => true).catch(() => false)")), 'compte désactivé refusé');

  console.log('\n— Session permanente —');
  await run("login('fatou', 'lecture789', true)");
  ok(run("!!localStorage.getItem('gestion_engins_session_perso')"), '« rester connecté » stocké côté navigateur');
  run('logout()');
  ok(run("localStorage.getItem('gestion_engins_session_perso') === null"), 'déconnexion efface la session');

  console.log('\n— Sauvegardes & démonstration —');
  await run("login('admin', 'secret123', false)");
  const sauvegarde = run("exportJSON()");
  run("DB.travaux = [];");
  run(`importJSON(${JSON.stringify(sauvegarde)})`);
  ok(run('utilisateurs().length') === 4, 'import : les comptes survivent à la sauvegarde');
  const vieille = JSON.stringify({ settings: { nom: 'Ancien fichier' }, engins: [] });
  run(`importJSON(${JSON.stringify(vieille)})`);
  ok(run('utilisateurs().length') === 4 && run("DB.settings.nom") === 'Ancien fichier', 'ancienne sauvegarde (sans comptes) : pas de verrouillage');
  run('seedDemo()');
  ok(run('utilisateurs().length') === 4 && run('DB.engins.length') > 0, 'données de démonstration : comptes conservés');

  console.log('\n— Suppression —');
  const cible = run("userByLogin('bloque').id");
  run(`supprimerUtilisateur('${cible}')`);
  ok(run('utilisateurs().length') === 3 && run(`userById('${cible}') === null`), 'compte supprimé');

  console.log(echecs === 0 ? '\n✅ Tous les tests passent (' + run('utilisateurs().length') + ' comptes restants)\n'
                           : '\n❌ ' + echecs + ' échec(s)\n');
  process.exit(echecs === 0 ? 0 : 1);
})().catch(e => { console.error('❌ Erreur de test :', e); process.exit(1); });
