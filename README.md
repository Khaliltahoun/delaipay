# DelaiPay

SaaS multi-tenant de suivi des **délais de paiement (loi marocaine 69-21)** pour les cabinets
d'expertise comptable : import des journaux d'achats, calcul automatique des retards et amendes,
déclaration DGI, génération du visa (Word/PDF), tableaux de bord et alertes.

## Démarrage
```bash
cd app
npm install
npm start        # http://localhost:3000
```
Stack : Node.js (≥24) + Express + `node:sqlite` (zéro dépendance native), JWT, SheetJS, docx, pdfkit.
Voir **[app/README.md](app/README.md)** pour la documentation complète, l'architecture et le déploiement.

> Les documents clients réels et les données d'exécution ne sont pas versionnés (voir `.gitignore`).
