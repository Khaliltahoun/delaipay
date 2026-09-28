# DelaiPay — Plan de test du fondateur sur le staging

> À dérouler une fois le staging installé (docs/STAGING.md), avec **votre téléphone** et **votre ordinateur**.
> Cocher chaque case ; noter l'heure et, en cas d'écart, une capture d'écran + la référence affichée (« référence xxxxxxxx »).
> Hôtes : console `https://admin.staging.delaipay.com/` · espaces `https://hlz-demo.staging.delaipay.com/`, `https://premium.staging.delaipay.com/`,
> `https://client2.staging.delaipay.com/`. Toutes les données sont **fictives**.
> Si l'authentification basique nginx est active, le navigateur demande d'abord l'identifiant du staging (`fondateur`).

## 0. Préparation (10 min)
- [ ] Application d'authentification installée sur le téléphone (Google Authenticator, Microsoft Authenticator, Aegis, 1Password…).
- [ ] Gestionnaire de mots de passe ouvert (mots de passe du seed et codes de secours y seront rangés).
- [ ] Connaître votre IP publique à la maison (https://ifconfig.me) et vérifier qu'elle change en 4G sur le téléphone.

## 1. Certificat et hôtes (5 min)
- [ ] Ordinateur : `https://admin.staging.delaipay.com/` → cadenas valide, certificat « *.staging.delaipay.com » émis par Let's Encrypt, expire dans ~90 jours.
- [ ] Même contrôle sur `https://hlz-demo.staging.delaipay.com/login`.
- [ ] `http://admin.staging.delaipay.com/` → redirigé vers `https://…` automatiquement.
- [ ] `https://admin.staging.delaipay.com/healthz` → `{"ok":true,…,"db":"ok"}` (aucun nom, aucun chiffre d'espace).
- [ ] Un espace inconnu (`https://nexistepas.staging.delaipay.com/login`) → « Aucun espace de travail ne correspond… ».

## 2. Double authentification réelle (15 min)
Le premier administrateur plateforme a été créé sur le serveur (`platform:admin:create`) ; son mot de passe vous a été affiché une fois.
- [ ] Console → e-mail + mot de passe → écran « Activez la double authentification » avec un QR code.
- [ ] Scanner le QR avec l'application du téléphone → saisir le code à 6 chiffres → **10 codes de secours** affichés : les copier dans le
      gestionnaire de mots de passe, cocher « J'ai conservé ces codes », « Accéder à la console ».
- [ ] Se déconnecter, se reconnecter : mot de passe → **code de l'application** → tableau de bord.
- [ ] Se reconnecter avec **un code de secours** (lien « Utiliser un code de secours ») → accepté ; message « Il vous en reste 9 ».
- [ ] Réutiliser ce même code → refusé.
- [ ] Mauvais mot de passe puis e-mail inconnu → le même message « Identifiants incorrects. ».

## 3. Console sur un vrai téléphone (10 min)
- [ ] Téléphone (4G) : se connecter à la console (mot de passe + code).
- [ ] Menu ☰, tableau de bord, Espaces de travail, fiche d'un espace, Sessions et appareils : lisibles, sans défilement horizontal de la page.
- [ ] Journal plateforme : vos connexions avec l'heure « (UTC+1) » et l'IP 4G.

## 4. Appareils approuvés — deux réseaux (20 min)
Comptes du seed : `admin@client2.demo` (administrateur) et `comptable@client2.demo` (comptable), mots de passe du seed.
- [ ] Ordinateur (Wi-Fi maison) : se connecter à `client2` en administrateur → Paramètres → Sécurité → cocher « Appareils approuvés »
      → Enregistrer → confirmer : l'ordinateur apparaît « Approuvé · cet appareil ».
- [ ] Téléphone en **4G** : se connecter à `client2` en comptable → « **Cet appareil doit être approuvé par l'administrateur de votre espace.** »
- [ ] Ordinateur : l'appareil du téléphone apparaît « En attente » avec son navigateur, son système et l'IP 4G → **Approuver**.
- [ ] Téléphone : se reconnecter → accès à l'espace.
- [ ] Téléphone : passer du 4G au **Wi-Fi maison** (changement d'IP), continuer à naviguer → **toujours connecté** (l'appareil, pas l'IP, est approuvé).
- [ ] Ordinateur : **Révoquer** l'appareil du téléphone → téléphone : à l'action suivante, retour à la connexion avec « L'accès depuis cet appareil a été retiré… ».
- [ ] Remettre la politique sur « Ouvert » (décocher, Enregistrer).

## 5. Informations d'appareil (5 min)
- [ ] Console → Sessions et appareils → le téléphone : navigateur, système, type « mobile ».
- [ ] **Modèle** : affiché (ex. « Pixel 8 ») **uniquement** si le téléphone est Android avec Chrome ; « — » sur iPhone / Safari / Firefox (jamais deviné).
- [ ] Pays : « — » tant qu'aucune base GeoIP locale n'est installée (normal).

## 6. Liste d'IP autorisées (15 min)
- [ ] Console → client2 → Sécurité et appareils → cocher « Liste d'IP autorisées », saisir **votre IP maison** (ex. `41.x.x.x`, libellé « Maison ») →
      Enregistrer → l'**aperçu** indique qui serait coupé (le téléphone en 4G, s'il est connecté) → saisir `client2` pour confirmer.
- [ ] Ordinateur (maison) : l'espace fonctionne. Téléphone en 4G : à l'action suivante → « **Connexion impossible depuis ce réseau…** ».
- [ ] Remplacer la liste par une plage qui **exclut** votre IP (ex. `203.0.113.0/24`) → l'aperçu vous liste aussi → confirmer →
      l'ordinateur est coupé à son tour avec le même message ; la **console reste accessible** (non soumise à la politique de l'espace).
- [ ] Rétablir : décocher la liste → Enregistrer. Vérifier que tout le monde peut se reconnecter.

## 7. Délais de session et fin d'assistance (≈ 9 h au total, en arrière-plan)
- [ ] Console : ne rien toucher **15 min** → déconnexion automatique (compte à rebours en haut) → reconnexion exigée.
- [ ] Console : rester actif (un clic toutes les 10 min) pendant **8 h** → la session prend fin au plus tard 8 h après la connexion.
- [ ] Console → hlz-demo → Assistance → motif + **15 minutes** → ouvrir l'espace en lecture seule (bandeau « Session d'assistance ») →
      attendre 15 min → l'onglet renvoie à la connexion « L'accès d'assistance DelaiPay est terminé » ; le journal de l'espace indique
      « Accès d'assistance terminé — durée écoulée ».

