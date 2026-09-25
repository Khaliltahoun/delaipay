# DelaiPay — Guide des tests (Release 1.0)

Ce document décrit l'architecture de tests de **DelaiPay**, les jeux de données utilisés, leur
organisation par lot et la stratégie de non-régression.

- **Version de référence (`/healthz`)** : `e25ef50ee4` · **commit** : `17ca7ac`
- **Runtime** : Node.js **≥ 22.5** (module intégré `node:sqlite` — aucune base externe).

---

## 1. Architecture des tests

- Framework : **`node:test`** (runner de tests intégré à Node), avec assertions **`node:assert`**.
  Aucune dépendance de test externe.
- Un unique fichier de tests : **`app/test/delaipay.test.js`**.
- **160 tests** au total.

Lancer la suite :

```bash
cd app
npm test          # équivaut à : node --test test/*.test.js
```

---

## 2. Isolation et environnement de test

Le début de `app/test/delaipay.test.js` met en place une **base de données temporaire isolée par
processus**, afin de ne jamais toucher la base de production :

- `process.env.DB_PATH` est positionné vers un fichier temporaire dérivé du PID du processus, dans le
  répertoire temporaire système :
  `os.tmpdir()/delaipay_test_<pid>.db`.
- Les fichiers `.db`, `-wal` et `-shm` éventuels sont supprimés **avant** la suite, et re-supprimés à
  la sortie du processus (`process.on('exit', …)`).
- Le module `src/db.js` lit `DB_PATH` à l'import ; comme la variable est définie avant le `require`,
  toute la suite s'exécute sur cette base jetable.

### Helpers de test

- **`seedCab()`** — insère l'historique des taux BAM (3,00 % → 2,25 % selon les dates), puis crée un
  cabinet et une entreprise de test, et renvoie `{ cab, ent }`. Sert de socle à la plupart des tests.
- Les scénarios d'import construisent des classeurs Excel à la volée via SheetJS
  (`xlsx`, `aoa_to_sheet`) puis passent par `importer.confirmImport(...)` / `importer.importWorkbook(...)`.
- Les tests d'API/HTTP s'appuient sur des utilitaires du type **`newTenant`**, **`postJson`** et
  **`postFile`** pour créer un tenant isolé et exercer les routes (envoi JSON et upload de fichiers).

> Le calcul métier est testé aussi bien au niveau unitaire (`calc.computeFacture`, `calc.saneDelai`,
> `periode.*`) qu'au niveau intégration (import → base → recalcul).

---

## 3. Jeux de données et fixtures

- **`app/src/fixtures/demo-t1-2026.json`** — jeu **fictif** du client de démonstration STE ORYX AUTO SARL, utilisé
  comme **référence de non-régression** (mêmes montants, dates et relations fournisseur que la déclaration réelle de
  référence ; noms, IF et ICE fictifs). Son import doit reproduire la déclaration **T1 2026** :
  - **36 factures** importées (dont **2 doublons potentiels** conservés et signalés — paiement
    partiel / facture scindée) ;
  - **amende totale = 7 025,33 DH** (les 2 doublons étant réglés dans les délais, ils n'ajoutent
    aucune amende : la non-régression du moteur légal est préservée).
- **Aucun test conditionnel** : toutes les fixtures sont versionnées et **anonymisées** (`app/test/fixtures/*.json` :
  structure et en-têtes d'origine, libellés et identifiants aléatoires). Aucun test ne lit de document client ;
  aucun test n'est ignoré.
- Les autres jeux de données (classeurs Excel de scénarios d'import, fournisseurs, conventions) sont
  **générés en mémoire** par les tests eux-mêmes.

---

## 4. Organisation par lot

Les tests couvrent les évolutions livrées lot par lot (chaque lot correspond à un correctif métier
majeur) :

| Lot | Domaine | Objet |
|---|---|---|
| **LOT 1** | Automap / import | Correspondance de colonnes sûre — pas d'auto-mapping dangereux des champs requis ; plage de délai « 60 à 120 » → 120 (jamais 60120). |
| **LOT 2** | Opérateur de réseau | Détection/propositions « opérateur de réseau » (télécom, eau, électricité, régies) : délai 30 j et exclusion du tableau déclaratif ; confirmation en un clic. |
| **LOT 3** | Conventions / documents | Honnêteté OCR (documents archivés, délai explicite), registre des conventions et délai 120 j appliqué. |
| **LOT 4** | Intégrité des conventions | Règle de sélection **unique** de la convention active partout (recalcul, feuille de délais, import, saisie, réparation). |
| **LOT 5** | Périodes | La période active est la seule utilisée partout — cohérence du calendrier trimestriel. |
| **LOT 6** | Clôture | Clôture / verrouillage des périodes déclarées. |

---

## 5. Stratégie de non-régression

- **Référence T1 2026 figée** : l'amende **7 025,33 DH** du jeu de démonstration (T1 2026) et l'empreinte du fichier de déclaration est vérifiée à chaque
  exécution (tolérance < 0,5 DH). Toute dérive du moteur légal fait échouer la suite.
- **Plafond légal du délai** : `saneDelai` borne systématiquement tout délai à `[1, 120]` j
  (défaut légal 60) ; un délai aberrant (ex. « 60 120 » concaténé → 60120, ou valeur énorme) ne doit
  **jamais** masquer un retard réel — testé au niveau `calc`, à l'import et via `repair`.
- **Préservation des lots antérieurs** : à chaque nouveau lot, les tests des lots précédents sont
  conservés et doivent rester verts (aucune régression fonctionnelle introduite).
- **Intégrité des données** : les scripts `migrate` et `repair` sont idempotents et ne modifient
  jamais les montants ni le nombre de factures — la migration échoue si le nombre de factures change.

---

## 6. Campagnes de validation Claude Cowork

En complément des tests automatisés, des **campagnes de validation manuelles en conditions réelles**
(tests navigateur de bout en bout) ont été menées avec **Claude Cowork**. Les rapports de ces
campagnes sont archivés dans **`collaboration/archive/`**.

Ces campagnes valident les parcours utilisateurs complets (authentification, import, feuille de
calcul des délais, déclaration DGI, visa, alertes) que les tests unitaires/intégration ne couvrent
pas au niveau de l'interface.
