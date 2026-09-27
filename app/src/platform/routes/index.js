'use strict';
/** Modules de routes de la console (chacun reçoit le routeur /api/platform, déjà protégé par la session). */
module.exports = [require('./workspaces'), require('./users'), require('./security'), require('./activity')];
