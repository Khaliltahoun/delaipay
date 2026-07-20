# DelaiPay — Guide rapide : périodes & import (pour Mme Zahra)

## 1. Choisir la période de travail
En haut à droite, à côté du client, un bouton **📅 Année — Trimestre**.
- Cliquez dessus pour ouvrir le sélecteur.
- Utilisez **← →** pour changer de trimestre, ou choisissez directement dans la liste.
- Boutons rapides : **Trimestre en cours de traitement** (celui du mois : T1 en avril, T2 en juillet, T3 en octobre, T4 en janvier) et **Période la plus fournie**.
- Le trimestre choisi s'applique à **tout l'écran** (tableau de bord, délais, déclaration, visa…). Il est rappelé par la bannière bleue « Période de travail : T2 2026 ».

> Chaque trimestre est **isolé** : les fichiers et factures d'un trimestre n'apparaissent jamais dans un autre.

## 2. Importer un fichier (assistant en 4 étapes)
Menu **Import de fichiers**. Vérifiez d'abord que le **client** et la **période** en haut sont les bons.

1. **Fichier** — glissez un fichier Excel (.xlsx/.xls), CSV ou XML (relevé SIMPL). Il est **analysé**, rien n'est encore enregistré.
2. **Feuille & mapping** — choisissez la feuille, puis vérifiez la correspondance des colonnes proposée automatiquement (avec % de confiance). Corrigez si besoin. Les champs obligatoires sont marqués **✱** (n° facture, date, fournisseur, TTC).
3. **Prévisualisation** — l'appli montre : lignes **valides**, **ignorées** (totaux, sous-totaux, vides), **rejetées** (avec le motif) et **doublons**, ainsi que le TTC total. Un avertissement s'affiche si des dates sortent du trimestre choisi.
4. **Confirmation** — cliquez sur **Confirmer l'import**. Les factures sont créées, retards et amendes calculés.

Après import : bouton **Rapport des rejets (CSV)** pour voir les lignes non importées, et **Annuler cet import** si nécessaire (retire uniquement les factures de cet import).

## 2 bis. Importer les conventions fournisseurs depuis Excel
Menu **Conventions**. Cela permet d'enregistrer, en une fois, la liste des fournisseurs et leurs délais convenus. Le PDF signé n'est **pas** obligatoire à cette étape : vous l'ajoutez plus tard.

