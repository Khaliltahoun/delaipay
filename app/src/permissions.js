'use strict';
/**
 * Rôles et autorisations — SOURCE UNIQUE côté serveur (l'interface ne fait que refléter).
 *
 *   admin          Administrateur : tout, y compris espace, utilisateurs, clôture / réouverture, taux.
 *   collaborateur  Comptable      : opérations comptables (clients, imports, conventions, réseau, doublons,
 *                                   exports) — ni administration de l'espace, ni utilisateurs, ni clôture.
 *   lecture        Lecture seule  : consultation et exports ; AUCUNE écriture (garde globale sur les méthodes).
 *
 * Les valeurs 'admin' / 'collaborateur' existaient déjà en base : aucune migration de données.
 */
const ROLES = {
  admin: { label: 'Administrateur', rank: 3 },
  collaborateur: { label: 'Comptable', rank: 2 },
  lecture: { label: 'Lecture seule', rank: 1 },
};

// Matrice documentée (vérifiée par les tests). true = autorisé.
const MATRIX = {
  //                      admin  compta lecture
  view:                 [true,  true,  true],
  export:               [true,  true,  true],
  create_client:        [true,  true,  false],
  edit_client:          [true,  true,  false],
  delete_client:        [true,  false, false],
  import:               [true,  true,  false],
  manage_conventions:   [true,  true,  false],
  classify_network:     [true,  true,  false],
  review_duplicates:    [true,  true,  false],
  close_period:         [true,  false, false],
  reopen_period:        [true,  false, false],
  manage_rates:         [true,  false, false],
  manage_workspace:     [true,  false, false],
  manage_users:         [true,  false, false],
  onboarding:           [true,  true,  false],
};
const IDX = { admin: 0, collaborateur: 1, lecture: 2 };

function isRole(r) { return Object.prototype.hasOwnProperty.call(ROLES, r); }
function can(role, action) {
  const row = MATRIX[action]; if (!row) return false;
  const i = IDX[role]; return i != null && !!row[i];
}
/** Répond 403 (message lisible) si le rôle ne permet pas l'action. @returns {boolean} autorisé */
function guard(req, res, action, message) {
  if (req.user && can(req.user.role, action)) return true;
  res.status(403).json({ error: message || 'Votre rôle ne permet pas cette action. Contactez un administrateur de l’espace.', code: 'forbidden' });
  return false;
}
/**
 * Garde globale : un compte « Lecture seule » ne peut exécuter AUCUNE méthode d'écriture.
 * (Filet de sécurité indépendant des contrôles par route.)
 */
function readOnlyGuard(req, res, next) {
  // Exception unique : changer SON PROPRE mot de passe (ne touche aucune donnée de l'espace).
  if (req.user && req.user.role === 'lecture' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/me/password')
    return res.status(403).json({ error: 'Votre accès est en lecture seule : aucune donnée ne peut être modifiée.', code: 'read_only' });
  next();
}
function publicMatrix() {
  const out = {};
  for (const [a, row] of Object.entries(MATRIX)) out[a] = { admin: row[0], collaborateur: row[1], lecture: row[2] };
  return out;
}

module.exports = { ROLES, MATRIX, can, guard, readOnlyGuard, isRole, publicMatrix };
