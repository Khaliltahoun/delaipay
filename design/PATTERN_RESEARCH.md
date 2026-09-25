# DelaiPay — recherche de motifs d'interface (21st.dev)

Méthode : recherches ciblées dans le catalogue 21st.dev (compte gratuit : recherche illimitée, aucune récupération de
code utilisée, aucun composant importé). Les aperçus consultés restent hors dépôt (droits des auteurs). On retient des
**principes**, adaptés à un logiciel comptable où la donnée prime ; chaque motif est noté *adopté*, *adapté* ou *rejeté*.

| Besoin | Motifs étudiés (catalogue) | Décision pour DelaiPay |
|---|---|---|
| **Barre latérale par métier** | *Sidebar Nav Group* (groupes repliables), *Sidebar 1* (groupes + compteurs), *SidebarShowcase* (sélecteur d'équipe + badges « New ») | **Adapté** : groupes à libellé fixe, **jamais repliés** (un comptable ne doit pas chercher un menu) ; compteur uniquement quand il appelle une action (alertes, anomalies, réseau à confirmer). **Rejeté** : badges marketing « New / Updated », animations d'ouverture. |
| **Identité d'espace** | sélecteur d'équipe en tête de barre latérale | **Adapté** : carte d'espace = logo ou monogramme du cabinet + nom + « Propulsé par DelaiPay » ; pas de sélecteur (un utilisateur = un espace ; le changement d'espace passe par l'adresse). |
| **Menu utilisateur** | *User Profile Dropdown*, *User Dropdown* (statut en ligne, sous-menus) | **Adopté** : avatar → nom, e-mail, **rôle effectif**, espace, thème, déconnexion. **Rejeté** : statut « en ligne / focus », abonnement, raccourcis décoratifs. |
| **En-tête de KPI** | *Progress Metric Card*, *Insight Cards* (valeur + sparkline + delta + note IA), *Weekly KPI Chart* | **Adapté** : **un** chiffre-clé (TTC concerné) + 3 à 4 indicateurs subordonnés en ligne. **Rejeté** : graphiques décoratifs dans les cartes, deltas colorés sans période de référence, « notes IA », fonds sombres à dégradé. |
| **Tableaux denses** | *Table (dense)*, *Records Table* (1re colonne collante, pied de calcul), *Complex Data Table* | **Adopté** : ligne unique 40 px, chiffres tabulaires alignés à droite, en-tête collant, **ligne de totaux collante en pied**, 1re colonne collante. **Rejeté** : pastilles multicolores par catégorie, avatars dans les lignes, bordures zébrées. |
| **Colonne d'actions collante** | *Pinnable Columns Table* (colonne épinglée à droite) | **Adopté** : dernière colonne `position: sticky; right: 0` avec filet d'ombre uniquement quand le tableau défile (Cowork LOT 7). Une seule action visible (« Détail ») ; les autres dans un menu « ⋯ ». |
| **Stratégie mobile des tableaux** | *Table (card variant)*, *Info Cards*, *HeroUI Table (lignes dépliables)* | **Adapté** : sous 720 px, chaque ligne devient une **ligne-carte** : fournisseur + montant TTC sur la 1re ligne, n° / dates en 2e, statut (retard, amende) en pastilles ; toucher = tiroir de détail. Totaux conservés en tête de liste. **Rejeté** : défilement horizontal comme seule stratégie ; lignes dépliables en accordéon (perte du total visible). |
| **Filtres** | *Role Filter Chips* (compteurs + total), *Filter Token Bar* (jetons champ·opérateur·valeur), *Flexi Filter* | **Adopté** : filtres-pastilles avec compteur et total de résultats, lisibles par une experte-comptable. **Rejeté** : jetons « champ · opérateur · valeur » (vocabulaire de développeur). |
| **Parcours / onboarding** | *Onboarding Checklist*, *Stepper Progress*, *Workspace Setup* | **Adopté** : liste d'étapes avec progression réelle, étape courante explicite, reprise sur **la prochaine étape incomplète** (NEW-4). **Rejeté** : confettis, coches animées, étapes cochables à la main (l'achèvement est détecté sur les données). |
| **États vides** | *Empty State*, *Empty State Kit*, *Empty with Marquee* | **Adapté** : icône sobre, une phrase « ce qui manque », **un seul** bouton d'action adapté au rôle. **Rejeté** : illustrations, défilement de lignes fantômes. |
| **Alertes / encarts** | *Alert*, *Alert Light Danger*, *Alert Banner* | **Adopté** : encart pleine largeur, icône + titre + « que faire », couleur = sens métier. **Rejeté** : alertes animées, fermeture sans trace pour un blocage. |
| **Confirmation destructive** | *Alert Dialog* (bouton destructif), *Delete Account Form* (saisie de la phrase), *Hold to Confirm* | **Adopté** : dialogue listant ce qui sera supprimé (compteurs) et **saisie du nom du client** pour les cascades irréversibles (P3-5). **Rejeté** : « maintenir pour confirmer » (inaccessible au clavier, ambigu), entrées en 3D / flou. |
| **Paramètres** | *Settings Sidebar Layout*, *Form Layout*, *Preferences Card* | **Adapté** : onglets horizontaux en bureau, liste de sections en mobile ; formulaires en 2 colonnes « libellé / champ » avec aide sous le champ. **Rejeté** : panneaux coulissants façon iOS en bureau. |
| **Connexion** | *Split Login*, *Sign In Split Screen*, *login-2/3* | **Adapté** : écran partagé déjà en place ; côté marque = identité de l'espace + promesse en 3 lignes. **Rejeté** : connexions sociales, citations, fonds à dégradé ou « shader ». |

## Principes retenus
1. **La donnée d'abord** : un écran comptable se juge à ce qu'il laisse lire sans défiler — montants, statut de la période, actions dues.
2. **Une couleur, un sens** : aucune couleur n'est décorative ; toute information de couleur est doublée d'un libellé ou d'une icône.
3. **Densité maîtrisée** : 40 px par ligne de tableau, 36 px par contrôle, 44 px minimum de cible tactile en mobile.
4. **Totaux toujours visibles** : un tableau de montants sans total visible n'est pas un tableau comptable.
5. **Actions à droite, destruction en retrait** : l'action fréquente est visible ; la suppression passe par un menu et une confirmation nominative.
6. **Rien qui bouge sans raison** : transitions ≤ 200 ms, aucune animation d'agrément, `prefers-reduced-motion` respecté.