1. **Télécharger le modèle** — bouton **Télécharger le modèle**. Le fichier a deux onglets : *Instructions* (mode d'emploi) et *Conventions* (à remplir). Remplacez les exemples fournis (fictifs).
2. **Remplir les colonnes** — une ligne par fournisseur :
   - **Fournisseur** (obligatoire) et au moins un identifiant : **ICE** (de préférence), **IF** ou **RC** — cela évite les doublons.
   - **Convention OUI/NON** (obligatoire) :
     - **OUI** = une convention a été signée → une convention est créée avec le délai indiqué.
     - **NON** = pas de convention → le fournisseur est enregistré avec le délai légal de **60 jours**, sans convention.
     - *(vide)* = classé **à vérifier** (l'appli ne devine jamais).
   - **Délai convenu en jours** (si OUI) : 60, 90, 120 ou 180. Pour une fourchette (« 60 à 120 jours »), c'est le **plus grand** qui est retenu. Un délai **supérieur à 180**, nul ou illisible n'est pas importé : la ligne est signalée.
   - **Dates**, **Référence**, **Commentaire** : facultatifs (dates au format JJ/MM/AAAA).
3. **Importer** — bouton **Importer une liste Excel**, choisissez votre fichier.
4. **Comprendre les résultats** — un récapitulatif s'affiche : lignes analysées, **conventions créées**, fournisseurs créés / existants, **doublons**, **conflits**, **sans convention**, **à vérifier**, **rejetées**. Le détail des lignes à corriger est listé et **exportable en CSV**.
5. **Corriger les rejets** — reprenez les lignes « rejetées » ou « à vérifier » (délai manquant, délai > 180 j, colonne Convention vide), corrigez le fichier et réimportez : les lignes déjà correctes seront vues comme **doublons** (rien n'est recréé).
6. **Ajouter le PDF plus tard** — dans la liste, une convention sans document porte le statut **« Document manquant »**. Cliquez **Ajouter le PDF** (PDF uniquement) pour joindre le document signé.
7. **Gérer un conflit** — si le fichier propose un délai/des dates **différents** d'une convention déjà enregistrée, la ligne est marquée **« Conflit à vérifier »**. L'appli **ne remplace jamais** automatiquement : vérifiez, puis modifiez la convention à la main si besoin.
8. **Consulter ou remplacer un PDF** — bouton **Voir le PDF** pour l'ouvrir ; bouton **Remplacer** (avec confirmation) pour joindre une nouvelle version. L'ancien document n'est jamais écrasé sans votre confirmation.

## 2 ter. Raccourci « Convention présente » (feuille de calcul des délais)
Dans **Feuille de calcul des délais**, une facture payée au-delà de 60 jours dont le fournisseur n'a **pas encore** de convention affiche un bouton **« + Convention présente »** (colonne Convention).
- Si vous savez qu'une convention a bien été signée avec ce fournisseur, cliquez ce bouton : une petite fenêtre s'ouvre avec le **délai convenu** (120 j par défaut, modifiable, 180 j maximum).
- Validez : la convention est **créée immédiatement** pour ce fournisseur et le calcul des retards est mis à jour. Toutes les factures de ce fournisseur affichent alors « conv. ».
- Le **PDF** n'est pas requis ici : la convention porte le statut **« Document manquant »** et vous ajouterez le document plus tard depuis la rubrique **Conventions**.

## 3. Clôturer une période (administrateur)
Une fois la déclaration faite, un administrateur peut **clôturer** la période : elle passe alors en **lecture seule** (plus d'import ni de modification). Une **réouverture exceptionnelle** est possible avec un **motif** (tracé dans le journal d'audit).

## 3 bis. Délai constaté : arrêté au dernier jour du trimestre
Le **délai constaté** d'une facture est le nombre de jours entre la date de facture et la **date d'arrêté** :
- **Facture payée** pendant le trimestre (au plus tard le dernier jour) → arrêté = **date de paiement**.
- **Facture non payée** au dernier jour du trimestre → arrêté = **dernier jour du trimestre**.
- **Facture payée après la clôture** → pour le trimestre en cours, arrêté = **dernier jour du trimestre** (le paiement postérieur est pris en compte au trimestre suivant, via l'incidence reportée).

**Exemple** : une facture datée du **15 avril** et non payée au **30 juin** a un délai constaté de **76 jours** pour la déclaration **T2**. Si elle est payée le **10 juillet**, le calcul **T2 reste arrêté au 30 juin** (76 j) ; c'est le trimestre suivant qui prendra en compte la date réelle de paiement.

Les trois indicateurs restent distincts dans la feuille de délais :
- **délai constaté** = date d'arrêté − date de facture ;
- **délai autorisé** = 60 j (défaut) ou le délai de la convention (jusqu'à 120 j) ;
- **jours de retard** = délai constaté − délai autorisé (jamais négatif).

Dates de fin retenues : T1 → 31/03, T2 → 30/06, T3 → 30/09, T4 → 31/12 (année N, même si T4 est traité en janvier N+1).

## 3 ter. Opérateurs de réseau (télécom, eau, électricité)
Les factures des **opérateurs de télécommunications, d'eau, d'électricité et des sociétés régionales multiservices** sont soumises à un **délai spécifique de 30 jours**. Elles **restent visibles dans le suivi interne** (feuille de délais) mais sont **exclues des tableaux déclaratifs** concernés — un résumé « factures exclues » figure dans la déclaration pour vérification.

- Un fournisseur reconnu par son **nom seul** est *proposé* : il faut le **confirmer** (l'ICE, l'IF ou le RC priment sur le nom). Tant qu'il n'est pas confirmé, ni le délai de 30 j ni l'exclusion ne s'appliquent.
- Dans la feuille de délais, un badge **« Réseau — 30 j »** et **« Hors tableau déclaratif »** signale ces factures.
- Aucune donnée historique n'est modifiée automatiquement : un rapport de simulation liste les fournisseurs candidats avant toute application.

## 4. Une facture impayée sur plusieurs trimestres
Si une facture reste impayée, son amende est **reportée automatiquement** sur chaque trimestre concerné (mois par mois), **sans déplacer le fichier d'origine**. Vous la retrouvez dans la feuille de délais du trimestre, marquée « incidence reportée ».

## Points de repère
- **Login** : votre e-mail / mot de passe habituel.
- **Rien n'est enregistré avant votre validation** à l'étape 4.
- En cas de doute, la bannière en haut rappelle toujours **quel client** et **quel trimestre** vous êtes en train de traiter.
