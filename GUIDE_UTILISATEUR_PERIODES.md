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

## 3. Clôturer une période (administrateur)
Une fois la déclaration faite, un administrateur peut **clôturer** la période : elle passe alors en **lecture seule** (plus d'import ni de modification). Une **réouverture exceptionnelle** est possible avec un **motif** (tracé dans le journal d'audit).

## 4. Une facture impayée sur plusieurs trimestres
Si une facture reste impayée, son amende est **reportée automatiquement** sur chaque trimestre concerné (mois par mois), **sans déplacer le fichier d'origine**. Vous la retrouvez dans la feuille de délais du trimestre, marquée « incidence reportée ».

## Points de repère
- **Login** : votre e-mail / mot de passe habituel.
- **Rien n'est enregistré avant votre validation** à l'étape 4.
- En cas de doute, la bannière en haut rappelle toujours **quel client** et **quel trimestre** vous êtes en train de traiter.