## 8. Déploiement d'un nouveau commit et retour arrière forcé (20 min, sur le serveur)
- [ ] `sudo -u delaipay-staging REPO_URL=… /srv/delaipay-staging/deploy.sh <nouveau commit>` → « Tests : pass … fail 0 », « Santé OK — version xxxxxxx ».
- [ ] Console → tableau de bord → « Système » : le **commit** affiché est le nouveau.
- [ ] Retour arrière forcé : déployer une branche de test volontairement cassée (ex. commit qui fait échouer le démarrage, préparé par Code)
      → « ÉCHEC du contrôle de santé — RETOUR ARRIÈRE » puis « Retour arrière réussi » ; `/healthz` renvoie le commit précédent ; aucune donnée perdue.

## 9. Sauvegarde puis exercice de restauration (30 min)
- [ ] Serveur : `sudo systemctl start delaipay-staging-backup` → `/var/log/delaipay-staging/backup.log` : « Sauvegarde réussie : …tar.gz.age ».
- [ ] Console → tableau de bord : « Dernière sauvegarde » à jour (heure, taille), pastille « À jour ».
- [ ] Hors site : l'archive est présente sur la destination choisie (B2, NAS…).
- [ ] Sur **votre ordinateur** (qui détient la clé privée age) : télécharger l'archive → `npm run restore -- --from <archive> --to ~/restauration-test
      --identity <votre clé privée>` → « Restauration réussie ».
- [ ] `DB_PATH=~/restauration-test/delaipay.db UPLOADS_DIR=~/restauration-test/uploads TENANT_BASE_DOMAINS=localhost npm run verify:baseline --
      --slug hlz-demo --expect "36,16,350964.42,7025.33,a7d1acaac0688170ef95fce6b7bb2082"` → « **CONFORME à la référence** ».
- [ ] (Contrôle de l'alerte) arrêter le timer de sauvegarde 27 h ou renommer temporairement BACKUP_DIR → la console passe en **rouge**
      (« En retard (> 26 h) » / « Échec ») ; rétablir.

## 10. Non-régression rapide (5 min)
- [ ] `hlz-demo` (fictif) : vue d'ensemble T1 2026 → 36 factures · 16 lignes déclarées · 350 964,42 · 7 025,33 DH.
- [ ] Une session d'espace n'ouvre pas la console (`https://admin.staging…/api/me` depuis un onglet connecté à un espace → refus).

**Compte rendu** : noter chaque case non cochée avec l'étape, l'heure, la capture et la référence d'erreur éventuelle ; le transmettre à Code.
