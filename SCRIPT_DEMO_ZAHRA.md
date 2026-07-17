# Script de démonstration DelaiPay (≈ 15 min) — pour Mme Zahra

> Objectif : présenter le parcours complet, de la connexion à la clôture d'un trimestre.
> Pré-requis : application démarrée, compte `zahra@hlz.ma`, un fichier Excel de test (journal d'achats / tableau de déduction TVA).

| # | Étape | Ce qu'on montre | Durée |
|---|---|---|---|
| 1 | **Connexion** | Écran de login soigné, connexion sécurisée. | 30 s |
| 2 | **Choix de l'entreprise** | Sélecteur de client recherchable dans le bandeau ; badge « en retard ». | 1 min |
| 3 | **Choix du trimestre** | Sélecteur **Année — Trimestre** ; boutons « trimestre en cours de traitement » / « période la plus fournie » ; badge de statut ; bannière de contexte. | 1 min |
| 4 | **Import — étape 1** | Menu *Import de fichiers*, rappel du contexte (client + période), dépôt du fichier. | 1 min |
| 5 | **Import — mapping** | Feuille détectée, **correspondance des colonnes proposée** avec % de confiance + aperçu ; correction manuelle d'une colonne. | 2 min |
| 6 | **Import — prévisualisation** | Lignes **valides / ignorées (totaux) / rejetées (avec motif) / doublons**, TTC total ; insister : *rien n'est encore enregistré*. | 2 min |
| 7 | **Import — confirmation** | Bouton *Confirmer*, résumé, lien vers le **rapport des rejets (CSV)** et *Annuler cet import*. | 1 min |
| 8 | **Calcul & feuille de délais** | Retards, délai applicable (60/120), amende par facture, détail du calcul (mois calendaire, taux BAM puis 0,85 %). | 2 min |
| 9 | **Conventions** | Registre, ajout/upload d'une convention, contrôle « > 60 j sans convention ». | 1 min |
| 10 | **Déclaration DGI** | Formulaire officiel (art. 78-3/78-4), montant à verser, exports **CSV** et **XML EDI** (dépôt SIMPL). | 1 min |
| 11 | **Visa** | Génération du visa CAC/EC (art. 2.78), export **Word / PDF** sur 1 page. | 1 min |
| 12 | **Tableau de bord** | KPIs du trimestre, **calendrier déclaratif** (échéance, jours restants), exposition au risque, top entreprises/fournisseurs. | 1 min |
| 13 | **Incidence reportée** | Montrer qu'une facture impayée pèse sur le trimestre suivant **sans déplacer le fichier** (ligne « incidence reportée » dans la feuille de délais). | 1 min |
| 14 | **Clôture & audit** | Clôturer le trimestre (lecture seule), montrer le blocage des écritures, la réouverture avec motif, et le **journal d'audit**. | 1 min |

**Message de clôture** : « Chaque trimestre est isolé et traçable ; rien n'est enregistré sans validation ; le calcul légal est verrouillé et vérifié au centime. »

### Conseils
- Faire la démo sur un **client réel simple** (peu de fournisseurs) pour la lisibilité.
- Préparer d'avance un fichier contenant une ligne « TOTAL » et un avoir, pour montrer la robustesse de l'import.
- En cas d'imprévu : le bouton **Annuler cet import** remet la période propre instantanément.
